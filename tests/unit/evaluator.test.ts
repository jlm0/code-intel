import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadEvalPack } from "../../src/eval/eval-pack.js";
import { runEvalSuite } from "../../src/eval/evaluator.js";

describe("runEvalSuite", () => {
  it("reports pack identity, ranks, latency, and false-positive guards", async () => {
    const report = await runEvalSuite({
      suite: "js-ts-general",
      embeddingProvider: "hash",
    } as Parameters<typeof runEvalSuite>[0] & { suite: string });

    expect(report.status).toBe("pass");
    expect(report.blockingStatus).toBe("pass");
    expect(report.qualityStatus).toBe("pass");
    expect(report.suite).toMatchObject({
      id: "js-ts-general",
      kind: "synthetic",
    });
    expect(report.summary).toMatchObject({
      blockingStatus: "pass",
      qualityStatus: "pass",
      gateStatuses: {
        required: {
          blocking: true,
          resultStatus: "pass",
        },
      },
    });
    expect(report.corpus).toMatchObject({
      type: "local",
    });
    expect(report.cases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "synthetic.semantic-concept",
          mode: "semantic",
          gate: expect.objectContaining({
            status: "required",
            capability: "semantic-concept-retrieval",
            layer: "ranking",
          }),
          failureClass: undefined,
          expected: expect.arrayContaining([
            expect.objectContaining({
              file: "packages/core/src/tithe.ts",
              found: true,
              rank: expect.any(Number),
            }),
          ]),
          metrics: expect.objectContaining({
            mrrAt10: expect.any(Number),
            recallAtK: expect.any(Number),
            ndcgAt10: expect.any(Number),
          }),
          latencyMs: expect.any(Number),
        }),
        expect.objectContaining({
          id: "synthetic.false-positive-guard",
          notExpected: expect.arrayContaining([
            expect.objectContaining({
              file: "packages/core/src/duplicateMethods.ts",
              found: false,
            }),
          ]),
        }),
      ]),
    );
    expect(report.summary.gateStatuses.required.rank).toMatchObject({
      mrrAt10: expect.any(Number),
      recallAtK: 1,
      ndcgAt10: expect.any(Number),
    });
  });

  it("does not fetch the Rallly pack unless explicitly requested", async () => {
    const evalCachePath = await mkdtemp(join(tmpdir(), "code-intel-eval-cache-"));
    try {
      await expect(
        runEvalSuite({
          suite: "oss-rallly-app-flow",
          evalCachePath,
          embeddingProvider: "hash",
        } as Parameters<typeof runEvalSuite>[0] & { suite: string; evalCachePath: string }),
      ).rejects.toThrow(/requires --fetch/);
    } finally {
      await rm(evalCachePath, { recursive: true, force: true });
    }
  });

  it("loads pinned Rallly AST eval cases for route, API, database, UI, middleware, and test files", async () => {
    const loadedPack = await loadEvalPack({
      suite: "oss-rallly-app-flow",
      workspaceRoot: process.cwd(),
    });
    const astCases = (loadedPack as unknown as {
      astCases?: Array<{ id: string; file: string }>;
    }).astCases;

    expect(astCases?.map((testCase) => testCase.id)).toEqual([
      "rallly.ast.api-route",
      "rallly.ast.api-mutation",
      "rallly.ast.database-client",
      "rallly.ast.web-ui-loader",
      "rallly.ast.middleware",
      "rallly.ast.private-api-test",
    ]);
    expect(astCases?.map((testCase) => testCase.file)).toEqual(
      expect.arrayContaining([
        "apps/api/src/routes/polls.ts",
        "packages/api-core/src/polls/mutations.ts",
        "packages/database/src/client.ts",
        "apps/web/src/app/[locale]/(optional-space)/poll/[urlId]/admin-page-loader.tsx",
        "apps/api/src/middleware/api-key.ts",
        "apps/web/src/app/api/private/[...route]/route.test.ts",
      ]),
    );
  });

  it("loads graph-specific Rallly target gates", async () => {
    const loadedPack = await loadEvalPack({
      suite: "oss-rallly-app-flow",
      workspaceRoot: process.cwd(),
    });
    const graphCases = (loadedPack as unknown as {
      graphCases?: Array<{ id: string; gate: { status: string; layer: string } }>;
    }).graphCases;

    expect(graphCases?.map((testCase) => testCase.id)).toEqual([
      "rallly.graph.route-mutation-database-typed-path",
      "rallly.relationship.route-mutation-database-ordered-path",
      "rallly.relationship.create-poll-member-database-call",
      "rallly.graph.middleware-to-route-usage-path",
      "rallly.graph-ui-to-route-data-loader-path",
      "rallly.graph-test-to-implementation-evidence-path",
      "rallly.test-linking.private-route-direct-edge",
      "rallly.test-linking.private-route-to-create-poll",
      "rallly.test-linking.private-route-to-database",
      "rallly.test-linking.api-core-auth-direct-edge",
      "rallly.test-linking.implementation-to-test-lookup",
      "rallly.test-linking.no-billing-false-positive",
      "rallly.graph-no-mention-only-billing-flow",
    ]);
    expect(graphCases?.every((testCase) => testCase.gate.status === "target")).toBe(true);
    expect(graphCases?.map((testCase) => testCase.gate.layer)).toEqual([
      "graph",
      "graph",
      "graph",
      "graph",
      "graph",
      "test-linking",
      "test-linking",
      "test-linking",
      "test-linking",
      "test-linking",
      "test-linking",
      "test-linking",
      "graph",
    ]);
  });
});
