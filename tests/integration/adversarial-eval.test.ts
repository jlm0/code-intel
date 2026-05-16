import { describe, expect, it } from "vitest";

import { runEvalSuite } from "../../src/eval/evaluator.js";

describe("adversarial eval regressions", () => {
  it("passes every synthetic adversarial gate against the in-process index", async () => {
    const report = await runEvalSuite({
      evalPack: "eval-packs/js-ts-adversarial",
      embeddingProvider: "hash",
    });

    const failedCaseIds = [
      ...report.astCases,
      ...report.graphCases,
      ...report.cases,
    ]
      .filter((testCase) => testCase.status === "fail")
      .map((testCase) => testCase.id);

    expect(report.blockingStatus).toBe("pass");
    expect(report.qualityStatus).toBe("pass");
    expect(report.summary.gateStatuses.required).toMatchObject({
      total: 0,
      passed: 0,
      failed: 0,
    });
    expect(report.summary.gateStatuses.target).toMatchObject({
      total: 73,
      passed: 73,
      failed: 0,
    });
    expect(report.summary.gateStatuses.scoreboard).toMatchObject({
      total: 5,
      passed: 5,
      failed: 0,
    });
    expect(failedCaseIds).toEqual([]);
  });
});
