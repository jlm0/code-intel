import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { indexWorkspace } from "../indexer/indexer.js";
import { createQueryEngine } from "../query/query-engine.js";
import {
  schemaVersion,
  type IndexManifest,
  type QueryResult,
  type QueryResultItem,
} from "../schema/schemas.js";
import {
  defaultEvalSuiteId,
  loadEvalPack,
  prepareEvalCorpus,
  type EvalCase,
  type EvalExpectation,
  type EvalFailureClass,
  type EvalPack,
  type PreparedEvalCorpus,
} from "./eval-pack.js";

export interface EvalOptions {
  workspace?: string;
  suite?: string;
  evalPack?: string;
  evalCachePath?: string;
  fetch?: boolean;
  embeddingProvider?: string;
  embeddingModel?: string;
}

export interface EvalReport {
  schemaVersion: typeof schemaVersion;
  status: "pass" | "fail";
  suite: {
    id: string;
    name: string;
    version: string;
    kind: EvalPack["kind"];
    description: string;
    license?: string;
  };
  corpus: {
    type: PreparedEvalCorpus["type"];
    path: string;
    repoPaths: string[];
    source?: PreparedEvalCorpus["source"];
  };
  embedding: {
    provider: string;
    model: string;
    dimension: number;
  };
  index: {
    stats: IndexManifest["stats"];
    repos: IndexManifest["repos"];
  };
  cases: EvalCaseResult[];
}

export interface EvalCaseResult {
  id: string;
  name: string;
  mode: EvalCase["mode"];
  query: string;
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

export async function runEvalSuite(options: EvalOptions = {}): Promise<EvalReport> {
  const workspaceRoot = resolve(options.workspace ?? process.cwd());
  const loadedPack = await loadEvalPack({
    suite: options.evalPack ? options.suite : options.suite ?? defaultEvalSuiteId(),
    evalPackPath: options.evalPack,
    workspaceRoot,
  });
  const corpus = await prepareEvalCorpus({
    loadedPack,
    workspaceRoot,
    evalCachePath: options.evalCachePath,
    fetch: options.fetch,
  });
  const indexPath = await mkdtemp(join(tmpdir(), "code-intel-eval-"));
  try {
    const manifest = await indexWorkspace({
      workspaceRoot: corpus.path,
      repoPaths: corpus.repoPaths,
      indexPath,
      embeddingProviderName: options.embeddingProvider,
      embeddingModel: options.embeddingModel,
    });
    const engine = createQueryEngine({ indexPath });
    try {
      const cases: EvalCaseResult[] = [];
      for (const testCase of loadedPack.cases) {
        cases.push(await runEvalCase(testCase, engine));
      }

      return {
        schemaVersion,
        status: cases.every((testCase) => testCase.status === "pass") ? "pass" : "fail",
        suite: {
          id: loadedPack.pack.id,
          name: loadedPack.pack.name,
          version: loadedPack.pack.version,
          kind: loadedPack.pack.kind,
          description: loadedPack.pack.description,
          license: loadedPack.pack.license,
        },
        corpus,
        embedding: manifest.embedding,
        index: {
          stats: manifest.stats,
          repos: manifest.repos,
        },
        cases,
      };
    } finally {
      await engine.close();
    }
  } finally {
    await rm(indexPath, { recursive: true, force: true });
  }
}

async function runEvalCase(
  testCase: EvalCase,
  engine: ReturnType<typeof createQueryEngine>,
): Promise<EvalCaseResult> {
  const start = performance.now();
  const result = await runQuery(testCase, engine);
  const latencyMs = Math.round(performance.now() - start);
  const expected = testCase.expected.map((expectation) => evaluateExpectation(expectation, result.results));
  const notExpected = testCase.notExpected.map((expectation) => evaluateExpectation(expectation, result.results));
  const status = expected.every(expectationPassed) && notExpected.every((expectation) => !expectation.found)
    ? "pass"
    : "fail";

  return {
    id: testCase.id,
    name: testCase.name,
    mode: testCase.mode,
    query: testCase.query,
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
