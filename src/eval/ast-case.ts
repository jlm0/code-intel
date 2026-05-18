import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { extractSourceFileFacts } from "../treesitter/chunker.js";
import type { AstEvalCase, PreparedEvalCorpus } from "./eval-pack.js";
import type {
  AstEvalCaseResult,
  AstFactExpectationResult,
  AstFactExpectations,
} from "./results.js";

export async function runAstEvalCase(
  testCase: AstEvalCase,
  corpus: PreparedEvalCorpus,
): Promise<AstEvalCaseResult> {
  let facts: ReturnType<typeof extractSourceFileFacts>;
  try {
    facts = extractSourceFileFacts({
      relativePath: testCase.file,
      content: await readFile(join(corpus.path, testCase.file), "utf8"),
    });
  } catch {
    return {
      id: testCase.id,
      name: testCase.name,
      file: testCase.file,
      gate: testCase.gate,
      status: "fail",
      expected: evaluateAstExpectations(testCase.expected, emptyAstFactGroups()),
      actual: {
        hasParseError: true,
        counts: {},
      },
      failureClass: "discovery",
    };
  }

  const factGroups = {
    imports: facts.imports,
    exports: facts.exports,
    declarations: facts.declarations,
    calls: facts.calls,
    memberAccesses: facts.memberAccesses,
    typeReferences: facts.typeReferences,
    ownerships: facts.ownerships,
    testCases: facts.testCases,
    callbacks: facts.callbacks,
  };
  const expected = evaluateAstExpectations(
    testCase.expected,
    factGroups as unknown as Record<string, Array<Record<string, unknown>>>,
  );
  const status = Object.values(expected).flat().every((result) => result.found) ? "pass" : "fail";
  return {
    id: testCase.id,
    name: testCase.name,
    file: testCase.file,
    gate: testCase.gate,
    status,
    expected,
    actual: {
      hasParseError: facts.hasParseError,
      counts: Object.fromEntries(
        Object.entries(factGroups).map(([name, group]) => [name, group.length]),
      ),
    },
    failureClass: status === "pass" ? undefined : "chunking",
  };
}

function evaluateAstExpectations(
  expected: AstFactExpectations,
  factGroups: Record<string, Array<Record<string, unknown>>>,
): Record<string, AstFactExpectationResult[]> {
  return Object.fromEntries(
    Object.entries(expected).map(([groupName, expectations]) => [
      groupName,
      expectations.map((expectation) => ({
        expected: expectation,
        found: (factGroups[groupName] ?? []).some((fact) => matchesPartialFact(fact, expectation)),
      })),
    ]),
  );
}

function emptyAstFactGroups(): Record<string, Array<Record<string, unknown>>> {
  return {
    imports: [],
    exports: [],
    declarations: [],
    calls: [],
    memberAccesses: [],
    typeReferences: [],
    ownerships: [],
    testCases: [],
    callbacks: [],
  };
}

function matchesPartialFact(fact: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => fact[key] === value);
}
