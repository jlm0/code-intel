import { dirname, join } from "node:path";

import { normalizeRelativePath } from "../core/ids.js";
import type { CodeEdge, CodeNode } from "../schema/schemas.js";
import type { FileFact } from "./fact-cache.js";

type AddEdge = (
  kind: CodeEdge["kind"],
  fromId: string,
  toId: string,
  workspace: string,
  repo: string,
  metadata?: Record<string, unknown>,
) => void;

export interface ApplyTestLinkingGraphFactsInput {
  workspaceName: string;
  repo: {
    name: string;
  };
  nodes: Map<string, CodeNode>;
  edges: Map<string, CodeEdge>;
  fileNodes: Map<string, CodeNode>;
  astSymbolsByFile: Map<string, CodeNode[]>;
  fileFactsByRelativePath: Map<string, FileFact>;
  addEdge: AddEdge;
}

interface TestCaseEvidence {
  name: string;
  title: string;
  range: FileFact["testCases"][number]["range"];
  callee: FileFact["testCases"][number]["callee"];
}

interface TraversalStep {
  fromId: string;
  toId: string;
  kind: CodeEdge["kind"];
  evidenceSources: string[];
  confidence?: string;
  ownerFile?: string;
  fallbackReason?: string;
}

const indirectAllowedEdgeKinds = new Set<CodeEdge["kind"]>(["CALLS", "REFERENCES", "IMPORTS", "EXPORTS"]);

export function applyTestLinkingGraphFacts(input: ApplyTestLinkingGraphFactsInput): void {
  addMockDerivedTestEdges(input);
  addSnapshotDerivedTestEdges(input);
  normalizeDirectTestEdges(input);
  addColocatedFallbackEdges(input);
  addIndirectTestEdges(input);
}

function addMockDerivedTestEdges(input: ApplyTestLinkingGraphFactsInput): void {
  for (const [testFile, fileFact] of input.fileFactsByRelativePath) {
    if (fileKindForPath(testFile) !== "test") {
      continue;
    }
    const mockCalls = fileFact.calls.filter((call) =>
      call.propertyName === "mock" &&
      (call.receiver === "vi" || call.receiver === "jest") &&
      call.argumentSpecifier
    );
    for (const call of mockCalls) {
      const targetFile = resolveMockTargetFile(testFile, call.argumentSpecifier!, input);
      if (!targetFile) {
        continue;
      }
      const targetFileNode = input.fileNodes.get(targetFile);
      if (targetFileNode) {
        addEvidenceTestEdges(input, testFile, targetFileNode, mockTestMetadata(input.repo.name, testFile, call, targetFile));
      }
      for (const target of implementationSymbolsForFile(input, targetFile)) {
        addEvidenceTestEdges(input, testFile, target, mockTestMetadata(input.repo.name, testFile, call, targetFile));
      }
    }
  }
}

function addSnapshotDerivedTestEdges(input: ApplyTestLinkingGraphFactsInput): void {
  for (const [testFile, fileFact] of input.fileFactsByRelativePath) {
    if (fileKindForPath(testFile) !== "test" || !hasSnapshotAssertion(fileFact)) {
      continue;
    }
    for (const importFact of fileFact.imports) {
      if (!importFact.localName || importFact.importKind === "type") {
        continue;
      }
      const targetFile = importFact.moduleSpecifier.startsWith(".")
        ? resolveRelativeFile(testFile, importFact.moduleSpecifier, input.fileNodes)
        : undefined;
      if (!targetFile) {
        continue;
      }
      const targetFileNode = input.fileNodes.get(targetFile);
      if (targetFileNode) {
        addEvidenceTestEdges(input, testFile, targetFileNode, snapshotTestMetadata(input.repo.name, testFile, fileFact));
      }
      for (const target of importedImplementationSymbols(input, targetFile, importFact)) {
        addEvidenceTestEdges(input, testFile, target, snapshotTestMetadata(input.repo.name, testFile, fileFact));
      }
    }
  }
}

function addEvidenceTestEdges(
  input: ApplyTestLinkingGraphFactsInput,
  testFile: string,
  target: CodeNode,
  metadata: Record<string, unknown>,
): void {
  const fileNode = input.fileNodes.get(testFile);
  if (fileNode) {
    input.addEdge("TESTS", fileNode.id, target.id, input.workspaceName, input.repo.name, metadata);
  }
  for (const testNode of testNodesForFile(input, testFile)) {
    input.addEdge("TESTS", testNode.id, target.id, input.workspaceName, input.repo.name, {
      ...metadata,
      testNodeId: testNode.id,
    });
  }
}

