import { resolveActiveIndexSnapshot, type ActiveIndexSnapshot } from "../core/index-artifacts.js";
import { truncateUtf8Bytes } from "../core/text.js";
import { LadybugGraphStore } from "../graph/ladybug-store.js";
import {
  buildGraphEdgeIndex,
  buildGraphNodeIndex,
  findGraphPath,
  type GraphPathTraversalResult,
  type GraphTraversalDirection,
} from "../graph/path-traversal.js";
import type { CodeGraphRepository, SemanticSearchFilters, StoredCodeNode } from "../graph/repository.js";
import {
  QueryResultSchema,
  schemaVersion,
  type CodeEdge,
  type CodeNode,
  type QueryResult,
  type QueryResultItem,
} from "../schema/schemas.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
} from "../vectors/embedding.js";
import { rankHybridSemanticRows } from "./semantic-ranking.js";

export interface QueryEngineOptions {
  indexPath: string;
  embeddingProviderName?: string;
  embeddingModel?: string;
  embeddingProvider?: EmbeddingProvider;
}

export interface QueryLimitOptions {
  limit: number;
}

export interface SemanticQueryOptions extends QueryLimitOptions, SemanticSearchFilters {}

export interface TracePathOptions extends QueryLimitOptions {
  maxDepth?: number;
  allowedEdgeKinds?: CodeEdge["kind"][];
  direction?: GraphTraversalDirection;
}

export interface RelationshipQueryOptions extends QueryLimitOptions {
  allowedEdgeKinds?: CodeEdge["kind"][];
  direction?: GraphTraversalDirection;
}

export interface QueryEngineRuntimeStats {
  serializedOperations: number;
  queueWaitMs: number;
  maxQueueDepth: number;
  store?: {
    lockWaitMs: number;
    openRetryCount: number;
    lockContentionCount: number;
  };
}

export function createQueryEngine(options: QueryEngineOptions): QueryEngine {
  const snapshot = resolveActiveIndexSnapshot(options.indexPath);
  return new QueryEngine(
    new LadybugGraphStore(options.indexPath, {
      databasePath: snapshot.then((activeIndex) => activeIndex.databasePath),
    }),
    resolveEmbeddingProviderForIndex(options, snapshot),
  );
}

export class QueryEngine {
  private operationQueue = Promise.resolve();
  private queuedOperations = 0;
  private readonly runtimeStats: QueryEngineRuntimeStats = {
    serializedOperations: 0,
    queueWaitMs: 0,
    maxQueueDepth: 0,
  };

  constructor(
    private readonly store: CodeGraphRepository,
    private readonly embeddingProvider: Promise<EmbeddingProvider>,
  ) {}

  async close(): Promise<void> {
    await this.operationQueue.catch(() => undefined);
    await this.store.close();
  }

  getRepository(): CodeGraphRepository {
    return this.store;
  }

  getRuntimeStats(): QueryEngineRuntimeStats {
    const maybeStore = this.store as CodeGraphRepository & {
      getRuntimeStats?: () => QueryEngineRuntimeStats["store"];
    };
    const storeStats = maybeStore.getRuntimeStats?.();
    return {
      serializedOperations: this.runtimeStats.serializedOperations,
      queueWaitMs: Math.round(this.runtimeStats.queueWaitMs),
      maxQueueDepth: this.runtimeStats.maxQueueDepth,
      store: storeStats,
    };
  }

  async findSymbol(name: string, options: QueryLimitOptions): Promise<QueryResult> {
    return this.runExclusive(async () => {
      const nodes = await this.store.findSymbols(name, options.limit);
      return parseQueryResult({
        schemaVersion,
        query: name,
        results: nodes.map((node) => nodeToResult(node, ["symbol_name"])),
      });
    });
  }

  async getCallers(symbol: string, options: QueryLimitOptions): Promise<QueryResult> {
    return this.runExclusive(() => this.relatedTo(symbol, "CALLS", "incoming", options, "callers"));
  }

  async getCallees(symbol: string, options: QueryLimitOptions): Promise<QueryResult> {
    return this.runExclusive(() => this.relatedTo(symbol, "CALLS", "outgoing", options, "callees"));
  }

