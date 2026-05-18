import { createStableId } from "../core/ids.js";
import type { CodeEdge, CodeNode } from "../schema/schemas.js";
import type { FileFact } from "./fact-cache.js";
import type { RepoResolvedModuleFacts, ResolvedExportFact, ResolvedImportFact } from "./module-resolution.js";

type AddEdge = (
  kind: CodeEdge["kind"],
  fromId: string,
  toId: string,
  workspace: string,
  repo: string,
  metadata?: Record<string, unknown>,
) => void;

export interface ApplyResolvedModuleGraphFactsInput {
  workspaceName: string;
  repo: {
    name: string;
    commit: string;
  };
  facts: RepoResolvedModuleFacts;
  fileNodes: Map<string, CodeNode>;
  packageNodes: Map<string, CodeNode>;
  fileChunks: Map<string, Array<CodeNode & { sourceCalls: string[] }>>;
  astSymbolsByFile: Map<string, CodeNode[]>;
  scipSymbolNodes?: Map<string, CodeNode>;
  fileFactsByRelativePath: Map<string, FileFact>;
  addEdge: AddEdge;
}

export function applyResolvedModuleGraphFacts(input: ApplyResolvedModuleGraphFactsInput): void {
  const nodesById = createNodeIdIndex(input);
  const exportsByFileAndName = createExportsByFileAndName(input.facts.exports);

  for (const packageExport of input.facts.packageExports) {
    if (packageExport.status !== "resolved" || !packageExport.targetFile) {
      continue;
    }
    const packageNode = input.packageNodes.get(packageExport.packageName);
    const targetFileNode = input.fileNodes.get(packageExport.targetFile);
    if (!packageNode || !targetFileNode) {
      continue;
    }
    input.addEdge("EXPORTS", packageNode.id, targetFileNode.id, input.workspaceName, input.repo.name, {
      ownerRepo: input.repo.name,
      origin: "module-resolution",
      source: "module-resolution",
      evidenceSources: ["package-json", "module-resolution", "package-boundary"],
      confidence: "high",
      relationship: "package-boundary",
      relationshipTags: ["package-boundary"],
      packageName: packageExport.packageName,
      exportName: packageExport.exportName,
      targetFile: packageExport.targetFile,
      targetPackageExport: packageExport.targetPackageExport,
      resolutionSource: packageExport.resolutionSource,
      fallbackReason: packageExport.fallbackReason,
    });
  }

  for (const exportFact of input.facts.exports) {
    applyResolvedExportGraphFact(input, nodesById, exportFact);
  }

  for (const importFact of input.facts.imports) {
    applyResolvedImportGraphFact(input, nodesById, exportsByFileAndName, importFact);
  }
}

function applyResolvedExportGraphFact(
  input: ApplyResolvedModuleGraphFactsInput,
  nodesById: Map<string, CodeNode>,
  exportFact: ResolvedExportFact,
): void {
  if (exportFact.status !== "resolved") {
    return;
  }
  const fileNode = input.fileNodes.get(exportFact.exporterFile);
  const exportNode = exportNodeFor(input, exportFact);
  const targetFile = exportFact.targetFile ? input.fileNodes.get(exportFact.targetFile) : undefined;
  const targetSymbol = exportFact.targetSymbolId ? nodesById.get(exportFact.targetSymbolId) : undefined;
  const metadata = exportMetadata(input.repo.name, exportFact, targetSymbol);
  if (fileNode && targetFile && targetFile.id !== fileNode.id) {
    input.addEdge("EXPORTS", fileNode.id, targetFile.id, input.workspaceName, input.repo.name, metadata);
  }
  if (fileNode && targetSymbol) {
    input.addEdge("EXPORTS", fileNode.id, targetSymbol.id, input.workspaceName, input.repo.name, metadata);
  }
  if (exportNode && targetFile && exportNode.id !== targetFile.id) {
    input.addEdge("EXPORTS", exportNode.id, targetFile.id, input.workspaceName, input.repo.name, metadata);
  }
  if (exportNode && targetSymbol) {
    input.addEdge("EXPORTS", exportNode.id, targetSymbol.id, input.workspaceName, input.repo.name, metadata);
  }
}

