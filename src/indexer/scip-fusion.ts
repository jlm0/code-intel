import { createHash } from "node:crypto";

import { createStableId } from "../core/ids.js";
import type { CodeEdge, CodeNode, IndexManifest } from "../schema/schemas.js";
import type {
  ScipDefinition,
  ScipFacts,
  ScipOccurrenceRole,
  ScipRange,
  ScipReference,
} from "../scip/ingest.js";
import type { FileFact } from "./fact-cache.js";

export interface ScipFusionInput {
  facts: ScipFacts;
  workspaceName: string;
  repo: {
    name: string;
    commit: string;
  };
  fileNodes: Map<string, CodeNode>;
  fileChunks: Map<string, Array<CodeNode & { sourceCalls: string[] }>>;
  astSymbolsByFile: Map<string, CodeNode[]>;
  fileFactsByRelativePath: Map<string, FileFact>;
  addNode: (node: Omit<CodeNode, "schemaVersion">) => CodeNode;
  addEdge: AddEdge;
}

export interface ScipFusionResult {
  scipSymbolNodes: Map<string, CodeNode>;
}

export interface TreeSitterFallbackInput {
  graph: {
    chunks: Map<string, CodeNode & { content: string }>;
  };
  fileChunks: Map<string, Array<CodeNode & { sourceCalls: string[] }>>;
  symbolNodesByName: Map<string, CodeNode[]>;
  workspaceName: string;
  repoName: string;
  fileCount: number;
  addEdge: AddEdge;
}

type AddEdge = (
  kind: CodeEdge["kind"],
  fromId: string,
  toId: string,
  workspace: string,
  repo: string,
  metadata?: Record<string, unknown>,
) => void;

export function applyScipGraphFacts(input: ScipFusionInput): ScipFusionResult {
  const scipSymbolNodes = new Map<string, CodeNode>();
  for (const definition of input.facts.definitions) {
    const fileNode = input.fileNodes.get(definition.relativePath);
    const symbolNode = findAstSymbolForScipDefinition(input.astSymbolsByFile, definition)
      ?? input.addNode({
        id: createStableId({
          kind: "symbol",
          workspace: input.workspaceName,
          repo: input.repo.name,
          commit: input.repo.commit,
          relativePath: definition.relativePath,
          suffix: `scip-${definition.name}-${hashShort(definition.symbol)}`,
        }),
        kind: nodeKindForScipDefinition(definition),
        workspace: input.workspaceName,
        repo: input.repo.name,
        file: definition.relativePath,
        name: definition.name,
        range: definition.range,
        metadata: {
          fileKind: fileKindForPath(definition.relativePath),
          symbolKind: nodeKindForScipDefinition(definition),
          ownerRepo: input.repo.name,
          ownerFile: definition.relativePath,
          origin: "scip-typescript",
          derivedFrom: definition.symbol,
        },
      });
    promoteScipSymbolNode(symbolNode, definition, input.repo.name);
    scipSymbolNodes.set(definition.symbol, symbolNode);
    if (fileNode) {
      input.addEdge(
        "DEFINES",
        fileNode.id,
        symbolNode.id,
        input.workspaceName,
        input.repo.name,
        ownerFileMetadata(input.repo.name, definition.relativePath, "scip-typescript"),
      );
    }
    if (definition.range) {
      for (const chunk of input.fileChunks.get(definition.relativePath) ?? []) {
        if (chunk.range && rangesOverlap(chunk.range, definition.range)) {
          input.addEdge(
            "MENTIONS",
            chunk.id,
            symbolNode.id,
            input.workspaceName,
            input.repo.name,
            ownerFileMetadata(input.repo.name, definition.relativePath, "scip-typescript"),
          );
        }
      }
    }
  }

  for (const reference of input.facts.references) {
    const fileNode = input.fileNodes.get(reference.relativePath);
    const symbolNode = scipSymbolNodes.get(reference.symbol);
    const fileFact = input.fileFactsByRelativePath.get(reference.relativePath);
    const referenceRoles = scipRolesForReference(fileFact, reference);
    const referenceMetadata = scipRelationshipMetadata(input.repo.name, reference.relativePath, reference, referenceRoles);
    if (fileNode && symbolNode) {
      input.addEdge("REFERENCES", fileNode.id, symbolNode.id, input.workspaceName, input.repo.name, referenceMetadata);
      if (referenceRoles.includes("Import")) {
        input.addEdge("IMPORTS", fileNode.id, symbolNode.id, input.workspaceName, input.repo.name, referenceMetadata);
      }
    }
    if (!symbolNode) {
      continue;
    }
    const containingChunk = findContainingChunk(input.fileChunks.get(reference.relativePath) ?? [], reference.range);
    if (!containingChunk) {
      continue;
    }
    input.addEdge("REFERENCES", containingChunk.id, symbolNode.id, input.workspaceName, input.repo.name, referenceMetadata);
    input.addEdge("MENTIONS", containingChunk.id, symbolNode.id, input.workspaceName, input.repo.name, referenceMetadata);
    if (containingChunk.kind === "Test" || reference.isTest) {
      input.addEdge("TESTS", containingChunk.id, symbolNode.id, input.workspaceName, input.repo.name, referenceMetadata);
    }
    if (fileFact && referenceIsCall(fileFact, reference)) {
      input.addEdge("CALLS", containingChunk.id, symbolNode.id, input.workspaceName, input.repo.name, referenceMetadata);
      const sourceSymbolId = String(containingChunk.metadata.symbolId ?? "");
      if (sourceSymbolId && sourceSymbolId !== symbolNode.id) {
        input.addEdge("CALLS", sourceSymbolId, symbolNode.id, input.workspaceName, input.repo.name, referenceMetadata);
      }
    }
  }

  addScipExportEdges({
    workspaceName: input.workspaceName,
    repoName: input.repo.name,
    fileNodes: input.fileNodes,
    fileFactsByRelativePath: input.fileFactsByRelativePath,
    scipSymbolNodes,
    astSymbolsByFile: input.astSymbolsByFile,
    references: input.facts.references,
    addEdge: input.addEdge,
  });
  return { scipSymbolNodes };
}

