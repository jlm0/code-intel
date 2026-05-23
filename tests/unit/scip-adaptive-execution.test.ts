import { describe, expect, it } from "vitest";

import { resolveIndexPolicy } from "../../src/core/index-policy.js";
import { executeAdaptiveScipShard } from "../../src/indexer/scip-adaptive-execution.js";
import type { ScipShardPlan } from "../../src/indexer/scip-shard-planning.js";
import type { RunScipTypescriptInput, RunScipTypescriptResult } from "../../src/scip/runner.js";

describe("adaptive SCIP execution", () => {
  it("splits OOM shards first, preserves successful children, and classifies failed leaves", async () => {
    const policy = resolveIndexPolicy({
      profile: "balanced",
      overrides: {
        scip: {
          maxRetrySplits: 4,
          defaultHeapMb: 1024,
          tinyShardHeapEscalationMb: 1536,
          tinyShardMaxFiles: 1,
        },
      },
    });
    const calls: Array<{ includedFiles?: string[]; heap?: number }> = [];
    const shard = shardPlan("package-app", [
      "/repo/src/a.ts",
      "/repo/src/b.ts",
      "/repo/src/c.ts",
      "/repo/src/d.ts",
    ]);

    const outcomes = await executeAdaptiveScipShard({
      repoPath: "/repo",
      shard,
      policy,
      runScipTypescript: async (input) => {
        calls.push({ includedFiles: input.includedFiles, heap: input.maxOldSpaceSizeMb });
        if ((input.includedFiles?.length ?? 0) > 1) {
          return failed(input, "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory");
        }
        if (input.includedFiles?.[0]?.endsWith("d.ts")) {
          return failed(input, "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory");
        }
        return ok(input);
      },
    });

    expect(calls[0]).toMatchObject({ heap: 1024 });
    expect(calls.some((call) => call.includedFiles?.length === 1 && call.heap === 1536)).toBe(true);
    expect(outcomes.filter((outcome) => outcome.status === "succeeded").map((outcome) => outcome.shard.includedFiles?.[0])).toEqual([
      "/repo/src/a.ts",
      "/repo/src/b.ts",
      "/repo/src/c.ts",
    ]);
    expect(outcomes.find((outcome) => outcome.shard.includedFiles?.[0] === "/repo/src/d.ts")).toMatchObject({
      status: "failed",
      failureKind: "oom",
      retryExhausted: true,
    });
  });

  it("does not retry timeouts indefinitely", async () => {
    const policy = resolveIndexPolicy({ profile: "lean", overrides: { scip: { maxRetrySplits: 2 } } });
    const outcomes = await executeAdaptiveScipShard({
      repoPath: "/repo",
      shard: shardPlan("timeout", ["/repo/src/a.ts", "/repo/src/b.ts"]),
      policy,
      runScipTypescript: async (input) => ({
        ...failed(input, "scip-typescript timed out after 120000ms"),
        timedOut: true,
      }),
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      status: "failed",
      failureKind: "timeout",
      retryExhausted: true,
    });
  });

  it("splits retry children by estimated cost instead of midpoint file count", async () => {
    const policy = resolveIndexPolicy({ profile: "balanced", overrides: { scip: { maxRetrySplits: 1 } } });
    const shard = {
      ...shardPlan("costed", [
        "/repo/src/generated-contracts.ts",
        "/repo/src/a.ts",
        "/repo/src/b.ts",
        "/repo/src/c.ts",
      ]),
      fileCosts: [
        { absolutePath: "/repo/src/generated-contracts.ts", cost: 90 },
        { absolutePath: "/repo/src/a.ts", cost: 10 },
        { absolutePath: "/repo/src/b.ts", cost: 10 },
        { absolutePath: "/repo/src/c.ts", cost: 10 },
      ],
    } as ScipShardPlan;
    const calls: Array<string[] | undefined> = [];

    await executeAdaptiveScipShard({
      repoPath: "/repo",
      shard,
      policy,
      runScipTypescript: async (input) => {
        calls.push(input.includedFiles);
        if (calls.length === 1) {
          return failed(input, "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory");
        }
        return ok(input);
      },
    });

    expect(calls.slice(1)).toEqual([
      ["/repo/src/generated-contracts.ts"],
      ["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/c.ts"],
    ]);
  });
});

function shardPlan(id: string, includedFiles: string[]): ScipShardPlan {
  return {
    id,
    kind: "package",
    projectPath: "/repo",
    outputPath: `/index/scip/${id}.scip`,
    includedFiles,
    cost: includedFiles.length * 100,
    reason: "test",
    lineage: [id],
  };
}

function ok(input: RunScipTypescriptInput): RunScipTypescriptResult {
  return {
    ok: true,
    outputPath: input.outputPath,
    outputBytes: 4096,
    durationMs: 10,
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
  };
}

function failed(input: RunScipTypescriptInput, stderr: string): RunScipTypescriptResult {
  return {
    ok: false,
    outputPath: input.outputPath,
    outputBytes: 0,
    durationMs: 10,
    stdout: "",
    stderr,
    exitCode: 1,
    signal: null,
    timedOut: false,
  };
}
