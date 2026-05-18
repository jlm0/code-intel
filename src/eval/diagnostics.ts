import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { readActiveIndexDiagnostics, type FileLifecycleDiagnostic } from "../diagnostics/index-diagnostics.js";
import type { PreparedEvalCorpus } from "./eval-pack.js";
import type { AstEvalCaseResult, EvalCaseResult, EvalExpectationResult } from "./results.js";

export interface EvalDiagnosticsReport {
  summary: {
    expectedChecked: number;
    notExpectedChecked: number;
    missingFiles: number;
    undiscoveredFiles: number;
    unindexedFiles: number;
    unqueryableSymbols: number;
  };
  preflight: EvalPreflightDiagnostic[];
}

export interface EvalPreflightDiagnostic {
  caseId: string;
  gateId: string;
  expectationKind: "expected" | "notExpected" | "astCase";
  file: string;
  symbol?: string;
  fileExists: boolean;
  discovered: boolean;
  indexed: boolean;
  graphQueryable: boolean;
  symbolQueryable: boolean;
  semanticQueryable: boolean;
  failureClass?: "fetch" | "sparse-checkout" | "discovery" | "ignore" | "tsconfig" | "parse" | "AST" | "SCIP" | "fusion" | "graph" | "embedding" | "query" | "ranking";
  evidence: Record<string, unknown>;
}

export async function buildEvalDiagnostics(input: {
  corpus: PreparedEvalCorpus;
  cases: EvalCaseResult[];
  astCases: AstEvalCaseResult[];
  indexPath: string;
}): Promise<EvalDiagnosticsReport> {
  const indexDiagnostics = await readActiveIndexDiagnostics(input.indexPath);
  const filesByPath = new Map((indexDiagnostics?.files ?? []).map((file) => [file.relativePath, file]));
  const preflight: EvalPreflightDiagnostic[] = [];

  for (const testCase of input.cases) {
    for (const expectation of testCase.expected) {
      preflight.push(await preflightExpectation({
        corpus: input.corpus,
        filesByPath,
        testCase,
        expectation,
        expectationKind: "expected",
        expectationResult: testCase.expected.find((result) => sameExpectation(result, expectation)),
      }));
    }
    for (const expectation of testCase.notExpected) {
      preflight.push(await preflightExpectation({
        corpus: input.corpus,
        filesByPath,
        testCase,
        expectation,
        expectationKind: "notExpected",
        expectationResult: testCase.notExpected.find((result) => sameExpectation(result, expectation)),
      }));
    }
  }

  for (const astCase of input.astCases) {
    const fileDiagnostic = diagnosticForFile(filesByPath, astCase.file);
    const fileExists = await evalFileExists(input.corpus, astCase.file);
    preflight.push({
      caseId: astCase.id,
      gateId: astCase.gate.id,
      expectationKind: "astCase",
      file: astCase.file,
      fileExists,
      discovered: Boolean(fileDiagnostic),
      indexed: fileDiagnostic?.status === "indexed",
      graphQueryable: fileDiagnostic?.queryability.exact === true,
      symbolQueryable: fileDiagnostic?.queryability.symbol === true,
      semanticQueryable: fileDiagnostic?.queryability.semantic === true,
      failureClass: classifyPreflightFailure({
        corpus: input.corpus,
        fileExists,
        fileDiagnostic,
        mode: "find-symbol",
        expectationResult: undefined,
      }),
      evidence: {
        lifecycle: fileDiagnostic?.lifecycle,
        counts: fileDiagnostic?.counts,
      },
    });
  }

  return {
    summary: {
      expectedChecked: preflight.filter((item) => item.expectationKind === "expected").length,
      notExpectedChecked: preflight.filter((item) => item.expectationKind === "notExpected").length,
      missingFiles: preflight.filter((item) => !item.fileExists).length,
      undiscoveredFiles: preflight.filter((item) => item.fileExists && !item.discovered).length,
      unindexedFiles: preflight.filter((item) => item.discovered && !item.indexed).length,
      unqueryableSymbols: preflight.filter((item) => item.symbol && !item.symbolQueryable).length,
    },
    preflight,
  };
}