export function addTreeSitterFallbackRelationships(input: TreeSitterFallbackInput): IndexManifest["health"] {
  for (const chunks of input.fileChunks.values()) {
    for (const chunk of chunks) {
      for (const callName of chunk.sourceCalls) {
        for (const target of input.symbolNodesByName.get(callName) ?? []) {
          const ownerMetadata = ownerFileMetadata(input.repoName, chunk.file ?? "", "tree-sitter-call");
          input.addEdge("CALLS", chunk.id, target.id, input.workspaceName, input.repoName, ownerMetadata);
          const sourceSymbolId = String(chunk.metadata.symbolId ?? "");
          if (sourceSymbolId && sourceSymbolId !== target.id) {
            input.addEdge("CALLS", sourceSymbolId, target.id, input.workspaceName, input.repoName, ownerMetadata);
          }
        }
      }
    }
  }

  if (input.fileCount <= 100) {
    addFallbackReferenceEdges(input);
    return [];
  }

  return [
    {
      name: `tree-sitter-reference-fallback:${input.repoName}`,
      status: "warn",
      message: "Skipped quadratic fallback reference scan for large repo after SCIP failure",
      details: { files: input.fileCount },
    },
  ];
}

function addScipExportEdges(input: {
  workspaceName: string;
  repoName: string;
  fileNodes: Map<string, CodeNode>;
  fileFactsByRelativePath: Map<string, FileFact>;
  scipSymbolNodes: Map<string, CodeNode>;
  astSymbolsByFile: Map<string, CodeNode[]>;
  references: ScipReference[];
  addEdge: AddEdge;
}): void {
  const referencesByFile = groupBy(input.references, (reference) => reference.relativePath);
  const symbolsByFileAndName = new Map<string, CodeNode>();
  for (const symbol of importResolutionCandidates(input.scipSymbolNodes, input.astSymbolsByFile)) {
    if (!symbol.file || !symbol.name) {
      continue;
    }
    const key = symbolLookupKey(symbol.file, symbol.name);
    if (!symbolsByFileAndName.has(key)) {
      symbolsByFileAndName.set(key, symbol);
    }
  }
  for (const [relativePath, fileFact] of input.fileFactsByRelativePath) {
    const fileNode = input.fileNodes.get(relativePath);
    if (!fileNode) continue;
    for (const exportFact of fileFact.exports) {
      const matchingReference = (referencesByFile.get(relativePath) ?? []).find(
        (reference) => reference.relativePath === relativePath && rangeContains(exportFact.range, reference.range),
      );
      const targetNode = matchingReference
        ? input.scipSymbolNodes.get(matchingReference.symbol)
        : symbolsByFileAndName.get(symbolLookupKey(relativePath, exportFact.localName))
          ?? symbolsByFileAndName.get(symbolLookupKey(relativePath, exportFact.exportedName));
      if (!targetNode) continue;
      input.addEdge(
        "EXPORTS",
        fileNode.id,
        targetNode.id,
        input.workspaceName,
        input.repoName,
        matchingReference
          ? scipRelationshipMetadata(input.repoName, relativePath, matchingReference)
          : exportResolutionMetadata(input.repoName, relativePath, targetNode),
      );
    }
  }
}