function normalizeDirectTestEdges(input: ApplyTestLinkingGraphFactsInput): void {
  const existingTestEdges = [...input.edges.values()].filter((edge) => edge.kind === "TESTS");
  for (const edge of existingTestEdges) {
    const fromNode = input.nodes.get(edge.fromId);
    const toNode = input.nodes.get(edge.toId);
    if (!fromNode || !toNode || !fromNode.file || fileKindForPath(fromNode.file) !== "test") {
      continue;
    }
    const fileFact = input.fileFactsByRelativePath.get(fromNode.file);
    if (!fileFact) {
      continue;
    }
    const testNodes = testNodesForEdge(input, fromNode);
    const testCase = testCaseForEdge(fileFact, fromNode, edge.metadata, input.nodes);
    const metadata = directTestMetadata(input.repo.name, fileFact.fingerprint.relativePath, edge.metadata, testCase);
    input.addEdge("TESTS", edge.fromId, edge.toId, input.workspaceName, input.repo.name, metadata);
    for (const testNode of testNodes) {
      input.addEdge("TESTS", testNode.id, edge.toId, input.workspaceName, input.repo.name, {
        ...metadata,
        testNodeId: testNode.id,
      });
    }
  }
}

function addColocatedFallbackEdges(input: ApplyTestLinkingGraphFactsInput): void {
  for (const [testFile, fileFact] of input.fileFactsByRelativePath) {
    if (fileKindForPath(testFile) !== "test" || fileFact.testCases.length === 0) {
      continue;
    }
    const sourceFile = colocatedSourceFile(testFile, input.fileNodes);
    if (!sourceFile) {
      continue;
    }
    const testFileNode = input.fileNodes.get(testFile);
    const sourceFileNode = input.fileNodes.get(sourceFile);
    if (!testFileNode || !sourceFileNode) {
      continue;
    }
    if (hasDirectTestLinkIntoSourceFile(input, testFile, sourceFile)) {
      continue;
    }
    const metadata = fallbackTestMetadata(input.repo.name, testFile, fileFact.testCases[0]);
    input.addEdge("TESTS", testFileNode.id, sourceFileNode.id, input.workspaceName, input.repo.name, metadata);
    for (const testNode of testNodesForFile(input, testFile)) {
      const testCase = testCaseForNode(fileFact, testNode) ?? fileFact.testCases[0];
      input.addEdge("TESTS", testNode.id, sourceFileNode.id, input.workspaceName, input.repo.name, {
        ...fallbackTestMetadata(input.repo.name, testFile, testCase),
        testNodeId: testNode.id,
      });
    }
  }
}

function hasDirectTestLinkIntoSourceFile(
  input: ApplyTestLinkingGraphFactsInput,
  testFile: string,
  sourceFile: string,
): boolean {
  const testNodeIds = new Set([
    input.fileNodes.get(testFile)?.id,
    ...testNodesForFile(input, testFile).map((node) => node.id),
  ].filter((id): id is string => Boolean(id)));
  for (const edge of input.edges.values()) {
    if (edge.kind !== "TESTS" || !testNodeIds.has(edge.fromId)) {
      continue;
    }
    if (stringFromMetadata(edge.metadata, "testLinkKind") === "colocated-fallback") {
      continue;
    }
    const target = input.nodes.get(edge.toId);
    if (target?.file === sourceFile) {
      return true;
    }
  }
  return false;
}

function addIndirectTestEdges(input: ApplyTestLinkingGraphFactsInput): void {
  const directEdges = [...input.edges.values()].filter((edge) =>
    edge.kind === "TESTS" &&
    stringFromMetadata(edge.metadata, "testLinkKind") !== "indirect" &&
    stringFromMetadata(edge.metadata, "testLinkKind") !== "colocated-fallback"
  );
  for (const edge of directEdges) {
    const fromNode = input.nodes.get(edge.fromId);
    const directTarget = input.nodes.get(edge.toId);
    if (!fromNode || !directTarget || !fromNode.file || fileKindForPath(fromNode.file) !== "test") {
      continue;
    }
    const fileFact = input.fileFactsByRelativePath.get(fromNode.file);
    if (!fileFact) {
      continue;
    }
    const testCase = testCaseForEdge(fileFact, fromNode, edge.metadata, input.nodes);
    const reachable = indirectCoverageTargets(input, directTarget.id);
    for (const target of reachable) {
      if (target.node.id === directTarget.id || target.node.file === fromNode.file) {
        continue;
      }
      const metadata = indirectTestMetadata(
        input.repo.name,
        fromNode.file,
        directMetadataWithMockEvidence(input, fileFact, fromNode.file, edge.metadata, target.node),
        target.path,
        testCase,
        directTarget.id,
      );
      input.addEdge("TESTS", edge.fromId, target.node.id, input.workspaceName, input.repo.name, metadata);
    }
  }
}