async function preflightExpectation(input: {
  corpus: PreparedEvalCorpus;
  filesByPath: Map<string, FileLifecycleDiagnostic>;
  testCase: EvalCaseResult;
  expectation: EvalExpectationResult;
  expectationKind: "expected" | "notExpected";
  expectationResult?: EvalExpectationResult;
}): Promise<EvalPreflightDiagnostic> {
  const fileDiagnostic = diagnosticForFile(input.filesByPath, input.expectation.file);
  const fileExists = await evalFileExists(input.corpus, input.expectation.file);
  const failureClass = input.expectationKind === "notExpected" && input.expectationResult?.found === false
    ? undefined
    : classifyPreflightFailure({
        corpus: input.corpus,
        fileExists,
        fileDiagnostic,
        mode: input.testCase.mode,
        expectationResult: input.expectationResult,
      });
  return {
    caseId: input.testCase.id,
    gateId: input.testCase.gate.id,
    expectationKind: input.expectationKind,
    file: input.expectation.file,
    symbol: input.expectation.symbol,
    fileExists,
    discovered: Boolean(fileDiagnostic),
    indexed: fileDiagnostic?.status === "indexed",
    graphQueryable: fileDiagnostic?.queryability.exact === true,
    symbolQueryable: input.expectation.symbol ? fileDiagnostic?.queryability.symbol === true : true,
    semanticQueryable: fileDiagnostic?.queryability.semantic === true,
    failureClass,
    evidence: {
      rank: input.expectationResult?.rank,
      found: input.expectationResult?.found,
      maxRank: input.expectation.maxRank,
      lifecycle: fileDiagnostic?.lifecycle,
      counts: fileDiagnostic?.counts,
      queryability: fileDiagnostic?.queryability,
    },
  };
}

function classifyPreflightFailure(input: {
  corpus: PreparedEvalCorpus;
  fileExists: boolean;
  fileDiagnostic?: FileLifecycleDiagnostic;
  mode: EvalCaseResult["mode"];
  expectationResult?: EvalExpectationResult;
}): EvalPreflightDiagnostic["failureClass"] {
  if (!input.fileExists) {
    return input.corpus.type === "git" ? "sparse-checkout" : "fetch";
  }
  if (!input.fileDiagnostic) {
    return "discovery";
  }
  if (input.fileDiagnostic.lifecycle.ignore?.status === "fail") return "ignore";
  if (input.fileDiagnostic.lifecycle.tsconfig?.status === "fail") return "tsconfig";
  if (input.fileDiagnostic.lifecycle.parse?.status === "fail") return "parse";
  if (input.fileDiagnostic.lifecycle.ast?.status === "fail") return "AST";
  if (input.fileDiagnostic.lifecycle.scip?.status === "fail") return "SCIP";
  if (input.fileDiagnostic.lifecycle.graph?.status !== "pass") return "graph";
  if (input.mode === "semantic" && input.fileDiagnostic.lifecycle.embeddings?.status !== "pass") return "embedding";
  if (!input.expectationResult || input.expectationResult.found && (!input.expectationResult.maxRank || (input.expectationResult.rank ?? 0) <= input.expectationResult.maxRank)) {
    return undefined;
  }
  if (input.expectationResult.found) return "ranking";
  return input.mode === "semantic" ? "ranking" : input.mode === "find-symbol" ? "query" : "graph";
}

async function evalFileExists(corpus: PreparedEvalCorpus, file: string): Promise<boolean> {
  if (file.includes("*")) {
    const files = await corpusFiles(corpus.repoPaths);
    return files.some((candidate) => pathMatches(file, candidate));
  }
  for (const repoPath of corpus.repoPaths) {
    try {
      if ((await stat(join(repoPath, file))).isFile()) return true;
    } catch {
      // Try the next repo path.
    }
  }
  return false;
}

function diagnosticForFile(
  filesByPath: Map<string, FileLifecycleDiagnostic>,
  file: string,
): FileLifecycleDiagnostic | undefined {
  if (!file.includes("*")) return filesByPath.get(file);
  return [...filesByPath.values()].find((candidate) => pathMatches(file, candidate.relativePath));
}

async function corpusFiles(repoPaths: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const repoPath of repoPaths) {
    await collectFiles(repoPath, repoPath, files);
  }
  return files;
}

async function collectFiles(root: string, current: string, files: string[]): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(root, path, files);
    } else if (entry.isFile()) {
      files.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
}

function pathMatches(pattern: string, file: string): boolean {
  return pattern.includes("*") ? globToRegExp(pattern).test(file) : pattern === file;
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
      source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function sameExpectation(left: EvalExpectationResult, right: EvalExpectationResult): boolean {
  return left.file === right.file && left.symbol === right.symbol && left.kind === right.kind;
}
