import { LadybugGraphStore } from "../graph/ladybug-store.js";
import {
  schemaVersion,
  type CodeEdge,
  type CodeNode,
  type QueryResult,
  type QueryResultItem,
} from "../schema/schemas.js";
import { embedText } from "../vectors/embedding.js";

export interface QueryEngineOptions {
  indexPath: string;
}

export interface QueryLimitOptions {
  limit: number;
}

export function createQueryEngine(options: QueryEngineOptions): QueryEngine {
  return new QueryEngine(new LadybugGraphStore(options.indexPath));
}

export class QueryEngine {
  constructor(private readonly store: LadybugGraphStore) {}

  async findSymbol(name: string, options: QueryLimitOptions): Promise<QueryResult> {
    const nodes = await this.store.getNodes();
    const needle = name.toLowerCase();
    const results = nodes
      .filter((node) => isSymbolLike(node))
      .filter((node) => node.name?.toLowerCase().includes(needle) || node.id === name)
      .slice(0, options.limit)
      .map((node) => nodeToResult(node, ["symbol_name"]));

    return { schemaVersion, query: name, results };
  }

  async getCallers(symbol: string, options: QueryLimitOptions): Promise<QueryResult> {
    return this.relatedTo(symbol, "CALLS", options, "callers");
  }

  async getCallees(symbol: string, options: QueryLimitOptions): Promise<QueryResult> {
    const graph = await this.loadGraph();
    const seeds = resolveSeedNodes(symbol, graph.nodes);
    const results = graph.edges
      .filter((edge) => edge.kind === "CALLS" && seeds.some((seed) => seed.id === edge.fromId))
      .map((edge) => graph.nodeById.get(edge.toId))
      .filter((node): node is CodeNode => Boolean(node))
      .slice(0, options.limit)
      .map((node) => nodeToResult(node, ["graph_calls"]));

    return { schemaVersion, query: symbol, results };
  }

  async getReferences(symbol: string, options: QueryLimitOptions): Promise<QueryResult> {
    return this.relatedTo(symbol, "REFERENCES", options, "references");
  }

  async expandContext(nodeId: string, options: QueryLimitOptions & { depth: number }): Promise<QueryResult> {
    const graph = await this.loadGraph();
    const seen = new Set<string>([nodeId]);
    const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];
    const results: QueryResultItem[] = [];

    while (queue.length > 0 && results.length < options.limit) {
      const current = queue.shift();
      if (!current || current.depth >= options.depth) continue;
      for (const edge of graph.edges.filter((candidate) => candidate.fromId === current.id || candidate.toId === current.id)) {
        const neighborId = edge.fromId === current.id ? edge.toId : edge.fromId;
        if (seen.has(neighborId)) continue;
        seen.add(neighborId);
        const node = graph.nodeById.get(neighborId);
        if (!node) continue;
        results.push(nodeToResult(node, [`graph_${edge.kind.toLowerCase()}`]));
        queue.push({ id: neighborId, depth: current.depth + 1 });
        if (results.length >= options.limit) break;
      }
    }

    return { schemaVersion, query: nodeId, results };
  }

  async getContext(nodeId: string, options: QueryLimitOptions): Promise<QueryResult> {
    const graph = await this.loadGraph();
    const seeds = resolveSeedNodes(nodeId, graph.nodes).slice(0, options.limit);
    return {
      schemaVersion,
      query: nodeId,
      results: seeds.map((node) =>
        nodeToResult(node, ["source_context"], {
          excerpt: typeof node.metadata.content === "string" ? node.metadata.content : undefined,
        }),
      ),
    };
  }

  async semanticSearch(query: string, options: QueryLimitOptions): Promise<QueryResult> {
    const graph = await this.loadGraph();
    const vectorRows = await this.store.vectorSearch(embedText(query), options.limit);
    return {
      schemaVersion,
      query,
      results: vectorRows
        .map((row) => {
          const node = graph.nodeById.get(row.id);
          if (!node) return undefined;
          return nodeToResult(node, ["vector_similarity"], {
            score: Math.max(0, 1 - row.distance),
          });
        })
        .filter((result): result is QueryResultItem => Boolean(result)),
    };
  }

  async tracePath(fromId: string, toId: string, options: QueryLimitOptions): Promise<QueryResult> {
    const graph = await this.loadGraph();
    const path = breadthFirstPath(fromId, toId, graph.edges).slice(0, options.limit);
    return {
      schemaVersion,
      query: `${fromId} -> ${toId}`,
      results: path
        .map((id) => graph.nodeById.get(id))
        .filter((node): node is CodeNode => Boolean(node))
        .map((node) => nodeToResult(node, ["graph_path"])),
    };
  }

  private async relatedTo(
    symbol: string,
    edgeKind: CodeEdge["kind"],
    options: QueryLimitOptions,
    signal: string,
  ): Promise<QueryResult> {
    const graph = await this.loadGraph();
    const seeds = resolveSeedNodes(symbol, graph.nodes);
    const seedIds = new Set(seeds.map((seed) => seed.id));
    const results = graph.edges
      .filter((edge) => edge.kind === edgeKind && seedIds.has(edge.toId))
      .map((edge) => graph.nodeById.get(edge.fromId))
      .filter((node): node is CodeNode => Boolean(node))
      .slice(0, options.limit)
      .map((node) => nodeToResult(node, [`graph_${signal}`]));
    return { schemaVersion, query: symbol, results };
  }

  private async loadGraph(): Promise<{
    nodes: CodeNode[];
    edges: CodeEdge[];
    nodeById: Map<string, CodeNode>;
  }> {
    const nodes = await this.store.getNodes();
    const edges = await this.store.getEdges();
    return {
      nodes,
      edges,
      nodeById: new Map(nodes.map((node) => [node.id, node])),
    };
  }
}

function resolveSeedNodes(seed: string, nodes: CodeNode[]): CodeNode[] {
  const lowered = seed.toLowerCase();
  return nodes.filter(
    (node) =>
      node.id === seed ||
      (isSymbolLike(node) && node.name?.toLowerCase() === lowered) ||
      (isSymbolLike(node) && node.name?.toLowerCase().includes(lowered)),
  );
}

function nodeToResult(
  node: CodeNode,
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
    metadata: node.metadata,
    ...overrides,
  };
}

function isSymbolLike(node: CodeNode): boolean {
  return ["Function", "Class", "Interface", "TypeAlias", "Symbol", "Test"].includes(node.kind);
}

function breadthFirstPath(fromId: string, toId: string, edges: CodeEdge[]): string[] {
  const queue: string[][] = [[fromId]];
  const seen = new Set([fromId]);
  while (queue.length > 0) {
    const path = queue.shift();
    if (!path) continue;
    const current = path.at(-1);
    if (current === toId) return path;
    for (const edge of edges.filter((candidate) => candidate.fromId === current || candidate.toId === current)) {
      const next = edge.fromId === current ? edge.toId : edge.fromId;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return [];
}