function testNodesForEdge(input: ApplyTestLinkingGraphFactsInput, fromNode: CodeNode): CodeNode[] {
  if (fromNode.kind === "Test") {
    return [fromNode];
  }
  const symbolId = stringFromMetadata(fromNode.metadata, "symbolId");
  const symbolNode = symbolId ? input.nodes.get(symbolId) : undefined;
  if (symbolNode?.kind === "Test") {
    return [symbolNode];
  }
  if (fromNode.kind === "File" && fromNode.file) {
    return testNodesForFile(input, fromNode.file);
  }
  return [];
}

function testNodesForFile(input: ApplyTestLinkingGraphFactsInput, relativePath: string): CodeNode[] {
  return (input.astSymbolsByFile.get(relativePath) ?? [])
    .filter((node) => node.kind === "Test")
    .sort((left, right) => rangeStart(left) - rangeStart(right) || (left.name ?? "").localeCompare(right.name ?? ""));
}

function testCaseForEdge(
  fileFact: FileFact,
  fromNode: CodeNode,
  metadata: Record<string, unknown>,
  nodes: Map<string, CodeNode>,
): TestCaseEvidence | undefined {
  const symbolId = stringFromMetadata(fromNode.metadata, "symbolId");
  const symbolNode = symbolId ? nodes.get(symbolId) : undefined;
  return testCaseForNode(fileFact, fromNode)
    ?? (symbolNode ? testCaseForNode(fileFact, symbolNode) : undefined)
    ?? testCaseForRange(fileFact, rangeFromUnknown(metadata.scipRange))
    ?? testCaseForRange(fileFact, rangeFromUnknown(metadata.range))
    ?? (fileFact.testCases.length === 1 ? fileFact.testCases[0] : undefined);
}

function testCaseForNode(fileFact: FileFact, node: CodeNode): TestCaseEvidence | undefined {
  if (!node.range) {
    return undefined;
  }
  return bestTestCase(
    fileFact.testCases.filter((testCase) =>
      testCase.name === node.name || rangeContains(testCase.range, node.range!) || rangesOverlap(testCase.range, node.range!),
    ),
    node.name,
    node.range,
  );
}

function testCaseForRange(fileFact: FileFact, range: CodeNode["range"] | undefined): TestCaseEvidence | undefined {
  if (!range) {
    return undefined;
  }
  return bestTestCase(
    fileFact.testCases.filter((testCase) => rangeContains(testCase.range, range) || rangesOverlap(testCase.range, range)),
    undefined,
    range,
  );
}

function bestTestCase(
  candidates: TestCaseEvidence[],
  preferredName: string | undefined,
  preferredRange: CodeNode["range"] | undefined,
): TestCaseEvidence | undefined {
  return [...candidates].sort((left, right) =>
    exactNameRank(left, preferredName) - exactNameRank(right, preferredName) ||
    testKindRank(left) - testKindRank(right) ||
    containingRangeRank(left, preferredRange) - containingRangeRank(right, preferredRange) ||
    rangeSize(left.range) - rangeSize(right.range) ||
    left.name.localeCompare(right.name),
  )[0];
}

function exactNameRank(testCase: TestCaseEvidence, preferredName: string | undefined): number {
  return preferredName && testCase.name === preferredName ? 0 : 1;
}

function testKindRank(testCase: TestCaseEvidence): number {
  return testCase.name.startsWith("it ") || testCase.name.startsWith("test ") ? 0 : 1;
}

function containingRangeRank(testCase: TestCaseEvidence, preferredRange: CodeNode["range"] | undefined): number {
  return preferredRange && rangeContains(testCase.range, preferredRange) ? 0 : 1;
}

