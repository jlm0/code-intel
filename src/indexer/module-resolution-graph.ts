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
      evidenceSources: ["package-json", "module-resolution"],
      confidence: "high",
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
  const metadata = importMetadata(input.repo.name, importFact, directTargetSymbol);

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
    const callMetadata = importMetadata(input.repo.name, importFact, target);
    const callingChunks = chunksCallingImport(input, importFact, target);
    const fileContainsCall = fileCallsImport(input, importFact, target);
    const usageMetadata = callUsageMetadata(callMetadata);
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
  return (input.fileFactsByRelativePath.get(importFact.importerFile)?.calls ?? []).some((call) =>
    callMatchesImport(call, importFact, target),
  );
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
    const symbol = call.containingDeclarationName
      ? symbols.find((candidate) =>
        candidate.name === call.containingDeclarationName &&
        candidate.range &&
        rangeContains(candidate.range, call.range)
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
  if (importFact.isNamespace && importFact.localName) {
    return call.receiver === importFact.localName ||
      Boolean(call.receiver?.startsWith(`${importFact.localName}.`)) ||
      Boolean(call.memberPath?.startsWith(`${importFact.localName}.`));
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
): Record<string, unknown> {
  return {
    ownerRepo: repo,
    ownerFile: importFact.importerFile,
    origin: "module-resolution",
    source: "module-resolution",
    evidenceSources: evidenceSourcesForTarget("tree-sitter-import", target),
    confidence: importFact.confidence,
    moduleSpecifier: importFact.moduleSpecifier,
    importKind: importFact.importKind,
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

function callUsageMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return {
    ...metadata,
    roles: mergeStringArrays(metadata.roles, "Call"),
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
