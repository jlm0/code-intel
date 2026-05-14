import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runEvalSuite } from "../../src/eval/evaluator.js";

describe("runEvalSuite", () => {
  it("reports pack identity, ranks, latency, and false-positive guards", async () => {
    const report = await runEvalSuite({
      suite: "js-ts-general",
      embeddingProvider: "hash",
    } as Parameters<typeof runEvalSuite>[0] & { suite: string });

    expect(report.status).toBe("pass");
    expect(report.suite).toMatchObject({
      id: "js-ts-general",
      kind: "synthetic",
    });
    expect(report.corpus).toMatchObject({
      type: "local",
    });
    expect(report.cases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "synthetic.semantic-concept",
          mode: "semantic",
          failureClass: undefined,
          expected: expect.arrayContaining([
            expect.objectContaining({
              file: "packages/core/src/tithe.ts",
              found: true,
              rank: expect.any(Number),
            }),
          ]),
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
});