function rangeSize(range: { startLine: number; endLine: number; startColumn?: number; endColumn?: number }): number {
  return (range.endLine - range.startLine) * 10_000 + ((range.endColumn ?? 0) - (range.startColumn ?? 0));
}

function directTestMetadata(
  repo: string,
  testFile: string,
  metadata: Record<string, unknown>,
  testCase: TestCaseEvidence | undefined,
): Record<string, unknown> {
  const linkKind = metadataArrayIncludes(metadata.roles, "Call")
    ? "direct-call"
    : metadataArrayIncludes(metadata.roles, "Import")
      ? "direct-import"
      : "direct-reference";
  return addTestCaseMetadata({
    ...metadata,
    ownerRepo: repo,
    ownerFile: testFile,
    testOwnerFile: testFile,
    testContext: true,
    testLinkKind: linkKind,
    evidenceSources: mergeStringArrays(metadata.evidenceSources, "tree-sitter-test"),
    roles: mergeStringArrays(metadata.roles, "Test"),
    confidence: metadata.confidence ?? (linkKind === "direct-import" ? "medium" : "high"),
  }, testCase);
}

function fallbackTestMetadata(repo: string, testFile: string, testCase: TestCaseEvidence | undefined): Record<string, unknown> {
  return addTestCaseMetadata({
    ownerRepo: repo,
    ownerFile: testFile,
    testOwnerFile: testFile,
    origin: "test-linking-colocated-fallback",
    source: "test-linking",
    testContext: true,
    testLinkKind: "colocated-fallback",
    confidence: "fallback",
    evidenceSources: ["colocated-test-name", "tree-sitter-test"],
    roles: ["Test"],
    fallbackReason: "colocated-test-source-name",
  }, testCase);
}

function indirectTestMetadata(
  repo: string,
  testFile: string,
  directMetadata: Record<string, unknown>,
  traversalPath: TraversalStep[],
  testCase: TestCaseEvidence | undefined,
  directTargetId: string,
): Record<string, unknown> {
  const traversalEvidence = traversalPath.flatMap((step) => step.evidenceSources);
  return addTestCaseMetadata({
    ownerRepo: repo,
    ownerFile: testFile,
    testOwnerFile: testFile,
    origin: "test-linking-indirect",
    source: "test-linking",
    testContext: true,
    testLinkKind: "indirect",
    confidence: "medium",
    evidenceSources: mergeStringArrays(
      mergeStringArrays(directMetadata.evidenceSources, traversalEvidence),
      ["test-linking-indirect", "tree-sitter-test"],
    ),
    roles: mergeStringArrays(directMetadata.roles, "Test"),
    directTargetId,
    traversalPath,
  }, testCase);
}

function addTestCaseMetadata(
  metadata: Record<string, unknown>,
  testCase: TestCaseEvidence | undefined,
): Record<string, unknown> {
  if (!testCase) {
    return metadata;
  }
  return {
    ...metadata,
    testCaseName: testCase.name,
    testCaseTitle: testCase.title,
    testCaseRange: testCase.range,
    testCallee: testCase.callee,
    range: metadata.range ?? testCase.range,
  };
}

function indirectCoverageTargets(
  input: ApplyTestLinkingGraphFactsInput,
  startId: string,
): Array<{ node: CodeNode; path: TraversalStep[] }> {
  const results = new Map<string, { node: CodeNode; path: TraversalStep[] }>();
  const queue = initialIndirectQueue(input, startId);
  const seen = new Set<string>(queue.map((item) => item.nodeId));
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.path.length >= 3) {
      continue;
    }
    for (const edge of outgoingEdges(input, current.nodeId)) {
      if (!indirectAllowedEdgeKinds.has(edge.kind)) {
        continue;
      }
      const target = input.nodes.get(edge.toId);
      if (!target || seen.has(target.id) || shouldSkipIndirectTarget(target)) {
        continue;
      }
      const step = traversalStep(edge);
      const nextPath = [...current.path, step];
      const hasCall = current.hasCall || edge.kind === "CALLS";
      if (hasCall && isImplementationTarget(target)) {
        results.set(target.id, { node: target, path: nextPath });
      }
      seen.add(target.id);
      if (!shouldStopIndirectTraversal(target)) {
        queue.push({ nodeId: target.id, path: nextPath, hasCall });
      }
    }
  }
  return [...results.values()].sort((left, right) =>
    left.path.length - right.path.length ||
    (left.node.file ?? "").localeCompare(right.node.file ?? "") ||
    (left.node.name ?? "").localeCompare(right.node.name ?? ""),
  ).slice(0, 50);
}