function applyResolvedImportGraphFact(
  input: ApplyResolvedModuleGraphFactsInput,
  nodesById: Map<string, CodeNode>,
  exportsByFileAndName: Map<string, ResolvedExportFact>,
  importFact: ResolvedImportFact,
): void {
  if (importFact.status !== "resolved") {
    return;
  }
  const fileNode = input.fileNodes.get(importFact.importerFile);
  const importNode = importNodeFor(input, importFact);
  const targetFile = importFact.targetFile ? input.fileNodes.get(importFact.targetFile) : undefined;
  const targetPackage = importFact.targetPackage ? input.packageNodes.get(importFact.targetPackage) : undefined;
  const directTargetSymbol = importFact.targetSymbolId ? nodesById.get(importFact.targetSymbolId) : undefined;
  const metadata = importMetadata(input.repo.name, importFact, directTargetSymbol, fileNode?.packageName);

  for (const target of [targetPackage, targetFile, directTargetSymbol]) {
    if (!target) {
      continue;
    }
    if (fileNode) {
      input.addEdge("IMPORTS", fileNode.id, target.id, input.workspaceName, input.repo.name, metadata);
    }
    if (importNode) {
      input.addEdge("IMPORTS", importNode.id, target.id, input.workspaceName, input.repo.name, metadata);
    }
  }

  if (fileNode && directTargetSymbol) {
    input.addEdge("REFERENCES", fileNode.id, directTargetSymbol.id, input.workspaceName, input.repo.name, metadata);
  }

  const fileFact = input.fileFactsByRelativePath.get(importFact.importerFile);
  if (!fileFact) {
    return;
  }

  for (const target of callTargetsForImport(input, nodesById, exportsByFileAndName, importFact, directTargetSymbol)) {
    const callMetadata = importMetadata(input.repo.name, importFact, target, fileNode?.packageName);
    const matchingCalls = callsMatchingImport(input, importFact, target);
    const callingChunks = chunksCallingImport(input, importFact, target);
    const fileContainsCall = matchingCalls.length > 0;
    const usageMetadata = callUsageMetadata(callMetadata, matchingCalls[0]);
    const fileIsTest = fileKindForPath(importFact.importerFile) === "test";
    if (fileNode && fileContainsCall) {
      input.addEdge("REFERENCES", fileNode.id, target.id, input.workspaceName, input.repo.name, usageMetadata);
      input.addEdge("CALLS", fileNode.id, target.id, input.workspaceName, input.repo.name, usageMetadata);
    }
    if (fileNode && fileIsTest) {
      input.addEdge("TESTS", fileNode.id, target.id, input.workspaceName, input.repo.name, testMetadata(callMetadata));
    }
    for (const chunk of callingChunks) {
      input.addEdge("REFERENCES", chunk.id, target.id, input.workspaceName, input.repo.name, usageMetadata);
      input.addEdge("MENTIONS", chunk.id, target.id, input.workspaceName, input.repo.name, usageMetadata);
      input.addEdge("CALLS", chunk.id, target.id, input.workspaceName, input.repo.name, usageMetadata);
      if (chunk.kind === "Test" || fileIsTest) {
        input.addEdge("TESTS", chunk.id, target.id, input.workspaceName, input.repo.name, testMetadata(usageMetadata));
      }
      const sourceSymbolId = String(chunk.metadata.symbolId ?? "");
      if (sourceSymbolId && sourceSymbolId !== target.id) {
        input.addEdge("CALLS", sourceSymbolId, target.id, input.workspaceName, input.repo.name, usageMetadata);
      }
    }
    for (const sourceSymbol of symbolsCallingImport(input, importFact, target)) {
      if (sourceSymbol.id !== target.id) {
        input.addEdge("CALLS", sourceSymbol.id, target.id, input.workspaceName, input.repo.name, usageMetadata);
      }
    }
  }

  for (const target of propertyTargetsForImport(input, importFact, directTargetSymbol)) {
    const matchedAccesses = memberAccessesMatchingImport(input, importFact, target);
    if (matchedAccesses.length === 0) {
      continue;
    }
    const accessMetadata = propertyAccessMetadata(
      importMetadata(input.repo.name, importFact, target, fileNode?.packageName),
      matchedAccesses[0],
    );
    if (fileNode) {
      input.addEdge("REFERENCES", fileNode.id, target.id, input.workspaceName, input.repo.name, accessMetadata);
    }
    for (const sourceSymbol of symbolsAccessingImport(input, importFact, target)) {
      if (sourceSymbol.id !== target.id) {
        input.addEdge("REFERENCES", sourceSymbol.id, target.id, input.workspaceName, input.repo.name, accessMetadata);
      }
    }
  }
}

