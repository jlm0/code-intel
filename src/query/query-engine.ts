import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { truncateUtf8Bytes } from "../core/text.js";
import { LadybugGraphStore } from "../graph/ladybug-store.js";
import type { CodeGraphRepository, SemanticSearchFilters, StoredCodeNode } from "../graph/repository.js";
import {
  IndexManifestSchema,
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

export function createQueryEngine(options: QueryEngineOptions): QueryEngine {
  return new QueryEngine(
    new LadybugGraphStore(options.indexPath),
    resolveEmbeddingProviderForIndex(options),
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
    const rows = await this.store.semanticSearch(await provider.embed(query), options.limit, {
      repo: options.repo,
      packageName: options.packageName,
      fileKind: options.fileKind,
      symbolKind: options.symbolKind,
    });
    return parseQueryResult({
      schemaVersion,
      query,
      results: rows.map((row) =>
        nodeToResult(row.node, ["vector_similarity"], {
          score: Math.max(0, 1 - row.distance),
        }),
      ),
    });
  }

  async tracePath(fromId: string, toId: string, options: QueryLimitOptions): Promise<QueryResult> {
    const path = await this.store.tracePath(fromId, toId, options.limit);
    return parseQueryResult({
      schemaVersion,
      query: `${fromId} -> ${toId}`,
      results: path.map((node) => nodeToResult(node, ["graph_path"])),
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
      results: rows.map((row) => nodeToResult(row.node, [`graph_${signal}`])),
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

function truncateSource(content: string): string {
  return truncateUtf8Bytes(content, 16_000);
}

async function resolveEmbeddingProviderForIndex(
  options: QueryEngineOptions,
): Promise<EmbeddingProvider> {
  const manifest = await readIndexManifest(options.indexPath);
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

async function readIndexManifest(indexPath: string) {
  try {
    return IndexManifestSchema.parse(
      JSON.parse(await readFile(join(indexPath, "manifest.json"), "utf8")),
    );
  } catch {
    return undefined;
  }
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