function initialIndirectQueue(
  input: ApplyTestLinkingGraphFactsInput,
  startId: string,
): Array<{ nodeId: string; path: TraversalStep[]; hasCall: boolean }> {
  const queue: Array<{ nodeId: string; path: TraversalStep[]; hasCall: boolean }> = [
    { nodeId: startId, path: [], hasCall: false },
  ];
  const startNode = input.nodes.get(startId);
  if (!startNode?.file || startNode.kind === "File" || startNode.metadata.fileKind !== "source") {
    return queue;
  }
  const fileNode = input.fileNodes.get(startNode.file);
  if (!fileNode || fileNode.id === startId || fileNode.metadata.fileKind !== "source") {
    return queue;
  }
  queue.push({
    nodeId: fileNode.id,
    path: [{
      fromId: startId,
      toId: fileNode.id,
      kind: "REFERENCES",
      evidenceSources: ["test-linking-same-file"],
      confidence: "medium",
      ownerFile: startNode.file,
    }],
    hasCall: false,
  });
  return queue;
}

function outgoingEdges(input: ApplyTestLinkingGraphFactsInput, nodeId: string): CodeEdge[] {
  return [...input.edges.values()]
    .filter((edge) => edge.fromId === nodeId)
    .sort((left, right) => edgeRank(left) - edgeRank(right) || left.id.localeCompare(right.id));
}

function edgeRank(edge: CodeEdge): number {
  switch (edge.kind) {
    case "CALLS":
      return 0;
    case "REFERENCES":
      return 1;
    case "IMPORTS":
      return 2;
    case "EXPORTS":
      return 3;
    default:
      return 4;
  }
}

function traversalStep(edge: CodeEdge): TraversalStep {
  return {
    fromId: edge.fromId,
    toId: edge.toId,
    kind: edge.kind,
    evidenceSources: evidenceSources(edge.metadata),
    confidence: stringFromMetadata(edge.metadata, "confidence"),
    ownerFile: stringFromMetadata(edge.metadata, "ownerFile"),
    fallbackReason: stringFromMetadata(edge.metadata, "fallbackReason"),
  };
}

function shouldSkipIndirectTarget(node: CodeNode): boolean {
  return node.kind === "Package" || node.kind === "Import" || node.kind === "Export" || node.metadata.fileKind === "test";
}

function shouldStopIndirectTraversal(node: CodeNode): boolean {
  return node.kind === "File" || node.kind === "Chunk" || node.metadata.fileKind === "test";
}

function isImplementationTarget(node: CodeNode): boolean {
  return (
    node.metadata.fileKind === "source" &&
    (node.kind === "Function" || node.kind === "Class" || node.kind === "Symbol" || node.kind === "File")
  );
}

function colocatedSourceFile(testFile: string, fileNodes: Map<string, CodeNode>): string | undefined {
  const candidates = colocatedSourceCandidates(testFile);
  return candidates.find((candidate) => {
    const node = fileNodes.get(candidate);
    return node?.metadata.fileKind === "source";
  });
}

function colocatedSourceCandidates(testFile: string): string[] {
  const direct = testFile.replace(/\.(test|spec)(\.[cm]?[jt]sx?)$/, "$2");
  const candidates = [direct];
  const testFolderMatch = testFile.match(/^(.*\/)__tests__\/(.+)\.(test|spec)(\.[cm]?[jt]sx?)$/);
  if (testFolderMatch) {
    candidates.push(`${testFolderMatch[1]}/${testFolderMatch[2]}${testFolderMatch[4]}`);
  }
  return [...new Set(candidates)].filter((candidate) => candidate !== testFile);
}

function implementationSymbolsForFile(input: ApplyTestLinkingGraphFactsInput, relativePath: string): CodeNode[] {
  return (input.astSymbolsByFile.get(relativePath) ?? [])
    .filter((node) => node.metadata.fileKind === "source" && ["Function", "Class", "Symbol"].includes(node.kind))
    .sort((left, right) => symbolRank(left) - symbolRank(right) || (left.name ?? "").localeCompare(right.name ?? ""));
}

