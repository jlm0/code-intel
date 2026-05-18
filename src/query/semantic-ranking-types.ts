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
  paths: RankingPathExplanation[];
}

export interface RankingPathNode {
  id: string;
  kind: StoredCodeNode["kind"];
  file?: string;
  symbol?: string;
}

export interface RankingPathEdge {
  kind: CodeEdge["kind"];
  fromId: string;
  toId: string;
  direction: "outgoing" | "incoming";
  evidenceSources: string[];
  confidence?: string;
  fallbackReason?: string;
  relationship?: string;
}

export interface RankingPathExplanation {
  score: number;
  reason: string;
  nodes: RankingPathNode[];
  edges: RankingPathEdge[];
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
  paths?: RankingPathExplanation[];
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
  path: 2.2,
  test: 1.4,
  test_pair: 1.3,
};

export const pathRankingWeights = {
  edgeKind: {
    CALLS: 0.72,
    TESTS: 0.62,
    REFERENCES: 0.44,
    IMPORTS: 0.28,
    EXPORTS: 0.28,
    EXTENDS: 0.22,
    IMPLEMENTS: 0.22,
    DEPENDS_ON: 0.2,
    MENTIONS: 0.04,
    CONTAINS: 0.08,
    DEFINES: 0.12,
    HAS_CHUNK: 0.08,
  } satisfies Record<CodeEdge["kind"], number>,
  evidence: {
    "scip-typescript": 0.38,
    "module-resolution": 0.34,
    "tree-sitter-call": 0.28,
    "tree-sitter-member-call": 0.28,
    "tree-sitter-test": 0.22,
    "test-linking-indirect": 0.16,
  },
  confidence: {
    high: 0.28,
    medium: 0.16,
    fallback: -0.18,
  },
  nodeRole: {
    routeHandler: 0.9,
    page: 0.66,
    service: 0.52,
    database: 0.52,
    middleware: 0.42,
    test: 0.4,
    executable: 0.34,
    file: 0.12,
  },
  conceptCoverage: 0.14,
  seedRelevance: 0.18,
  representativeOwner: 1.25,
  pathLengthPenalty: 0.1,
  incomingPenalty: 0.08,
  fallbackPenalty: 0.22,
  unresolvedPenalty: 0.42,
  weakMentionPenalty: 0.5,
} as const;

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
