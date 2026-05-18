import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { loadEvalPack } from "../../src/eval/eval-pack.js";
import { runEvalSuite } from "../../src/eval/evaluator.js";

describe("eval gates", () => {
  it("parses gate metadata from query and AST eval cases", async () => {
    const loadedPack = await loadEvalPack({
      suite: "oss-rallly-app-flow",
      workspaceRoot: process.cwd(),
    });

    expect(loadedPack.cases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "rallly.create-poll-route-reference",
          gate: {
            id: "rallly.required.package-boundary-route-to-mutation",
            status: "required",
            capability: "package-boundary route-to-mutation",
            layer: "fusion",
          },
        }),
        expect.objectContaining({
          id: "rallly.create-poll-api-flow",
          gate: expect.objectContaining({
            status: "target",
            capability: "route-to-mutation",
            layer: "app-flow",
          }),
        }),
      ]),
    );
    expect(loadedPack.astCases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "rallly.ast.api-route",
          gate: expect.objectContaining({
            status: "required",
            capability: "route-to-mutation",
            layer: "AST",
          }),
        }),
      ]),
    );
  });

  it("keeps target and scoreboard failures out of the blocking status", async () => {
    const packRoot = await mkdtemp(join(tmpdir(), "code-intel-gated-eval-pack-"));
    const fixturePath = resolve("tests/fixtures/js-ts-workspace");
    try {
      await mkdir(join(packRoot, "cases"), { recursive: true });
      await writeFile(join(packRoot, "pack.json"), JSON.stringify(createTestPack(fixturePath), null, 2));
      await writeFile(join(packRoot, "cases", "cases.json"), JSON.stringify(createGateCases(), null, 2));

      const report = await runEvalSuite({
        evalPack: join(packRoot, "pack.json"),
        embeddingProvider: "hash",
      });

      expect(report.status).toBe("pass");
      expect(report.blockingStatus).toBe("pass");
      expect(report.qualityStatus).toBe("fail");
      expect(report.summary.gateStatuses.required).toMatchObject({
        total: 1,
        failed: 0,
        blocking: true,
        resultStatus: "pass",
      });
      expect(report.summary.gateStatuses.target).toMatchObject({
        total: 1,
        failed: 1,
        blocking: false,
        resultStatus: "fail",
      });
      expect(report.summary.gateStatuses.scoreboard).toMatchObject({
        total: 1,
        failed: 1,
        blocking: false,
        resultStatus: "fail",
      });
      expect(report.summary.gates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "target.ranking",
            gateStatus: "target",
            blocking: false,
            resultStatus: "fail",
            rank: expect.objectContaining({
              expectedMissing: 1,
              recallAtK: 0,
              mrrAt10: 0,
            }),
          }),
        ]),
      );
      expect(report.summary.failureClasses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            failureClass: "ranking",
            count: 1,
            blockingCount: 0,
            caseIds: ["gated.target-fail"],
          }),
          expect.objectContaining({
            failureClass: "graph",
            count: 1,
            blockingCount: 0,
            caseIds: ["gated.scoreboard-fail"],
          }),
        ]),
      );
    } finally {
      await rm(packRoot, { recursive: true, force: true });
    }
  });

  it("adds diagnostics preflight for expected and notExpected eval files", async () => {
    const report = await runEvalSuite({
      suite: "js-ts-general",
      embeddingProvider: "hash",
      diagnostics: true,
    });

    const preflight = report.diagnostics?.preflight ?? [];
    expect(preflight).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          caseId: "synthetic.exported-function",
          expectationKind: "expected",
          file: "packages/core/src/tithe.ts",
          fileExists: true,
          discovered: true,
          indexed: true,
          graphQueryable: true,
          symbolQueryable: true,
          semanticQueryable: true,
          failureClass: undefined,
        }),
        expect.objectContaining({
          caseId: "synthetic.false-positive-guard",
          expectationKind: "notExpected",
          file: "packages/core/src/duplicateMethods.ts",
          fileExists: true,
          discovered: true,
          indexed: true,
        }),
      ]),
    );
    expect(report.diagnostics?.summary).toMatchObject({
      expectedChecked: expect.any(Number),
      notExpectedChecked: expect.any(Number),
      missingFiles: 0,
    });
  });
});

function createTestPack(fixturePath: string): Record<string, unknown> {
  return {
    schemaVersion: "code-intel.eval-pack.v1",
    id: "gated-test-pack",
    name: "Gated Test Pack",
    version: "1.0.0",
    kind: "synthetic",
    description: "Fixture pack for gate status behavior.",
    corpus: {
      type: "local",
      path: fixturePath,
      repoPaths: ["."],
    },
    caseFiles: ["cases/cases.json"],
  };
}

function createGateCases(): Array<Record<string, unknown>> {
  return [
    {
      id: "gated.required-pass",
      name: "Required symbol pass",
      mode: "find-symbol",
      query: "calculateGivingTotal",
      limit: 10,
      gate: {
        id: "required.symbols",
        status: "required",
        capability: "symbol-definition",
        layer: "SCIP",
      },
      expected: [
        {
          file: "packages/core/src/tithe.ts",
          symbol: "calculateGivingTotal",
          maxRank: 3,
        },
      ],
      failureClassHint: "query",
    },
    {
      id: "gated.target-fail",
      name: "Target ranking failure",
      mode: "semantic",
      query: "unimplemented app flow target",
      limit: 5,
      gate: {
        id: "target.ranking",
        status: "target",
        capability: "full-app-flow",
        layer: "ranking",
      },
      expected: [
        {
          file: "packages/core/src/does-not-exist.ts",
          maxRank: 1,
        },
      ],
      failureClassHint: "ranking",
    },
    {
      id: "gated.scoreboard-fail",
      name: "Scoreboard graph traversal failure",
      mode: "callers",
      query: "missingSymbol",
      limit: 5,
      gate: {
        id: "scoreboard.graph",
        status: "scoreboard",
        capability: "graph-traversal-quality",
        layer: "graph",
      },
      expected: [
        {
          file: "packages/core/src/does-not-exist.ts",
          maxRank: 1,
        },
      ],
      failureClassHint: "graph",
    },
  ];
}