function importedImplementationSymbols(
  input: ApplyTestLinkingGraphFactsInput,
  relativePath: string,
  importFact: FileFact["imports"][number],
): CodeNode[] {
  const symbols = implementationSymbolsForFile(input, relativePath);
  if (importFact.isNamespace) {
    return symbols;
  }
  const importedName = importFact.importedName === "default"
    ? "default"
    : (importFact.importedName ?? importFact.localName);
  const direct = symbols.filter((symbol) =>
    symbol.name === importedName ||
    symbol.name === importFact.localName ||
    stringFromMetadata(symbol.metadata, "qualifiedName") === importedName ||
    stringFromMetadata(symbol.metadata, "qualifiedName") === importFact.localName
  );
  return direct.length > 0 ? direct : symbols;
}

function hasSnapshotAssertion(fileFact: FileFact): boolean {
  return fileFact.calls.some((call) =>
    call.propertyName === "toMatchSnapshot" ||
    call.propertyName === "toMatchInlineSnapshot" ||
    call.name === "toMatchSnapshot" ||
    call.name === "toMatchInlineSnapshot"
  );
}

function mockTestMetadata(
  repo: string,
  testFile: string,
  call: FileFact["calls"][number],
  targetFile: string,
): Record<string, unknown> {
  return {
    ownerRepo: repo,
    ownerFile: testFile,
    testOwnerFile: testFile,
    origin: "test-linking-mock",
    source: "test-linking",
    testContext: true,
    testLinkKind: "mock",
    confidence: "medium",
    evidenceSources: ["mock", "tree-sitter-test"],
    roles: ["Test"],
    range: call.range,
    moduleSpecifier: call.argumentSpecifier,
    targetFile,
  };
}

function snapshotTestMetadata(repo: string, testFile: string, fileFact: FileFact): Record<string, unknown> {
  const snapshotCall = fileFact.calls.find((call) =>
    call.propertyName === "toMatchSnapshot" ||
    call.propertyName === "toMatchInlineSnapshot" ||
    call.name === "toMatchSnapshot" ||
    call.name === "toMatchInlineSnapshot"
  );
  return {
    ownerRepo: repo,
    ownerFile: testFile,
    testOwnerFile: testFile,
    origin: "test-linking-snapshot",
    source: "test-linking",
    testContext: true,
    testLinkKind: "snapshot",
    confidence: "high",
    evidenceSources: ["snapshot", "tree-sitter-test"],
    roles: ["Test"],
    range: snapshotCall?.range,
  };
}

function resolveRelativeFile(
  importerFile: string,
  moduleSpecifier: string,
  fileNodes: Map<string, CodeNode>,
): string | undefined {
  const base = normalizeRelativePath(join(dirname(importerFile), moduleSpecifier));
  const extensions = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
  for (const extension of extensions) {
    const candidate = `${base}${extension}`;
    if (fileNodes.has(candidate)) return candidate;
  }
  for (const extension of extensions.slice(1)) {
    const candidate = `${base}/index${extension}`;
    if (fileNodes.has(candidate)) return candidate;
  }
  return undefined;
}

function resolveMockTargetFile(
  importerFile: string,
  moduleSpecifier: string,
  input: ApplyTestLinkingGraphFactsInput,
): string | undefined {
  if (moduleSpecifier.startsWith(".")) {
    return resolveRelativeFile(importerFile, moduleSpecifier, input.fileNodes);
  }
  return resolvePackageSpecifierFile(moduleSpecifier, input.fileNodes);
}

