import type {
  CodeGraphRepository,
  SemanticCodeNode,
  SemanticSearchFilters,
  StoredCodeNode,
} from "../graph/repository.js";
import {
  addAppFlowExpansionCandidates,
  addGraphCandidates,
  addAdjacentSemanticCandidates,
  addRankedCandidates,
  addSymbolCandidates,
  addTestIntentCandidates,
} from "./semantic-ranking-candidates.js";
import {
  addReason,
  buildQueryModel,
  lexicalCandidates,
  passesFilters,
} from "./semantic-ranking-model.js";
import { finalizeCandidates } from "./semantic-ranking-score.js";
import type {
  HybridSemanticCandidate,
  HybridSemanticRow,
} from "./semantic-ranking-types.js";

export type {
  HybridSemanticRow,
  RankingDemotion,
  RankingExplanation,
  RankingReason,
  SemanticQueryIntent,
} from "./semantic-ranking-types.js";

export async function rankHybridSemanticRows(input: {
  store: CodeGraphRepository;
  query: string;
  vectorRows: SemanticCodeNode[];
  limit: number;
  filters: SemanticSearchFilters;
}): Promise<HybridSemanticRow[]> {
  const query = buildQueryModel(input.query);
  const candidates = new Map<string, HybridSemanticCandidate>();
  const allNodes = (await input.store.getNodes()).filter((node) => passesFilters(node, input.filters));
  const lexicalRows = lexicalCandidates(query, allNodes);

  addRankedCandidates({
    candidates,
    rows: input.vectorRows.map((row) => row.node),
    source: "semantic",
    signal: "vector_similarity",
    baseDetail: "semantic vector candidate",
  });
  addRankedCandidates({
    candidates,
    rows: lexicalRows.map((candidate) => candidate.node),
    source: "lexical",
    signal: "lexical_match",
    baseDetail: "path, name, or kind token match",
  });
  for (const lexicalRow of lexicalRows) {
    const current = candidates.get(lexicalRow.node.id);
    if (current) {
      current.lexicalScore = lexicalRow.score;
      addReason(current, "lexical_score", lexicalRow.score, lexicalRow.detail);
    }
  }

  await addSymbolCandidates(input.store, candidates, query, input.filters);
  await addGraphCandidates(input.store, candidates, query, input.filters);
  await addAdjacentSemanticCandidates(input.store, candidates, query, input.filters, allNodes, input.vectorRows.map((row) => row.node));
  if (shouldExpandAppFlowGraph(query)) {
    await addAppFlowExpansionCandidates(
      input.store,
      candidates,
      query,
      input.filters,
      appFlowExpansionSeeds(query, candidates),
    );
  }
  addTestIntentCandidates(candidates, query, allNodes);

  return finalizeCandidates(query, [...candidates.values()], input.limit);
}

function shouldExpandAppFlowGraph(query: ReturnType<typeof buildQueryModel>): boolean {
  return query.intent === "app-flow" ||
    query.words.some((word) => ["route", "api", "mutation", "database", "middleware"].includes(word));
}

function appFlowExpansionSeeds(
  query: ReturnType<typeof buildQueryModel>,
  candidates: Map<string, HybridSemanticCandidate>,
): StoredCodeNode[] {
  return [...candidates.values()]
    .map((candidate) => candidate.node)
    .sort((left, right) =>
      appFlowSeedRank(query, left) - appFlowSeedRank(query, right) ||
      (left.file ?? "").localeCompare(right.file ?? "") ||
      (left.name ?? "").localeCompare(right.name ?? ""),
    );
}

function appFlowSeedRank(query: ReturnType<typeof buildQueryModel>, node: StoredCodeNode): number {
  const path = node.file?.toLowerCase() ?? "";
  const name = node.name?.toLowerCase() ?? "";
  let rank = 100;
  if (query.words.includes("route") && /\/routes?\/|\/api\//.test(path)) rank -= 35;
  if (query.words.includes("mutation") && (path.includes("mutation") || name.includes("mutation"))) rank -= 30;
  if (query.words.includes("mutation") && path.includes("/api-core/")) rank -= 18;
  if ((query.words.includes("api") || query.words.includes("server")) && path.includes("apps/api/")) rank -= 25;
  if ((query.words.includes("database") || query.words.includes("mutation")) && (path.includes("database") || name === "prisma")) rank -= 20;
  if (node.metadata.fileKind === "test" || /\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$/.test(path)) rank += 40;
  if (path.includes("/packages/ui/")) rank += 15;
  if (node.kind === "File") rank += 6;
  if (node.kind === "Chunk") rank += 4;
  return rank;
}
