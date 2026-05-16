import type {
  AstEvalCase,
  EvalCase,
  EvalExpectation,
  EvalFailureClass,
  EvalGateMetadata,
  GraphCheck,
  GraphEdgeKind,
} from "./eval-pack.js";

export interface EvalCaseResult {
  id: string;
  name: string;
  mode: EvalCase["mode"];
  query: string;
  gate: EvalGateMetadata;
  status: "pass" | "fail";
  latencyMs: number;
  expected: EvalExpectationResult[];
  notExpected: EvalExpectationResult[];
  actual: {
    resultCount: number;
    topResults: Array<{
      file?: string;
      symbol?: string;
      kind: string;
      score?: number;
    }>;
  };
  failureClass?: EvalFailureClass;
}

export interface EvalExpectationResult extends EvalExpectation {
  found: boolean;
  rank?: number;
}

export interface AstEvalCaseResult {
  id: string;
  name: string;
  file: string;
  gate: EvalGateMetadata;
  status: "pass" | "fail";
  expected: Record<string, AstFactExpectationResult[]>;
  actual: {
    hasParseError: boolean;
    counts: Record<string, number>;
  };
  failureClass?: EvalFailureClass;
}

export interface AstFactExpectationResult {
  expected: Record<string, unknown>;
  found: boolean;
}

export type AstFactExpectations = AstEvalCase["expected"];

export interface GraphPathNodeResult {
  id: string;
  file?: string;
  symbol?: string;
  kind: string;
}

export interface GraphPathEdgeResult {
  kind: GraphEdgeKind;
  evidenceSources: string[];
  origin?: string;
  confidence?: string;
}

export interface GraphEvalCaseResult {
  id: string;
  name: string;
  gate: EvalGateMetadata;
  status: "pass" | "fail";
  check: GraphCheck;
  latencyMs: number;
  actual: {
    nodesResolved: {
      from?: number;
      to?: number;
      sequence?: number[];
    };
    edges?: GraphPathEdgeResult[];
    path?: GraphPathNodeResult[];
    rank?: number;
    issue?: string;
  };
  expected?: unknown;
  failureClass?: EvalFailureClass;
}