  async getReferences(symbol: string, options: QueryLimitOptions): Promise<QueryResult> {
    return this.runExclusive(async () => {
      const definitions = (await this.store.findSymbols(symbol, Math.min(options.limit, 10)))
        .filter((node) => isExactSymbolDefinition(node, symbol))
        .slice(0, 5);
      const references = await this.relatedTo(symbol, "REFERENCES", "incoming", options, "references");
      const seen = new Set<string>();
      const results: QueryResultItem[] = [];

      for (const result of rankReferenceResults(symbol, references.results)) {
        pushResult(result);
      }
      for (const node of definitions) {
        pushResult(nodeToResult(node, ["symbol_definition"]));
      }

      return parseQueryResult({
        schemaVersion,
        query: symbol,
        results: results.slice(0, options.limit),
      });

      function pushResult(result: QueryResultItem): void {
        if (seen.has(result.id)) {
          return;
        }
        seen.add(result.id);
        results.push(result);
      }
    });
  }

  async getRelationships(seed: string, options: RelationshipQueryOptions): Promise<QueryResult> {
    return this.runExclusive(async () => {
      const seedNodes = await this.store.findSymbols(seed, 50);
      const seedIds = new Set(seedNodes.map((node) => node.id));
      if (seedIds.size === 0) {
        return parseQueryResult({ schemaVersion, query: seed, results: [] });
      }

      const allowedEdgeKinds = new Set(options.allowedEdgeKinds ?? relationshipEdgeKinds);
      const direction = options.direction ?? "either";
      const nodes = await this.store.getNodes();
      const nodesById = new Map(nodes.map((node) => [node.id, node]));
      const rows = (await this.store.getEdges())
        .flatMap((edge) => relationshipRowsForEdge(edge, seedIds, nodesById, allowedEdgeKinds, direction))
        .sort(compareRelationshipRows)
        .slice(0, options.limit);

      return parseQueryResult({
        schemaVersion,
        query: seed,
        results: rows.map((row) =>
          nodeToResult(row.node, [`graph_${row.edge.kind.toLowerCase()}`, `relationship_${row.direction}`], {
            metadata: {
              ...sanitizeMetadata(row.node),
              relationship: relationshipMetadata(row.edge.kind, {
                ...row.edge.metadata,
                traversalDirection: row.direction,
                seedId: row.seedId,
              }),
            },
          }),
        ),
      });
    });
  }

  async expandContext(nodeId: string, options: QueryLimitOptions & { depth: number }): Promise<QueryResult> {
    return this.runExclusive(async () => {
      const seen = new Set<string>([nodeId]);
      let frontier = [nodeId];
      const results: QueryResultItem[] = [];

      for (let depth = 0; depth < options.depth && frontier.length > 0 && results.length < options.limit; depth += 1) {
        const rows = await this.store.getAdjacentNodes(frontier, options.limit - results.length);
        const nextFrontier: string[] = [];
        for (const row of rows) {
          if (seen.has(row.node.id)) {
            continue;
          }
          seen.add(row.node.id);
          nextFrontier.push(row.node.id);
          results.push(nodeToResult(row.node, [`graph_${row.edgeKind.toLowerCase()}`]));
          if (results.length >= options.limit) {
            break;
          }
        }
        frontier = nextFrontier;
      }

      return parseQueryResult({ schemaVersion, query: nodeId, results });
    });
  }

  async getContext(nodeId: string, options: QueryLimitOptions): Promise<QueryResult> {
    return this.runExclusive(async () => {
      const nodes = await this.store.getContextNodes(nodeId, options.limit);
      return parseQueryResult({
        schemaVersion,
        query: nodeId,
        results: nodes.map((node) =>
          nodeToResult(node, ["source_context"], {
            excerpt: node.content ? truncateSource(node.content) : undefined,
          }),
        ),
      });
    });
  }