function callTargetsForImport(
  input: ApplyResolvedModuleGraphFactsInput,
  nodesById: Map<string, CodeNode>,
  exportsByFileAndName: Map<string, ResolvedExportFact>,
  importFact: ResolvedImportFact,
  directTargetSymbol: CodeNode | undefined,
): CodeNode[] {
  const targets = new Map<string, CodeNode>();
  if (directTargetSymbol) {
    targets.set(directTargetSymbol.id, directTargetSymbol);
  }
  if (!importFact.isNamespace || !importFact.localName || !importFact.targetFile) {
    for (const call of input.fileFactsByRelativePath.get(importFact.importerFile)?.calls ?? []) {
      const memberTarget = memberTargetForImport(input, importFact, directTargetSymbol, call);
      if (memberTarget) {
        targets.set(memberTarget.id, memberTarget);
      }
    }
    return [...targets.values()];
  }
  const fileFact = input.fileFactsByRelativePath.get(importFact.importerFile);
  for (const call of fileFact?.calls ?? []) {
    if (call.receiver !== importFact.localName && !call.memberPath?.startsWith(`${importFact.localName}.`)) {
      continue;
    }
    const exportedName = call.propertyName ?? call.name;
    const exportFact = exportsByFileAndName.get(exportKey(importFact.targetFile, exportedName));
    if (!exportFact?.targetSymbolId) {
      continue;
    }
    const target = nodesById.get(exportFact.targetSymbolId);
    if (target) {
      targets.set(target.id, target);
    }
  }
  return [...targets.values()];
}

function memberTargetForImport(
  input: ApplyResolvedModuleGraphFactsInput,
  importFact: ResolvedImportFact,
  directTargetSymbol: CodeNode | undefined,
  call: FileFact["calls"][number],
): CodeNode | undefined {
  if (!importFact.localName || !importFact.targetFile || !call.memberPath?.startsWith(`${importFact.localName}.`)) {
    return undefined;
  }
  const baseName = stringFromMetadata(directTargetSymbol?.metadata ?? {}, "qualifiedName")
    ?? directTargetSymbol?.name
    ?? importFact.importedName;
  if (!baseName) {
    return undefined;
  }
  const targetMemberPath = `${baseName}${call.memberPath.slice(importFact.localName.length)}`;
  return symbolsForFile(input, importFact.targetFile).find((symbol) =>
    stringFromMetadata(symbol.metadata, "qualifiedName") === targetMemberPath
      || (symbol.name === call.propertyName && stringFromMetadata(symbol.metadata, "qualifiedName")?.endsWith(`.${targetMemberPath.split(".").slice(1).join(".")}`))
  );
}