function addFallbackReferenceEdges(input: TreeSitterFallbackInput): void {
  for (const chunk of input.graph.chunks.values()) {
    if (chunk.repo !== input.repoName || !chunk.file) continue;
    for (const [symbolName, symbols] of input.symbolNodesByName) {
      if (!chunk.content.includes(symbolName)) continue;
      for (const symbol of symbols) {
        if (symbol.file !== chunk.file) continue;
        if (String(chunk.metadata.symbolId) === symbol.id) continue;
        input.addEdge(
          chunk.kind === "Test" ? "TESTS" : "REFERENCES",
          chunk.id,
          symbol.id,
          input.workspaceName,
          input.repoName,
          ownerFileMetadata(input.repoName, chunk.file, "tree-sitter-reference-fallback"),
        );
      }
    }
  }
}

function symbolLookupKey(file: string | undefined, name: string | undefined): string {
  return `${file ?? ""}\0${name ?? ""}`;
}

function importResolutionCandidates(
  scipSymbolNodes: Map<string, CodeNode>,
  astSymbolsByFile: Map<string, CodeNode[]>,
): CodeNode[] {
  const byId = new Map<string, CodeNode>();
  for (const symbols of astSymbolsByFile.values()) {
    for (const symbol of symbols) {
      byId.set(symbol.id, symbol);
    }
  }
  for (const symbol of scipSymbolNodes.values()) {
    byId.set(symbol.id, symbol);
  }
  return [...byId.values()].sort((left, right) => symbolResolutionRank(left) - symbolResolutionRank(right));
}

function symbolResolutionRank(node: CodeNode): number {
  return node.metadata.scipSymbol ? 0 : 1;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) {
      continue;
    }
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function exportResolutionMetadata(repo: string, file: string, target: CodeNode): Record<string, unknown> {
  const isScipBacked = typeof target.metadata.scipSymbol === "string";
  return {
    ownerRepo: repo,
    ownerFile: file,
    origin: isScipBacked ? "scip-typescript" : "tree-sitter-export-resolution",
    source: isScipBacked ? "scip-typescript" : "tree-sitter-export-resolution",
    evidenceSources: isScipBacked
      ? ["scip-typescript", "tree-sitter-export"]
      : ["tree-sitter-export", "tree-sitter-declaration"],
    confidence: isScipBacked ? "high" : "fallback",
    scipSymbol: target.metadata.scipSymbol,
    scipSymbolName: target.name,
    scipSymbolKind: target.metadata.scipSymbolKind,
    roles: ["Definition"],
  };
}

function promoteScipSymbolNode(node: CodeNode, definition: ScipDefinition, repoName: string): void {
  const previousOrigin = stringFromMetadata(node.metadata, "origin");
  const definitionKind = nodeKindForScipDefinition(definition);
  if (node.kind === "Symbol") {
    node.kind = definitionKind;
  }
  node.range ??= definition.range;
  node.metadata = mergeMetadata(node.metadata, {
    source: "scip-typescript",
    sourcePriority: "canonical",
    scipSymbol: definition.symbol,
    scipSymbolKind: definition.kind,
    documentation: definition.documentation,
    fileKind: fileKindForPath(definition.relativePath),
    symbolKind: node.kind,
    ownerRepo: repoName,
    ownerFile: definition.relativePath,
    origin: "scip-typescript",
    astOrigin: previousOrigin && previousOrigin !== "scip-typescript" ? previousOrigin : undefined,
    evidenceSources: ["scip-typescript", previousOrigin].filter(Boolean),
    derivedFrom: definition.symbol,
  });
}

