import type {
  AstEvalCase,
  EvalCase,
  EvalExpectation,
  EvalFailureClass,
  EvalGateMetadata,
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