function propertyTargetsForImport(
  input: ApplyResolvedModuleGraphFactsInput,
  importFact: ResolvedImportFact,
  directTargetSymbol: CodeNode | undefined,
): CodeNode[] {
  const targets = new Map<string, CodeNode>();
  if (directTargetSymbol) {
    targets.set(directTargetSymbol.id, directTargetSymbol);
  }
  if (!importFact.localName || !importFact.targetFile) {
    return [...targets.values()];
  }
  for (const access of input.fileFactsByRelativePath.get(importFact.importerFile)?.memberAccesses ?? []) {
    if (!access.path.startsWith(`${importFact.localName}.`)) {
      continue;
    }
    const target = memberTargetForAccess(input, importFact, directTargetSymbol, access);
    if (target) {
      targets.set(target.id, target);
    }
  }
  return [...targets.values()];
}

function memberTargetForAccess(
  input: ApplyResolvedModuleGraphFactsInput,
  importFact: ResolvedImportFact,
  directTargetSymbol: CodeNode | undefined,
  access: FileFact["memberAccesses"][number],
): CodeNode | undefined {
  if (!importFact.localName || !importFact.targetFile) {
    return undefined;
  }
  const baseName = stringFromMetadata(directTargetSymbol?.metadata ?? {}, "qualifiedName")
    ?? directTargetSymbol?.name
    ?? importFact.importedName;
  if (!baseName) {
    return undefined;
  }
  const targetMemberPath = `${baseName}${access.path.slice(importFact.localName.length)}`;
  return symbolsForFile(input, importFact.targetFile).find((symbol) =>
    stringFromMetadata(symbol.metadata, "qualifiedName") === targetMemberPath ||
    symbol.name === access.propertyName
  );
}

function chunksCallingImport(
  input: ApplyResolvedModuleGraphFactsInput,
  importFact: ResolvedImportFact,
  target: CodeNode,
): Array<CodeNode & { sourceCalls: string[] }> {
  const fileFact = input.fileFactsByRelativePath.get(importFact.importerFile);
  return (input.fileChunks.get(importFact.importerFile) ?? []).filter((chunk) => {
    if (!chunk.range) {
      return false;
    }
    return (fileFact?.calls ?? []).some((call) => {
      if (!rangeContains(chunk.range!, call.range)) {
        return false;
      }
      return callMatchesImport(call, importFact, target);
    });
  });
}

function fileCallsImport(
  input: ApplyResolvedModuleGraphFactsInput,
  importFact: ResolvedImportFact,
  target: CodeNode,
): boolean {
  return callsMatchingImport(input, importFact, target).length > 0;
}

function callsMatchingImport(
  input: ApplyResolvedModuleGraphFactsInput,
  importFact: ResolvedImportFact,
  target: CodeNode,
): FileFact["calls"] {
  return (input.fileFactsByRelativePath.get(importFact.importerFile)?.calls ?? []).filter((call) =>
    callMatchesImport(call, importFact, target),
  );
}

function memberAccessesMatchingImport(
  input: ApplyResolvedModuleGraphFactsInput,
  importFact: ResolvedImportFact,
  target: CodeNode,
): FileFact["memberAccesses"] {
  return (input.fileFactsByRelativePath.get(importFact.importerFile)?.memberAccesses ?? [])
    .filter((access) => accessMatchesImport(access, importFact, target))
    .sort((left, right) => right.path.length - left.path.length);
}

function symbolsCallingImport(
  input: ApplyResolvedModuleGraphFactsInput,
  importFact: ResolvedImportFact,
  target: CodeNode,
): CodeNode[] {
  const fileFact = input.fileFactsByRelativePath.get(importFact.importerFile);
  if (!fileFact) {
    return [];
  }
  const symbols = input.astSymbolsByFile.get(importFact.importerFile) ?? [];
  const matched = new Map<string, CodeNode>();
  for (const call of fileFact.calls) {
    if (!callMatchesImport(call, importFact, target)) {
      continue;
    }
    const containingDeclarationName = call.containingDeclarationName;
      const symbol = containingDeclarationName
        ? symbols.find((candidate) =>
        symbolNameMatches(candidate, containingDeclarationName) &&
        candidate.range &&
        (rangeContains(candidate.range, call.range) || isRouteRegistrationCall(call))
      )
      : undefined;
    if (symbol) {
      matched.set(symbol.id, symbol);
    }
  }
  return [...matched.values()];
}