  async semanticSearch(query: string, options: SemanticQueryOptions): Promise<QueryResult> {
    return this.runExclusive(async () => {
      const provider = await this.embeddingProvider;
      const vectorRows = await this.store.semanticSearch(await provider.embed(query), Math.max(options.limit * 5, 50), {
        repo: options.repo,
        packageName: options.packageName,
        fileKind: options.fileKind,
        symbolKind: options.symbolKind,
      });
      const rows = await rankHybridSemanticRows({
        store: this.store,
        query,
        vectorRows,
        limit: options.limit,
        filters: {
          repo: options.repo,
          packageName: options.packageName,
          fileKind: options.fileKind,
          symbolKind: options.symbolKind,
        },
      });
      return parseQueryResult({
        schemaVersion,
        query,
        results: rows.map((row) =>
          nodeToResult(row.node, row.signals, {
            score: Math.max(0, 1 - row.distance),
            metadata: {
              ...sanitizeMetadata(row.node),
              ranking: row.ranking,
            },
          }),
        ),
      });
    });
  }

  async tracePath(fromId: string, toId: string, options: TracePathOptions): Promise<QueryResult> {
    return this.runExclusive(async () => {
      const nodes = await this.store.getNodes();
      const edges = await this.store.getEdges();
      const nodeIndex = buildGraphNodeIndex(nodes);
      const traversal = findGraphPath({
        startIds: new Set([fromId]),
        targetIds: new Set([toId]),
        nodeIndex,
        edgeIndex: buildGraphEdgeIndex(edges),
        options: {
          maxDepth: options.maxDepth ?? options.limit,
          allowedKinds: options.allowedEdgeKinds,
          direction: options.direction ?? "either",
        },
      });
      const path = traversal?.path ?? [];
      return parseQueryResult({
        schemaVersion,
        query: `${fromId} -> ${toId}`,
        results: path.slice(0, options.limit).map((node, index) =>
          nodeToResult(node, ["graph_path"], {
            metadata: pathMetadata(node, traversal, index),
          }),
        ),
      });
    });
  }

  private async runExclusive<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release: () => void = () => undefined;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queuedOperations += 1;
    this.runtimeStats.maxQueueDepth = Math.max(this.runtimeStats.maxQueueDepth, this.queuedOperations);
    const waitStart = performance.now();
    await previous.catch(() => undefined);
    this.queuedOperations -= 1;
    this.runtimeStats.queueWaitMs += performance.now() - waitStart;
    this.runtimeStats.serializedOperations += 1;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  private async relatedTo(
    symbol: string,
    edgeKind: CodeEdge["kind"],
    direction: "incoming" | "outgoing",
    options: QueryLimitOptions,
    signal: string,
  ): Promise<QueryResult> {
    const rows = await this.store.getRelatedNodes(symbol, edgeKind, direction, options.limit);
    return parseQueryResult({
      schemaVersion,
      query: symbol,
      results: rows.map((row) =>
        nodeToResult(row.node, [`graph_${signal}`], {
          metadata: {
            ...sanitizeMetadata(row.node),
            relationship: relationshipMetadata(edgeKind, row.edgeMetadata),
          },
        }),
      ),
    });
  }

}

const relationshipEdgeKinds: CodeEdge["kind"][] = [
  "CONTAINS",
  "DEFINES",
  "IMPORTS",
  "EXPORTS",
  "REFERENCES",
  "CALLS",
  "EXTENDS",
  "IMPLEMENTS",
  "DEPENDS_ON",
  "HAS_CHUNK",
  "TESTS",
  "MENTIONS",
];

interface RelationshipRow {
  node: StoredCodeNode;
  edge: CodeEdge;
  direction: "incoming" | "outgoing";
  seedId: string;
}

function relationshipRowsForEdge(
  edge: CodeEdge,
  seedIds: Set<string>,
  nodesById: Map<string, StoredCodeNode>,
  allowedEdgeKinds: Set<CodeEdge["kind"]>,
  direction: GraphTraversalDirection,
): RelationshipRow[] {
  if (!allowedEdgeKinds.has(edge.kind)) {
    return [];
  }
  const rows: RelationshipRow[] = [];
  if ((direction === "incoming" || direction === "either") && seedIds.has(edge.toId)) {
    const node = nodesById.get(edge.fromId);
    if (node) {
      rows.push({ node, edge, direction: "incoming", seedId: edge.toId });
    }
  }
  if ((direction === "outgoing" || direction === "either") && seedIds.has(edge.fromId)) {
    const node = nodesById.get(edge.toId);
    if (node) {
      rows.push({ node, edge, direction: "outgoing", seedId: edge.fromId });
    }
  }
  return rows;
}

