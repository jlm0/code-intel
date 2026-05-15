import type {
  CodeGraphRepository,
  RelatedCodeNode,
  SemanticCodeNode,
  SemanticSearchFilters,
  StoredCodeNode,
} from "../graph/repository.js";

export interface HybridSemanticRow extends SemanticCodeNode {
  signals: string[];
}

interface HybridSemanticCandidate {
  node: StoredCodeNode;
  score: number;
  signals: Set<string>;
}

export async function rankHybridSemanticRows(input: {
  store: CodeGraphRepository;
  query: string;
  vectorRows: SemanticCodeNode[];
  limit: number;
  filters: SemanticSearchFilters;
}): Promise<HybridSemanticRow[]> {
  const candidates = new Map<string, HybridSemanticCandidate>();
  const addCandidate = (node: StoredCodeNode, score: number, signal: string) => {
    if (!passesFilters(node, input.filters)) {
      return;
    }
    const existing = candidates.get(node.id);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      existing.signals.add(signal);
    } else {
      candidates.set(node.id, {
        node,
        score,
        signals: new Set([signal]),
      });
    }
  };

  for (const row of input.vectorRows) {
    addCandidate(row.node, Math.max(0, 1 - row.distance), "vector_similarity");
  }

  for (const token of semanticGraphTokens(input.query)) {
    for (const symbol of await input.store.findSymbols(token, 5)) {
      addCandidate(symbol, 0.82, "symbol_text");
    }
    for (const related of await graphSemanticNeighbors(input.store, token, 12)) {
      addCandidate(related.node, graphNeighborScore(related), `graph_${related.edgeKind.toLowerCase()}`);
    }
  }

  return [...candidates.values()]
    .map((candidate) => ({
      node: candidate.node,
      distance: Math.max(0, 1 - hybridSemanticScore(input.query, candidate)),
      signals: [...candidate.signals].sort(),
    }))
    .sort((left, right) => left.distance - right.distance || (left.node.file ?? "").localeCompare(right.node.file ?? ""))
    .slice(0, input.limit);
}

async function graphSemanticNeighbors(
  store: CodeGraphRepository,
  token: string,
  limit: number,
): Promise<RelatedCodeNode[]> {
  const [callers, callees, references] = await Promise.all([
    store.getRelatedNodes(token, "CALLS", "incoming", limit),
    store.getRelatedNodes(token, "CALLS", "outgoing", limit),
    store.getRelatedNodes(token, "REFERENCES", "incoming", limit),
  ]);
  return [...callers, ...callees, ...references];
}

function graphNeighborScore(row: RelatedCodeNode): number {
  let score = 0.7;
  if (row.edgeKind === "CALLS") score += 0.08;
  if (row.edgeMetadata.confidence === "high") score += 0.04;
  if (Array.isArray(row.edgeMetadata.evidenceSources) && row.edgeMetadata.evidenceSources.includes("scip-typescript")) {
    score += 0.03;
  }
  return Math.min(score, 0.9);
}

function hybridSemanticScore(query: string, candidate: HybridSemanticCandidate): number {
  let score = candidate.score;
  const normalizedQuery = query.toLowerCase();
  const file = candidate.node.file?.toLowerCase() ?? "";
  const name = candidate.node.name?.toLowerCase() ?? "";
  const metadata = candidate.node.metadata;

  for (const token of queryWords(query)) {
    if (file.includes(token)) score += 0.018;
    if (name.includes(token)) score += 0.024;
  }
  if (candidate.signals.has("symbol_text")) score += 0.04;
  if ([...candidate.signals].some((signal) => signal.startsWith("graph_"))) score += 0.08;
  if (normalizedQuery.includes("route") && /(^|\/)(routes?|api)\//.test(file)) score += 0.08;
  if (normalizedQuery.includes("api") && file.includes("/api/")) score += 0.04;
  if (normalizedQuery.includes("dashboard") && file.includes("dashboard")) score += 0.28;
  if (normalizedQuery.includes("private") && file.includes("private")) score += 0.12;
  if (
    (normalizedQuery.includes("mutation") || normalizedQuery.includes("create") || normalizedQuery.includes("delete")) &&
    file.includes("mutations")
  ) {
    score += 0.08;
  }
  if (
    (normalizedQuery.includes("database") || normalizedQuery.includes("record") || normalizedQuery.includes("db")) &&
    (file.includes("database") || name === "prisma")
  ) {
    score += 0.08;
  }
  if ((normalizedQuery.includes("test") || normalizedQuery.includes("tests")) && metadata.fileKind === "test") {
    score += 0.08;
  }
  if (!normalizedQuery.includes("schema") && !normalizedQuery.includes("params") && /(schema|params|input)$/.test(name)) {
    score -= 0.08;
  }
  return Math.max(0, Math.min(score, 0.99));
}

function semanticGraphTokens(query: string): string[] {
  const words = queryWords(query);
  const tokens = new Set(
    query
      .match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g)
      ?.filter((token) => /[A-Z0-9_$]/.test(token) && token.length >= 4) ?? [],
  );
  for (let index = 0; index < words.length - 1; index += 1) {
    tokens.add(camelize(words.slice(index, index + 2)));
  }
  for (let index = 0; index < words.length - 2; index += 1) {
    tokens.add(camelize(words.slice(index, index + 3)));
  }
  if (words.includes("app") && (words.includes("route") || words.includes("handler") || words.includes("api"))) {
    tokens.add("app");
  }
  return [...tokens].filter((token) => token === "app" || token.length >= 4).slice(0, 18);
}

function queryWords(query: string): string[] {
  return query
    .match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g)
    ?.map((token) => token.toLowerCase())
    .filter((token) => token.length > 2) ?? [];
}

function camelize(words: string[]): string {
  return words
    .map((word, index) => index === 0 ? word : `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join("");
}

function passesFilters(node: StoredCodeNode, filters: SemanticSearchFilters): boolean {
  if (filters.repo && node.repo !== filters.repo) return false;
  if (filters.packageName && node.packageName !== filters.packageName) return false;
  if (filters.fileKind && node.metadata.fileKind !== filters.fileKind) return false;
  if (filters.symbolKind && node.metadata.symbolKind !== filters.symbolKind) return false;
  return true;
}