function symbolsAccessingImport(
  input: ApplyResolvedModuleGraphFactsInput,
  importFact: ResolvedImportFact,
  target: CodeNode,
): CodeNode[] {
  const fileFact = input.fileFactsByRelativePath.get(importFact.importerFile);
  if (!fileFact) {
    return [];
  }
  const symbols = input.astSymbolsByFile.get(importFact.importerFile) ?? [];
  const matched = new Map<string, CodeNode>();
  for (const access of fileFact.memberAccesses) {
    if (!accessMatchesImport(access, importFact, target)) {
      continue;
    }
    const containingDeclarationName = access.containingDeclarationName;
    const symbol = containingDeclarationName
      ? symbols.find((candidate) =>
        symbolNameMatches(candidate, containingDeclarationName) &&
        candidate.range &&
        rangeContains(candidate.range, access.range)
      )
      : undefined;
    if (symbol) {
      matched.set(symbol.id, symbol);
    }
  }
  return [...matched.values()];
}

function callMatchesImport(
  call: FileFact["calls"][number],
  importFact: ResolvedImportFact,
  target: CodeNode,
): boolean {
  const targetQualifiedName = stringFromMetadata(target.metadata, "qualifiedName");
  if (targetQualifiedName && importFact.localName && call.memberPath?.startsWith(`${importFact.localName}.`)) {
    const rewrittenMemberPath = `${targetQualifiedName.split(".")[0]}${call.memberPath.slice(importFact.localName.length)}`;
    if (rewrittenMemberPath === targetQualifiedName) {
      return true;
    }
  }
  if (importFact.isNamespace && importFact.localName) {
    return call.receiver === importFact.localName ||
      Boolean(call.receiver?.startsWith(`${importFact.localName}.`)) ||
      Boolean(call.memberPath?.startsWith(`${importFact.localName}.`));
  }
  if (
    importFact.localName &&
    isRouteRegistrationCall(call) &&
    new RegExp(`\\b${escapeRegExp(importFact.localName)}\\b`).test(call.sourceText)
  ) {
    return true;
  }
  return (
    call.name === importFact.localName ||
    call.name === importFact.importedName ||
    call.receiver === importFact.localName ||
    Boolean(importFact.localName && call.receiver?.startsWith(`${importFact.localName}.`)) ||
    Boolean(importFact.localName && call.memberPath?.startsWith(`${importFact.localName}.`)) ||
    call.propertyName === importFact.localName ||
    call.propertyName === target.name
  );
}