function compareRelationshipRows(left: RelationshipRow, right: RelationshipRow): number {
  return relationshipRowScore(left) - relationshipRowScore(right) ||
    left.edge.kind.localeCompare(right.edge.kind) ||
    (left.node.file ?? "").localeCompare(right.node.file ?? "") ||
    (left.node.name ?? "").localeCompare(right.node.name ?? "") ||
    left.node.id.localeCompare(right.node.id);
}

function relationshipRowScore(row: RelationshipRow): number {
  let score = 100;
  const path = row.node.file ?? "";
  if (row.edge.kind === "CALLS") score -= 22;
  if (row.edge.kind === "REFERENCES") score -= 18;
  if (row.edge.kind === "TESTS") score -= 16;
  if (row.edge.metadata.confidence === "high") score -= 8;
  if (metadataArrayIncludes(row.edge.metadata.evidenceSources, "scip-typescript")) score -= 7;
  if (metadataArrayIncludes(row.edge.metadata.evidenceSources, "module-resolution")) score -= 7;
  if (metadataArrayIncludes(row.edge.metadata.evidenceSources, "tree-sitter-type-reference")) score -= 4;
  if (row.node.kind === "Function" || row.node.kind === "Class" || row.node.kind === "TypeAlias") score -= 5;
  if (/\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$|\/__tests__\//.test(path)) score -= 4;
  if (row.direction === "incoming") score -= 2;
  if (row.edge.kind === "MENTIONS") score += 20;
  return score;
}

function metadataArrayIncludes(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.includes(expected);
}

function parseQueryResult(result: QueryResult): QueryResult {
  return QueryResultSchema.parse(result);
}

function nodeToResult(
  node: StoredCodeNode,
  matchedSignals: string[],
  overrides: Partial<QueryResultItem> = {},
): QueryResultItem {
  return {
    id: node.id,
    kind: node.kind,
    repo: node.repo,
    packageName: node.packageName,
    file: node.file,
    range: node.range,
    symbol: node.name
      ? {
          id: String(node.metadata.symbolId ?? node.id),
          name: node.name,
          kind: node.kind,
        }
      : undefined,
    matchedSignals,
    metadata: sanitizeMetadata(node),
    ...overrides,
  };
}

function sanitizeMetadata(node: CodeNode): Record<string, unknown> {
  const { content: _content, ...metadata } = node.metadata as Record<string, unknown>;
  return metadata;
}

function isExactSymbolDefinition(node: CodeNode, symbol: string): boolean {
  return ["Function", "Class", "Interface", "TypeAlias", "Symbol", "Chunk"].includes(node.kind) &&
    (node.name === symbol || node.metadata.qualifiedName === symbol);
}

function rankReferenceResults(symbol: string, results: QueryResultItem[]): QueryResultItem[] {
  return [...results].sort((left, right) =>
    referenceResultScore(symbol, right) - referenceResultScore(symbol, left) ||
    (left.file ?? "").localeCompare(right.file ?? "") ||
    (left.symbol?.name ?? "").localeCompare(right.symbol?.name ?? "") ||
    left.id.localeCompare(right.id),
  );
}

function referenceResultScore(symbol: string, result: QueryResultItem): number {
  const query = symbol.toLowerCase();
  const path = result.file?.toLowerCase() ?? "";
  const name = result.symbol?.name.toLowerCase() ?? "";
  const relationship = result.metadata.relationship as { evidenceSources?: unknown; confidence?: unknown } | undefined;
  const evidence = Array.isArray(relationship?.evidenceSources)
    ? relationship.evidenceSources.filter((source): source is string => typeof source === "string")
    : [];
  let score = 0;
  if (path.includes(query) || name.includes(query)) score += 0.6;
  if (evidence.includes("scip-typescript")) score += 0.6;
  if (evidence.includes("module-resolution")) score += 0.5;
  if (evidence.includes("mutation-to-database")) score += 1.1;
  if (relationship?.confidence === "high") score += 0.4;
  const databaseReferenceQuery = query === "prisma" || query.includes("database") || query === "db";
  if (databaseReferenceQuery && /\/routes?\/|\/api\/|\/route\.[cm]?[jt]sx?$/.test(path)) {
    score += 1.7;
  }
  if (/mutation|service|api-core/.test(path)) score += 0.9;
  if (databaseReferenceQuery && /mutation|api-core/.test(path)) score += 1.45;
  if (databaseReferenceQuery && /\/billing\//.test(path)) score -= 3.5;
  if (result.kind === "Function" || result.kind === "Class" || result.kind === "Symbol") score += 0.35;
  if (result.kind === "Import" || result.kind === "Export") score -= 0.45;
  if (/\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$|\/__tests__\//.test(path)) score -= 0.7;
  if (/\/node_modules\/|\/dist\/|\/generated\//.test(path)) score -= 0.9;
  return score;
}

function pathMetadata(
  node: StoredCodeNode,
  traversal: GraphPathTraversalResult | undefined,
  index: number,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    ...sanitizeMetadata(node),
    pathIndex: index,
  };
  if (!traversal) {
    return metadata;
  }
  metadata.pathRank = traversal.rank;
  metadata.pathScore = traversal.score;
  metadata.pathEdges = traversal.edges.map(({ edge, direction }) => relationshipMetadata(edge.kind, {
    ...edge.metadata,
    traversalDirection: direction,
  }));
  const incomingEdge = traversal.edges[index - 1];
  if (incomingEdge) {
    metadata.incomingPathEdge = relationshipMetadata(incomingEdge.edge.kind, {
      ...incomingEdge.edge.metadata,
      traversalDirection: incomingEdge.direction,
    });
  }
  return metadata;
}

function truncateSource(content: string): string {
  return truncateUtf8Bytes(content, 16_000);
}

function relationshipMetadata(kind: CodeEdge["kind"], metadata: Record<string, unknown>): Record<string, unknown> {
  return {
    kind,
    ...metadata,
    evidenceSources: Array.isArray(metadata.evidenceSources)
      ? metadata.evidenceSources
      : typeof metadata.origin === "string"
        ? [metadata.origin]
        : [],
  };
}

async function resolveEmbeddingProviderForIndex(
  options: QueryEngineOptions,
  snapshotPromise: Promise<ActiveIndexSnapshot>,
): Promise<EmbeddingProvider> {
  const manifest = (await snapshotPromise).manifest;
  const requestedProvider = options.embeddingProviderName
    ? normalizeProviderForCompare(options.embeddingProviderName)
    : undefined;
  const indexedEmbedding = manifest?.embedding;

  if (indexedEmbedding) {
    if (requestedProvider && requestedProvider !== indexedEmbedding.provider) {
      throw new Error(
        `Embedding provider mismatch: index uses ${indexedEmbedding.provider}, query requested ${requestedProvider}`,
      );
    }
    if (options.embeddingModel && options.embeddingModel !== indexedEmbedding.model) {
      throw new Error(
        `Embedding model mismatch: index uses ${indexedEmbedding.model}, query requested ${options.embeddingModel}`,
      );
    }
    if (options.embeddingProvider) {
      validateProviderAgainstIndex(options.embeddingProvider, indexedEmbedding);
      return options.embeddingProvider;
    }
    return createEmbeddingProvider({
      provider: indexedEmbedding.provider,
      model: indexedEmbedding.model,
      indexPath: options.indexPath,
    });
  }

  if (options.embeddingProvider) {
    return options.embeddingProvider;
  }

  return createEmbeddingProvider({
    provider: options.embeddingProviderName,
    model: options.embeddingModel,
    indexPath: options.indexPath,
  });
}

function validateProviderAgainstIndex(
  provider: EmbeddingProvider,
  indexedEmbedding: { provider: string; model: string; dimension: number },
): void {
  if (
    provider.provider !== indexedEmbedding.provider ||
    provider.model !== indexedEmbedding.model ||
    provider.dimension !== indexedEmbedding.dimension
  ) {
    throw new Error(
      `Embedding provider mismatch: index uses ${indexedEmbedding.provider}/${indexedEmbedding.model}/${indexedEmbedding.dimension}, query provider is ${provider.provider}/${provider.model}/${provider.dimension}`,
    );
  }
}

function normalizeProviderForCompare(provider: string): string {
  if (provider === "local-hash-v1") {
    return "hash";
  }
  if (provider === "jinaai/jina-embeddings-v2-base-code") {
    return "jina";
  }
  return provider;
}
