import type {
  SemanticCodeNode,
  StoredCodeNode,
} from "../graph/repository.js";
import type { CodeEdge } from "../schema/schemas.js";

export type SemanticQueryIntent = "implementation" | "caller" | "callee" | "imports" | "test" | "app-flow" | "broad";

export interface RankingReason {
  signal: string;
  weight: number;
  detail?: string;
}

export interface RankingDemotion {
  signal: string;
  weight: number;
  detail?: string;
}

export interface RankingExplanation {
  intent: SemanticQueryIntent;
  score: number;
  fusion: {
    rank: number;
    score: number;
    sources: Record<string, number>;
  };
  reasons: RankingReason[];
  demotions: RankingDemotion[];
}

export interface HybridSemanticRow extends SemanticCodeNode {
  signals: string[];
  ranking: RankingExplanation;
}

export interface HybridSemanticCandidate {
  node: StoredCodeNode;
  sourceRanks: Map<string, number>;
  signals: Set<string>;
  reasons: RankingReason[];
  demotions: RankingDemotion[];
  evidenceSources: Set<string>;
  graphEdgeKinds: Set<CodeEdge["kind"]>;
  pairedFromTest?: boolean;
  lexicalScore?: number;
  score: number;
}

export interface QueryModel {
  raw: string;
  intent: SemanticQueryIntent;
  words: string[];
  codeTokens: string[];
  symbolTokens: string[];
}

export const rrfConstant = 60;

export const sourceWeights: Record<string, number> = {
  semantic: 1.2,
  lexical: 1.5,
  symbol: 2,
  graph: 1.5,
  test: 1.4,
  test_pair: 1.3,
};

export const edgeKindsForSemanticGraph: Array<{
  kind: CodeEdge["kind"];
  direction: "incoming" | "outgoing";
  signal: string;
}> = [
  { kind: "CALLS", direction: "incoming", signal: "graph_callers" },
  { kind: "CALLS", direction: "outgoing", signal: "graph_callees" },
  { kind: "REFERENCES", direction: "incoming", signal: "graph_references" },
  { kind: "IMPORTS", direction: "incoming", signal: "graph_imports" },
  { kind: "EXPORTS", direction: "incoming", signal: "graph_exports" },
  { kind: "TESTS", direction: "incoming", signal: "graph_tests" },
  { kind: "TESTS", direction: "outgoing", signal: "graph_test_targets" },
  { kind: "MENTIONS", direction: "incoming", signal: "graph_mentions" },
];