function isRouteRegistrationCall(call: FileFact["calls"][number]): boolean {
  return call.callKind === "member" &&
    Boolean(call.propertyName && ["all", "delete", "get", "patch", "post", "put", "route", "use"].includes(call.propertyName));
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function accessMatchesImport(
  access: FileFact["memberAccesses"][number],
  importFact: ResolvedImportFact,
  target: CodeNode,
): boolean {
  if (!importFact.localName) {
    return false;
  }
  if (access.path === importFact.localName || access.path.startsWith(`${importFact.localName}.`)) {
    if (target.name === importFact.importedName || target.name === importFact.localName) {
      return true;
    }
    const targetQualifiedName = stringFromMetadata(target.metadata, "qualifiedName");
    if (targetQualifiedName) {
      const rewrittenPath = `${targetQualifiedName.split(".")[0]}${access.path.slice(importFact.localName.length)}`;
      return rewrittenPath === targetQualifiedName || targetQualifiedName.startsWith(`${rewrittenPath}.`);
    }
    return target.name === importFact.importedName || target.name === importFact.localName;
  }
  return false;
}

function symbolsForFile(input: ApplyResolvedModuleGraphFactsInput, file: string): CodeNode[] {
  const symbols = new Map<string, CodeNode>();
  for (const symbol of input.astSymbolsByFile.get(file) ?? []) {
    symbols.set(symbol.id, symbol);
  }
  for (const symbol of input.scipSymbolNodes?.values() ?? []) {
    if (symbol.file === file) {
      symbols.set(symbol.id, symbol);
    }
  }
  return [...symbols.values()].sort((left, right) => symbolResolutionRank(left) - symbolResolutionRank(right));
}

function symbolNameMatches(symbol: CodeNode, containingName: string): boolean {
  return symbol.name === containingName || stringFromMetadata(symbol.metadata, "qualifiedName") === containingName;
}

function createNodeIdIndex(input: ApplyResolvedModuleGraphFactsInput): Map<string, CodeNode> {
  const nodes = new Map<string, CodeNode>();
  for (const node of input.fileNodes.values()) nodes.set(node.id, node);
  for (const node of input.packageNodes.values()) nodes.set(node.id, node);
  for (const symbols of input.astSymbolsByFile.values()) {
    for (const symbol of symbols) nodes.set(symbol.id, symbol);
  }
  for (const symbol of input.scipSymbolNodes?.values() ?? []) {
    nodes.set(symbol.id, symbol);
  }
  return nodes;
}

function createExportsByFileAndName(exports: ResolvedExportFact[]): Map<string, ResolvedExportFact> {
  return new Map(exports.map((exportFact) => [exportKey(exportFact.exporterFile, exportFact.exportedName), exportFact]));
}

function importNodeFor(
  input: ApplyResolvedModuleGraphFactsInput,
  importFact: ResolvedImportFact,
): CodeNode | undefined {
  return nodeByStableId(input.fileNodes, createStableId({
    kind: "import",
    workspace: input.workspaceName,
    repo: input.repo.name,
    commit: input.repo.commit,
    relativePath: importFact.importerFile,
    suffix: importFact.importIdSuffix,
  }));
}

function exportNodeFor(
  input: ApplyResolvedModuleGraphFactsInput,
  exportFact: ResolvedExportFact,
): CodeNode | undefined {
  return nodeByStableId(input.fileNodes, createStableId({
    kind: "export",
    workspace: input.workspaceName,
    repo: input.repo.name,
    commit: input.repo.commit,
    relativePath: exportFact.exporterFile,
    suffix: exportFact.exportIdSuffix,
  }));
}

function nodeByStableId(nodes: Map<string, CodeNode>, id: string): CodeNode | undefined {
  for (const node of nodes.values()) {
    if (node.id === id) {
      return node;
    }
  }
  return undefined;
}

function importMetadata(
  repo: string,
  importFact: ResolvedImportFact,
  target: CodeNode | undefined,
  importerPackage: string | undefined,
): Record<string, unknown> {
  const relationshipTags = importRelationshipTags(importFact, importerPackage);
  return {
    ownerRepo: repo,
    ownerFile: importFact.importerFile,
    origin: "module-resolution",
    source: "module-resolution",
    evidenceSources: mergeStringArrays(evidenceSourcesForTarget("tree-sitter-import", target), relationshipTags),
    confidence: importFact.confidence,
    relationship: relationshipTags.includes("package-boundary") ? "package-boundary" : undefined,
    relationshipTags,
    moduleSpecifier: importFact.moduleSpecifier,
    importKind: importFact.importKind,
    importerPackage,
    importedName: importFact.importedName,
    localName: importFact.localName,
    isDefault: importFact.isDefault,
    isNamespace: importFact.isNamespace,
    range: importFact.sourceRange,
    containingChunkIdSuffix: importFact.containingChunkIdSuffix,
    targetFile: importFact.targetFile,
    targetPackage: importFact.targetPackage,
    targetPackageExport: importFact.targetPackageExport,
    targetSymbolId: target?.id ?? importFact.targetSymbolId,
    targetSymbolName: target?.name ?? importFact.targetSymbolName,
    targetSymbolKind: target?.kind ?? importFact.targetSymbolKind,
    resolutionSource: importFact.resolutionSource,
    fallbackReason: importFact.fallbackReason,
    roles: ["Import", "ReadAccess"],
    scipSymbol: target?.metadata.scipSymbol,
    scipSymbolName: target?.name,
    scipSymbolKind: target?.metadata.scipSymbolKind,
  };
}

function importRelationshipTags(
  importFact: ResolvedImportFact,
  importerPackage: string | undefined,
): string[] {
  const tags: string[] = [];
  if (isPackageBoundaryImport(importFact, importerPackage)) {
    tags.push("package-boundary");
  }
  if (importFact.importKind === "type") {
    tags.push("type-import");
  }
  if (importFact.importKind === "dynamic") {
    tags.push("dynamic-import");
  }
  if (importFact.importKind === "side-effect") {
    tags.push("side-effect");
  }
  return tags.sort();
}

function isPackageBoundaryImport(
  importFact: ResolvedImportFact,
  importerPackage: string | undefined,
): boolean {
  if (importFact.targetPackage && importerPackage) {
    return importFact.targetPackage !== importerPackage;
  }
  return !importFact.moduleSpecifier.startsWith(".");
}

function exportMetadata(
  repo: string,
  exportFact: ResolvedExportFact,
  target: CodeNode | undefined,
): Record<string, unknown> {
  return {
    ownerRepo: repo,
    ownerFile: exportFact.exporterFile,
    origin: "module-resolution",
    source: "module-resolution",
    evidenceSources: evidenceSourcesForTarget("tree-sitter-export", target),
    confidence: exportFact.confidence,
    exportKind: exportFact.exportKind,
    exportedName: exportFact.exportedName,
    localName: exportFact.localName,
    moduleSpecifier: exportFact.moduleSpecifier,
    range: exportFact.sourceRange,
    containingChunkIdSuffix: exportFact.containingChunkIdSuffix,
    targetFile: exportFact.targetFile,
    targetPackage: exportFact.targetPackage,
    targetPackageExport: exportFact.targetPackageExport,
    targetSymbolId: target?.id ?? exportFact.targetSymbolId,
    targetSymbolName: target?.name ?? exportFact.targetSymbolName,
    targetSymbolKind: target?.kind ?? exportFact.targetSymbolKind,
    resolutionSource: exportFact.resolutionSource,
    fallbackReason: exportFact.fallbackReason,
    roles: ["Definition"],
    scipSymbol: target?.metadata.scipSymbol,
    scipSymbolName: target?.name,
    scipSymbolKind: target?.metadata.scipSymbolKind,
  };
}

function evidenceSourcesForTarget(sourceFact: string, target: CodeNode | undefined): string[] {
  return [
    sourceFact,
    "module-resolution",
    target?.metadata.scipSymbol ? "scip-typescript" : target ? "tree-sitter-declaration" : undefined,
  ].filter((source): source is string => Boolean(source));
}

function testMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return {
    ...metadata,
    evidenceSources: mergeStringArrays(metadata.evidenceSources, "tree-sitter-test"),
    roles: mergeStringArrays(metadata.roles, "Test"),
    testContext: true,
  };
}

