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
  constructor(
    private readonly store: CodeGraphRepository,
    private readonly embeddingProvider: Promise<EmbeddingProvider>,
  ) {}

  async close(): Promise<void> {
    await this.store.close();
  }

  getRepository(): CodeGraphRepository {
    return this.store;
  }

  async findSymbol(name: string, options: QueryLimitOptions): Promise<QueryResult> {
    const nodes = await this.store.findSymbols(name, options.limit);
    return parseQueryResult({
      schemaVersion,
      query: name,
      results: nodes.map((node) => nodeToResult(node, ["symbol_name"])),
    });
  }

  async getCallers(symbol: string, options: QueryLimitOptions): Promise<QueryResult> {
    return this.relatedTo(symbol, "CALLS", "incoming", options, "callers");
  }

  async getCallees(symbol: string, options: QueryLimitOptions): Promise<QueryResult> {
    return this.relatedTo(symbol, "CALLS", "outgoing", options, "callees");
  }

  async getReferences(symbol: string, options: QueryLimitOptions): Promise<QueryResult> {
    return this.relatedTo(symbol, "REFERENCES", "incoming", options, "references");
  }

  async expandContext(nodeId: string, options: QueryLimitOptions & { depth: number }): Promise<QueryResult> {
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
  }

  async getContext(nodeId: string, options: QueryLimitOptions): Promise<QueryResult> {
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
  }

  async semanticSearch(query: string, options: SemanticQueryOptions): Promise<QueryResult> {
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
        }),
      ),
    });
  }

  async tracePath(fromId: string, toId: string, options: TracePathOptions): Promise<QueryResult> {
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