function findAstSymbolForScipDefinition(
  astSymbolsByFile: Map<string, CodeNode[]>,
  definition: ScipDefinition,
): CodeNode | undefined {
  const symbols = astSymbolsByFile.get(definition.relativePath) ?? [];
  const matchingSymbols = symbols.filter((node) =>
    namesMatchScipDefinition(node, definition) &&
    (!definition.range || !node.range || rangesOverlap(node.range, definition.range))
  );
  if (matchingSymbols.length === 0) {
    return undefined;
  }
  return matchingSymbols.sort((left, right) => rangeSize(left.range) - rangeSize(right.range))[0];
}

function namesMatchScipDefinition(node: CodeNode, definition: ScipDefinition): boolean {
  const qualifiedName = stringFromMetadata(node.metadata, "qualifiedName");
  return node.name === definition.name || qualifiedName === definition.name || Boolean(qualifiedName?.endsWith(`.${definition.name}`));
}

function nodeKindForScipDefinition(definition: ScipDefinition): CodeNode["kind"] {
  switch (definition.kind) {
    case "Class":
      return "Class";
    case "Interface":
      return "Interface";
    case "TypeAlias":
      return "TypeAlias";
    case "Function":
    case "Method":
    case "Constructor":
      return "Function";
    default:
      return "Symbol";
  }
}

function referenceIsCall(fileFact: FileFact, reference: ScipReference): boolean {
  if (reference.isImport || reference.isWriteAccess) {
    return false;
  }
  return fileFact.calls.some((call) =>
    rangeContains(call.range, reference.range) &&
    (call.name === reference.symbolName || call.propertyName === reference.symbolName)
  );
}

function scipRolesForReference(
  fileFact: FileFact | undefined,
  reference: ScipReference,
): ScipOccurrenceRole[] {
  const roles = new Set<ScipOccurrenceRole>(reference.roles);
  if (fileFact?.imports.some((importFact) => rangeContains(importFact.range, reference.range))) {
    roles.add("Import");
  }
  if (reference.isTest) {
    roles.add("Test");
  }
  if (!reference.isWriteAccess) {
    roles.add("ReadAccess");
  }
  return [...roles].sort();
}

function scipRelationshipMetadata(
  repo: string,
  file: string,
  reference: ScipReference,
  roles = reference.roles,
): Record<string, unknown> {
  return {
    ownerRepo: repo,
    ownerFile: file,
    origin: "scip-typescript",
    source: "scip-typescript",
    evidenceSources: ["scip-typescript"],
    confidence: "high",
    scipSymbol: reference.symbol,
    scipSymbolName: reference.symbolName,
    scipSymbolKind: reference.symbolKind,
    scipRange: reference.range,
    roles,
  };
}

function ownerFileMetadata(repo: string, file: string, origin: string): Record<string, unknown> {
  return {
    ownerRepo: repo,
    ...(file ? { ownerFile: file } : {}),
    origin,
  };
}

function rangesOverlap(
  left: { startLine: number; endLine: number },
  right: { startLine: number; endLine: number },
): boolean {
  return left.startLine <= right.endLine && right.startLine <= left.endLine;
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

function rangeSize(range: CodeNode["range"]): number {
  if (!range) {
    return Number.MAX_SAFE_INTEGER;
  }
  return (range.endLine - range.startLine) * 1_000 + ((range.endColumn ?? 0) - (range.startColumn ?? 0));
}

function findContainingChunk<T extends { range?: { startLine: number; endLine: number } }>(
  chunks: T[],
  range: { startLine: number; endLine: number },
): T | undefined {
  return chunks
    .filter((chunk) => chunk.range && chunk.range.startLine <= range.startLine && chunk.range.endLine >= range.endLine)
    .sort((left, right) => {
      const leftSize = (left.range?.endLine ?? 0) - (left.range?.startLine ?? 0);
      const rightSize = (right.range?.endLine ?? 0) - (right.range?.startLine ?? 0);
      return leftSize - rightSize;
    })[0];
}

function mergeMetadata(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...current };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) {
      continue;
    }
    if (key === "evidenceSources") {
      merged.evidenceSources = mergeStringArrays(merged.evidenceSources, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
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

function hashShort(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function fileKindForPath(relativePath: string): string {
  return /(^|\/)(__tests__|tests?)\//.test(relativePath) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath)
    ? "test"
    : "source";
}