function resolvePackageSpecifierFile(
  moduleSpecifier: string,
  fileNodes: Map<string, CodeNode>,
): string | undefined {
  const fileEntries = [...fileNodes.entries()]
    .filter(([, node]) => node.metadata.fileKind === "source")
    .sort(([left], [right]) => left.localeCompare(right));
  const packageNames = [...new Set(
    fileEntries
      .map(([, node]) => node.packageName)
      .filter((packageName): packageName is string => Boolean(packageName)),
  )].sort((left, right) => right.length - left.length);
  const packageName = packageNames.find((candidate) =>
    moduleSpecifier === candidate || moduleSpecifier.startsWith(`${candidate}/`)
  );
  if (!packageName) {
    return undefined;
  }
  const subpath = moduleSpecifier.slice(packageName.length).replace(/^\//, "");
  const packageFiles = fileEntries.filter(([, node]) => node.packageName === packageName);
  return bestPackageSpecifierMatch(packageFiles.map(([file]) => file), subpath);
}

function bestPackageSpecifierMatch(files: string[], subpath: string): string | undefined {
  const normalizedSubpath = subpath.replace(/^src\//, "").replace(/\/$/, "");
  const stems = normalizedSubpath.length > 0
    ? [
        `src/${normalizedSubpath}`,
        normalizedSubpath,
        `src/${normalizedSubpath}/index`,
        `${normalizedSubpath}/index`,
      ]
    : ["src/index", "index", "src/client", "client"];
  for (const stem of stems) {
    const match = files.find((file) => {
      const currentStem = fileStem(file);
      return currentStem === stem || currentStem.endsWith(`/${stem}`);
    });
    if (match) return match;
  }
  return undefined;
}

function fileStem(file: string): string {
  return file.replace(/\.[cm]?[jt]sx?$/, "");
}

function directMetadataWithMockEvidence(
  input: ApplyTestLinkingGraphFactsInput,
  fileFact: FileFact,
  testFile: string,
  metadata: Record<string, unknown>,
  target: CodeNode,
): Record<string, unknown> {
  if (!target.file) {
    return metadata;
  }
  const mockCall = fileFact.calls.find((call) =>
    call.propertyName === "mock" &&
    (call.receiver === "vi" || call.receiver === "jest") &&
    call.argumentSpecifier &&
    resolveMockTargetFile(testFile, call.argumentSpecifier, input) === target.file
  );
  if (!mockCall) {
    return metadata;
  }
  return {
    ...metadata,
    evidenceSources: mergeStringArrays(metadata.evidenceSources, "mock"),
    roles: mergeStringArrays(metadata.roles, "Test"),
    mockModuleSpecifier: mockCall.argumentSpecifier,
    mockRange: mockCall.range,
    mockTargetFile: target.file,
  };
}

function symbolRank(node: CodeNode): number {
  if (node.metadata.exported === true) return 0;
  if (node.kind === "Function" || node.kind === "Class") return 1;
  return 2;
}

function rangeStart(node: CodeNode): number {
  return (node.range?.startLine ?? Number.MAX_SAFE_INTEGER) * 10_000 + (node.range?.startColumn ?? 0);
}

function rangeFromUnknown(value: unknown): CodeNode["range"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const range = value as Record<string, unknown>;
  return typeof range.startLine === "number" && typeof range.endLine === "number"
    ? {
        startLine: range.startLine,
        endLine: range.endLine,
        startColumn: typeof range.startColumn === "number" ? range.startColumn : 0,
        endColumn: typeof range.endColumn === "number" ? range.endColumn : 0,
      }
    : undefined;
}

function rangeContains(
  outer: { startLine: number; endLine: number; startColumn?: number; endColumn?: number },
  inner: { startLine: number; endLine: number; startColumn?: number; endColumn?: number },
): boolean {
  const outerStartColumn = outer.startColumn ?? 0;
  const innerStartColumn = inner.startColumn ?? 0;
  const outerEndColumn = outer.endColumn ?? Number.MAX_SAFE_INTEGER;
  const innerEndColumn = inner.endColumn ?? 0;
  const startsAfterOuter =
    inner.startLine > outer.startLine ||
    (inner.startLine === outer.startLine && innerStartColumn >= outerStartColumn);
  const endsBeforeOuter =
    inner.endLine < outer.endLine ||
    (inner.endLine === outer.endLine && innerEndColumn <= outerEndColumn);
  return startsAfterOuter && endsBeforeOuter;
}

function rangesOverlap(
  left: { startLine: number; endLine: number },
  right: { startLine: number; endLine: number },
): boolean {
  return left.startLine <= right.endLine && right.startLine <= left.endLine;
}

function evidenceSources(metadata: Record<string, unknown>): string[] {
  return mergeStringArrays(metadata.evidenceSources, stringFromMetadata(metadata, "origin"));
}

function mergeStringArrays(left: unknown, right: unknown): string[] {
  return [...new Set([...toStringArray(left), ...toStringArray(right)])].sort();
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }
  return typeof value === "string" && value.length > 0 ? [value] : [];
}

function metadataArrayIncludes(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.includes(expected);
}

function stringFromMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function fileKindForPath(relativePath: string): string {
  return /(^|\/)(__tests__|tests?)\//.test(relativePath) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath)
    ? "test"
    : "source";
}