function callUsageMetadata(
  metadata: Record<string, unknown>,
  call: FileFact["calls"][number] | undefined,
): Record<string, unknown> {
  const callRelationship = call?.callKind === "member" ? "member-call" : call?.callKind === "constructor" ? "constructor-call" : "function-call";
  const relationshipTags = callRelationshipTags(metadata, call, callRelationship);
  return {
    ...metadata,
    relationship: callRelationship,
    relationshipTags: mergeStringArrays(metadata.relationshipTags, relationshipTags),
    memberPath: call?.memberPath ?? metadata.memberPath,
    receiver: call?.receiver,
    propertyName: call?.propertyName,
    callKind: call?.callKind,
    range: call?.range ?? metadata.range,
    containingChunkIdSuffix: call?.containingChunkIdSuffix ?? metadata.containingChunkIdSuffix,
    evidenceSources: mergeStringArrays(
      mergeStringArrays(
        metadata.evidenceSources,
        call?.callKind === "member" ? "tree-sitter-member-call" : "tree-sitter-call",
      ),
      relationshipTags,
    ),
    roles: mergeStringArrays(metadata.roles, "Call"),
  };
}

function callRelationshipTags(
  metadata: Record<string, unknown>,
  call: FileFact["calls"][number] | undefined,
  callRelationship: string,
): string[] {
  const tags = [callRelationship];
  if (isDatabaseClientUsage(metadata, call)) {
    tags.push("mutation-to-database", "database-client-convention");
  }
  if (isLoaderOrActionTarget(metadata)) {
    tags.push("loader-action", "framework-convention");
  }
  if (isRouteOwnerFile(metadata)) {
    tags.push("route-handler", "framework-convention");
  }
  return tags.sort();
}

