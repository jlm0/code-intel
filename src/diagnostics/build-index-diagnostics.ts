import { schemaVersion, type CodeEdge, type CodeNode } from "../schema/schemas.js";
import type { RepoScipFacts } from "../scip/fact-cache.js";
import type { DiscoveredWorkspace, DiscoveryFileDiagnostic } from "../workspace/discovery.js";
import type { FileFact } from "../indexer/fact-cache.js";
import { fingerprintKey } from "../indexer/update-planner.js";
import { IndexDiagnosticsSchema } from "./schema.js";
import {
  diagnosticsSchemaVersion,
  type DiagnosticStage,
  type FileLifecycleDiagnostic,
  type IndexDiagnostics,
} from "./types.js";

export function buildIndexDiagnostics(input: {
  workspace: DiscoveredWorkspace;
  generatedAt: string;
  fileFactsByKey: Map<string, FileFact>;
  scipFactsByRepo: RepoScipFacts[];
  nodes: Iterable<CodeNode>;
  edges: Iterable<CodeEdge>;
}): IndexDiagnostics {
  const graphCounts = countGraphByFile(input.nodes, input.edges);
  const scipCounts = countScipByFile(input.scipFactsByRepo);
  const indexedFiles = new Set<string>();
  const files: FileLifecycleDiagnostic[] = [];

  for (const repo of input.workspace.repos) {
    for (const file of repo.files) {
      const key = fingerprintKey({ repo: repo.name, relativePath: file.relativePath });
      const fileFact = input.fileFactsByKey.get(key);
      const graph = graphCounts.get(key) ?? emptyGraphCounts();
      const scip = scipCounts.get(key) ?? { definitions: 0, references: 0 };
      const symbolNames = symbolNamesForFile(fileFact);
      const embeddedChunks = fileFact?.chunks.filter((chunk) => (chunk.embedding?.length ?? 0) > 0).length ?? 0;
      const graphWritten = graph.nodes > 0;
      const symbolQueryable = symbolNames.length > 0 && graphWritten;
      const semanticQueryable = embeddedChunks > 0 && graphWritten;
      indexedFiles.add(key);
      files.push({
        repo: repo.name,
        relativePath: file.relativePath,
        absolutePath: file.absolutePath,
        packageName: file.packageName,
        language: file.language,
        status: "indexed",
        reasons: [],
        lifecycle: {
          fetch: { status: "pass", reason: "local-or-cached-corpus-present" },
          sparseCheckout: { status: "pass", reason: "file-present-in-corpus" },
          discovery: { status: "pass", reason: "source-file" },
          ignore: { status: "pass" },
          tsconfig: { status: "pass" },
          parse: fileFact?.hasParseError
            ? { status: "warn", reason: "tree-sitter-parse-error-recovered" }
            : { status: "pass" },
          ast: stageFromCount(fileFact ? 1 : 0, "missing-ast-facts", {
            imports: fileFact?.imports.length ?? 0,
            exports: fileFact?.exports.length ?? 0,
            declarations: fileFact?.declarations.length ?? 0,
            calls: fileFact?.calls.length ?? 0,
          }),
          scip: scip.definitions + scip.references > 0
            ? { status: "pass", evidence: scip }
            : { status: "warn", reason: "no-scip-occurrences-for-file", evidence: scip },
          chunks: stageFromCount(fileFact?.chunks.length ?? 0, "no-chunks"),
          embeddings: stageFromCount(embeddedChunks, "no-embedded-chunks"),
          graph: stageFromCount(graph.nodes, "no-graph-nodes", graph),
          exactQueryability: graphWritten ? { status: "pass", reason: "file-node-queryable" } : { status: "fail", reason: "missing-file-node" },
          symbolQueryability: symbolQueryable ? { status: "pass", reason: "symbol-names-queryable" } : { status: "warn", reason: "no-queryable-symbols" },
          semanticRanking: semanticQueryable ? { status: "pass", reason: "embedded-chunks-rankable" } : { status: "warn", reason: "no-rankable-chunks" },
        },
        counts: {
          chunks: fileFact?.chunks.length ?? 0,
          imports: fileFact?.imports.length ?? 0,
          exports: fileFact?.exports.length ?? 0,
          declarations: fileFact?.declarations.length ?? 0,
          calls: fileFact?.calls.length ?? 0,
          scipDefinitions: scip.definitions,
          scipReferences: scip.references,
          graphNodes: graph.nodes,
          graphEdges: graph.edges,
          embeddedChunks,
        },
        queryability: {
          exact: graphWritten,
          symbol: symbolQueryable,
          semantic: semanticQueryable,
          symbolNames,
        },
      });
    }
  }

  for (const diagnostic of input.workspace.diagnostics.files) {
    const key = fingerprintKey({ repo: diagnostic.repo, relativePath: diagnostic.relativePath });
    if (!indexedFiles.has(key)) {
      files.push(skippedFileDiagnostic(diagnostic));
    }
  }

  const sortedFiles = files.sort((left, right) =>
    left.repo.localeCompare(right.repo) || left.relativePath.localeCompare(right.relativePath),
  );
  return IndexDiagnosticsSchema.parse({
    schemaVersion,
    diagnosticsSchemaVersion,
    workspace: input.workspace.workspaceName,
    generatedAt: input.generatedAt,
    summary: {
      candidateFiles: sortedFiles.length,
      indexedFiles: sortedFiles.filter((file) => file.status === "indexed").length,
      skippedFiles: sortedFiles.filter((file) => file.status === "skipped").length,
      graphFiles: sortedFiles.filter((file) => file.lifecycle.graph?.status === "pass").length,
      embeddedFiles: sortedFiles.filter((file) => file.queryability.semantic).length,
      symbolQueryableFiles: sortedFiles.filter((file) => file.queryability.symbol).length,
    },
    files: sortedFiles,
  });
}

