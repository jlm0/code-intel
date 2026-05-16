import type {
  CodeGraphRepository,
  SemanticCodeNode,
  SemanticSearchFilters,
} from "../graph/repository.js";
import {
  addGraphCandidates,
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
  addTestIntentCandidates(candidates, query, allNodes);

  return finalizeCandidates(query, [...candidates.values()], input.limit);
}