function isDatabaseClientUsage(
  metadata: Record<string, unknown>,
  call: FileFact["calls"][number] | undefined,
): boolean {
  const memberPath = call?.memberPath ?? stringFromMetadata(metadata, "memberPath") ?? "";
  const receiver = call?.receiver ?? "";
  const targetSymbolName = stringFromMetadata(metadata, "targetSymbolName") ?? "";
  const targetFile = stringFromMetadata(metadata, "targetFile") ?? "";
  const targetPackage = stringFromMetadata(metadata, "targetPackage") ?? "";
  return memberPath.startsWith("prisma.") ||
    receiver === "prisma" ||
    targetSymbolName === "prisma" ||
    /(^|\/)(database|db)\//.test(targetFile) ||
    /(^|[-/])(database|db)$/.test(targetPackage);
}

function isLoaderOrActionTarget(metadata: Record<string, unknown>): boolean {
  const targetSymbolName = stringFromMetadata(metadata, "targetSymbolName") ?? "";
  const targetFile = stringFromMetadata(metadata, "targetFile") ?? "";
  return /(?:Loader|Action)$/.test(targetSymbolName) ||
    /(^|[-_/])(loader|action)\.[cm]?[jt]sx?$/.test(targetFile) ||
    /(^|[-_/])(loader|action)([-_/]|$)/.test(targetFile);
}

function isRouteOwnerFile(metadata: Record<string, unknown>): boolean {
  const ownerFile = stringFromMetadata(metadata, "ownerFile") ?? "";
  return /(^|\/)(routes?|api)\//.test(ownerFile) ||
    /(^|\/)app\/.*\/route\.[cm]?[jt]sx?$/.test(ownerFile) ||
    /(^|\/)pages\/api\/.*\.[cm]?[jt]sx?$/.test(ownerFile);
}

function propertyAccessMetadata(
  metadata: Record<string, unknown>,
  access: FileFact["memberAccesses"][number] | undefined,
): Record<string, unknown> {
  return {
    ...metadata,
    relationship: "property-access",
    relationshipTags: mergeStringArrays(metadata.relationshipTags, "property-access"),
    memberPath: access?.path ?? metadata.memberPath,
    propertyName: access?.propertyName,
    range: access?.range ?? metadata.range,
    containingChunkIdSuffix: access?.containingChunkIdSuffix ?? metadata.containingChunkIdSuffix,
    evidenceSources: mergeStringArrays(
      mergeStringArrays(metadata.evidenceSources, "tree-sitter-member-access"),
      "property-access",
    ),
    roles: mergeStringArrays(metadata.roles, "ReadAccess"),
  };
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

function stringFromMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function symbolResolutionRank(node: CodeNode): number {
  return node.metadata.scipSymbol ? 0 : 1;
}

function exportKey(file: string, exportedName: string | undefined): string {
  return `${file}\0${exportedName ?? ""}`;
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

function fileKindForPath(relativePath: string): string {
  return /(^|\/)(__tests__|tests?)\//.test(relativePath) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath)
    ? "test"
    : "source";
}
