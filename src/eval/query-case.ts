import { createQueryEngine } from "../query/query-engine.js";
import type { QueryResult, QueryResultItem } from "../schema/schemas.js";
import type { EvalCase, EvalExpectation, EvalFailureClass } from "./eval-pack.js";
import type { EvalCaseResult, EvalExpectationResult } from "./results.js";

export async function runEvalCase(
  testCase: EvalCase,
  engine: ReturnType<typeof createQueryEngine>,
): Promise<EvalCaseResult> {
  const start = performance.now();
  const result = await runQuery(testCase, engine);
  const latencyMs = Math.round(performance.now() - start);
  const expected = testCase.expected.map((expectation) => evaluateExpectation(expectation, result.results));
  const notExpected = testCase.notExpected.map((expectation) => evaluateExpectation(expectation, result.results));
  const status = expected.every(expectationPassed) && notExpected.every(notExpectationPassed)
    ? "pass"
    : "fail";

  return {
    id: testCase.id,
    name: testCase.name,
    mode: testCase.mode,
    query: testCase.query,
    gate: testCase.gate,
    status,
    latencyMs,
    expected,
    notExpected,
    actual: {
      resultCount: result.results.length,
      topResults: result.results.slice(0, 10).map((item) => ({
        file: item.file,
        symbol: item.symbol?.name,
        kind: item.kind,
        score: item.score,
      })),
    },
    failureClass: status === "pass" ? undefined : classifyFailure(testCase, expected, notExpected),
  };
}

async function runQuery(
  testCase: EvalCase,
  engine: ReturnType<typeof createQueryEngine>,
): Promise<QueryResult> {
  switch (testCase.mode) {
    case "find-symbol":
      return engine.findSymbol(testCase.query, { limit: testCase.limit });
    case "references":
      return engine.getReferences(testCase.query, { limit: testCase.limit });
    case "callers":
      return engine.getCallers(testCase.query, { limit: testCase.limit });
    case "callees":
      return engine.getCallees(testCase.query, { limit: testCase.limit });
    case "semantic":
      return engine.semanticSearch(testCase.query, { limit: testCase.limit });
  }
}

function evaluateExpectation(
  expectation: EvalExpectation,
  results: QueryResultItem[],
): EvalExpectationResult {
  const rank = results.findIndex((result) => resultMatchesExpectation(result, expectation));
  return {
    ...expectation,
    found: rank >= 0,
    rank: rank >= 0 ? rank + 1 : undefined,
  };
}

function expectationPassed(expectation: EvalExpectationResult): boolean {
  if (!expectation.found) {
    return false;
  }
  return !expectation.maxRank || (expectation.rank ?? Number.POSITIVE_INFINITY) <= expectation.maxRank;
}

function notExpectationPassed(expectation: EvalExpectationResult): boolean {
  if (!expectation.found) {
    return true;
  }
  return Boolean(expectation.maxRank && (expectation.rank ?? 0) > expectation.maxRank);
}

function resultMatchesExpectation(result: QueryResultItem, expectation: EvalExpectation): boolean {
  if (!result.file || !pathMatches(expectation.file, result.file)) {
    return false;
  }
  if (expectation.symbol && result.symbol?.name !== expectation.symbol) {
    return false;
  }
  if (expectation.kind && result.kind !== expectation.kind) {
    return false;
  }
  return true;
}

function pathMatches(pattern: string, file: string): boolean {
  if (!pattern.includes("*")) {
    return pattern === file;
  }
  return globToRegExp(pattern).test(file);
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function classifyFailure(
  testCase: EvalCase,
  expected: EvalExpectationResult[],
  notExpected: EvalExpectationResult[],
): EvalFailureClass {
  if (notExpected.some((expectation) => expectation.found)) {
    return "ranking";
  }
  if (expected.some((expectation) => expectation.found && !expectationPassed(expectation))) {
    return "ranking";
  }
  return testCase.failureClassHint ?? defaultFailureClass(testCase.mode);
}

function defaultFailureClass(mode: EvalCase["mode"]): EvalFailureClass {
  if (mode === "semantic") {
    return "embedding";
  }
  if (mode === "find-symbol") {
    return "query";
  }
  return "graph";
}
