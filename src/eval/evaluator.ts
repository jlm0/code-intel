import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { indexWorkspace } from "../indexer/indexer.js";
import { createQueryEngine } from "../query/query-engine.js";
import { schemaVersion } from "../schema/schemas.js";

export interface EvalOptions {
  embeddingProvider?: string;
  embeddingModel?: string;
}

export interface EvalReport {
  schemaVersion: typeof schemaVersion;
  status: "pass" | "fail";
  embedding: {
    provider: string;
    model: string;
    dimension: number;
  };
  cases: EvalCaseResult[];
}

export interface EvalCaseResult {
  name: string;
  status: "pass" | "fail";
  expected: string;
  actual: string;
}

export async function runEvalSuite(options: EvalOptions = {}): Promise<EvalReport> {
  const fixturePath = resolveFixturePath();
  const indexPath = await mkdtemp(join(tmpdir(), "code-intel-eval-"));
  try {
    const manifest = await indexWorkspace({
      workspaceRoot: fixturePath,
      repoPaths: [fixturePath],
      indexPath,
      embeddingProviderName: options.embeddingProvider,
      embeddingModel: options.embeddingModel,
    });
    const engine = createQueryEngine({ indexPath });
    const cases: EvalCaseResult[] = [];

    cases.push(
      await expectResultFile({
        name: "exported function",
        expected: "packages/core/src/tithe.ts",
        actual: () => engine.findSymbol("calculateGivingTotal", { limit: 10 }),
      }),
    );
    cases.push(
      await expectResultFile({
        name: "re-exported symbol",
        expected: "packages/core/src/tithe.ts",
        actual: () => engine.findSymbol("formatGivingReceipt", { limit: 10 }),
      }),
    );
    cases.push(
      await expectResultFile({
        name: "path alias import",
        expected: "packages/ui/src/useGivingSummary.tsx",
        actual: () => engine.getReferences("GivingLedger", { limit: 20 }),
      }),
    );
    cases.push(
      await expectResultFile({
        name: "react hook",
        expected: "packages/ui/src/useGivingSummary.tsx",
        actual: () => engine.findSymbol("useGivingSummary", { limit: 10 }),
      }),
    );
    cases.push(
      await expectResultFile({
        name: "class method",
        expected: "packages/core/src/ledger.ts",
        actual: () => engine.findSymbol("summarize", { limit: 10 }),
      }),
    );
    cases.push(
      await expectResultFile({
        name: "caller relationship",
        expected: "packages/core/src/ledger.ts",
        actual: () => engine.getCallers("calculateGivingTotal", { limit: 20 }),
      }),
    );
    cases.push(
      await expectResultFile({
        name: "test relationship",
        expected: "packages/core/src/tithe.test.ts",
        actual: () => engine.getReferences("calculateGivingTotal", { limit: 20 }),
      }),
    );
    cases.push(
      await expectResultFile({
        name: "semantic concept",
        expected: "packages/core/src/tithe.ts",
        actual: () => engine.semanticSearch("giving receipt summary", { limit: 10 }),
      }),
    );

    return {
      schemaVersion,
      status: cases.every((testCase) => testCase.status === "pass") ? "pass" : "fail",
      embedding: manifest.embedding,
      cases,
    };
  } finally {
    await rm(indexPath, { recursive: true, force: true });
  }
}

async function expectResultFile(input: {
  name: string;
  expected: string;
  actual: () => Promise<{ results: Array<{ file?: string }> }>;
}): Promise<EvalCaseResult> {
  const actual = await input.actual();
  const files = actual.results.map((result) => result.file).filter(Boolean);
  return {
    name: input.name,
    status: files.includes(input.expected) ? "pass" : "fail",
    expected: input.expected,
    actual: files.join(", "),
  };
}

function resolveFixturePath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return join(currentDir, "..", "..", "tests", "fixtures", "js-ts-workspace");
}