function skippedFileDiagnostic(diagnostic: DiscoveryFileDiagnostic): FileLifecycleDiagnostic {
  const lifecycle: Record<string, DiagnosticStage> = {
    fetch: { status: "pass", reason: "local-or-cached-corpus-present" },
    sparseCheckout: { status: "pass", reason: "path-seen-during-discovery" },
    discovery: { status: "fail", reason: diagnostic.reason },
    ignore: diagnostic.reason === "ignored-directory"
      ? { status: "fail", reason: diagnostic.reason }
      : { status: "pass" },
    tsconfig: diagnostic.reason === "tsconfig-excluded"
      ? { status: "fail", reason: diagnostic.reason }
      : { status: "skip" },
    parse: { status: "skip", reason: diagnostic.reason },
    ast: { status: "skip", reason: diagnostic.reason },
    scip: { status: "skip", reason: diagnostic.reason },
    chunks: { status: "skip", reason: diagnostic.reason },
    embeddings: { status: "skip", reason: diagnostic.reason },
    graph: { status: "skip", reason: diagnostic.reason },
    exactQueryability: { status: "skip", reason: diagnostic.reason },
    symbolQueryability: { status: "skip", reason: diagnostic.reason },
    semanticRanking: { status: "skip", reason: diagnostic.reason },
  };
  return {
    repo: diagnostic.repo,
    relativePath: diagnostic.relativePath,
    absolutePath: diagnostic.absolutePath,
    packageName: diagnostic.packageName,
    language: diagnostic.language,
    status: "skipped",
    reasons: [diagnostic.reason],
    lifecycle,
    counts: {
      chunks: 0,
      imports: 0,
      exports: 0,
      declarations: 0,
      calls: 0,
      scipDefinitions: 0,
      scipReferences: 0,
      graphNodes: 0,
      graphEdges: 0,
      embeddedChunks: 0,
    },
    queryability: {
      exact: false,
      symbol: false,
      semantic: false,
      symbolNames: [],
    },
  };
}

function countGraphByFile(nodes: Iterable<CodeNode>, edges: Iterable<CodeEdge>): Map<string, { nodes: number; edges: number }> {
  const counts = new Map<string, { nodes: number; edges: number }>();
  for (const node of nodes) {
    if (!node.file) continue;
    const key = fingerprintKey({ repo: node.repo, relativePath: node.file });
    const count = counts.get(key) ?? emptyGraphCounts();
    count.nodes += 1;
    counts.set(key, count);
  }
  for (const edge of edges) {
    const ownerRepo = typeof edge.metadata.ownerRepo === "string" ? edge.metadata.ownerRepo : edge.repo;
    const ownerFile = typeof edge.metadata.ownerFile === "string" ? edge.metadata.ownerFile : undefined;
    if (!ownerFile) continue;
    const key = fingerprintKey({ repo: ownerRepo, relativePath: ownerFile });
    const count = counts.get(key) ?? emptyGraphCounts();
    count.edges += 1;
    counts.set(key, count);
  }
  return counts;
}

function countScipByFile(repos: RepoScipFacts[]): Map<string, { definitions: number; references: number }> {
  const counts = new Map<string, { definitions: number; references: number }>();
  for (const repo of repos) {
    for (const definition of repo.definitions) {
      const count = scipCount(counts, repo.name, definition.relativePath);
      count.definitions += 1;
    }
    for (const reference of repo.references) {
      const count = scipCount(counts, repo.name, reference.relativePath);
      count.references += 1;
    }
  }
  return counts;
}

function scipCount(
  counts: Map<string, { definitions: number; references: number }>,
  repo: string,
  relativePath: string,
): { definitions: number; references: number } {
  const key = fingerprintKey({ repo, relativePath });
  const count = counts.get(key) ?? { definitions: 0, references: 0 };
  counts.set(key, count);
  return count;
}

function emptyGraphCounts(): { nodes: number; edges: number } {
  return { nodes: 0, edges: 0 };
}

function symbolNamesForFile(fileFact: FileFact | undefined): string[] {
  if (!fileFact) {
    return [];
  }
  return [...new Set([
    ...fileFact.chunks.map((chunk) => chunk.name),
    ...fileFact.declarations.map((declaration) => declaration.name),
    ...fileFact.declarations.map((declaration) => declaration.qualifiedName),
  ].filter((name) => name && !name.includes("/")))].sort();
}

function stageFromCount(count: number, reason: string, evidence?: Record<string, unknown>): DiagnosticStage {
  return count > 0
    ? { status: "pass", evidence: { count, ...evidence } }
    : { status: "fail", reason, evidence };
}
