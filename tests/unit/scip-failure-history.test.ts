import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  appendScipFailureHistory,
  failureHistoryEntryForShard,
  readScipFailureHistory,
} from "../../src/indexer/scip-failure-history.js";
import type { ScipShardPlan } from "../../src/indexer/scip-shard-planning.js";

describe("SCIP failure history", () => {
  it("persists and deduplicates shard failures for future planning", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-scip-history-"));
    try {
      const first = failureHistoryEntryForShard("repo", "/repo", shardPlan([
        "/repo/packages/api/src/generated-a.ts",
        "/repo/packages/api/src/generated-b.ts",
      ]), "oom", "2026-05-23T10:00:00.000Z");
      const second = { ...first, lastFailedAt: "2026-05-23T11:00:00.000Z" };

      await appendScipFailureHistory(indexPath, [first]);
      await appendScipFailureHistory(indexPath, [second]);

      expect(await readScipFailureHistory(indexPath)).toEqual([{
        repo: "repo",
        pathPrefix: "packages/api/src",
        filePaths: [
          "packages/api/src/generated-a.ts",
          "packages/api/src/generated-b.ts",
        ],
        failureKind: "oom",
        lastFailedAt: "2026-05-23T11:00:00.000Z",
      }]);
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });

  it("records exact file paths for single-file failed shards", () => {
    expect(failureHistoryEntryForShard("repo", "/repo", shardPlan([
      "/repo/packages/api/src/heavy.ts",
    ]), "oom", "2026-05-23T12:00:00.000Z")).toEqual({
      repo: "repo",
      pathPrefix: "packages/api/src/heavy.ts",
      filePaths: ["packages/api/src/heavy.ts"],
      failureKind: "oom",
      lastFailedAt: "2026-05-23T12:00:00.000Z",
    });
  });
});

function shardPlan(includedFiles: string[]): ScipShardPlan {
  return {
    id: "package-api-src",
    kind: "package",
    projectPath: "/repo/packages/api",
    outputPath: "/index/scip/package-api-src.scip",
    includedFiles,
    cost: 100,
    reason: "package-source-root",
    lineage: ["package-api-src"],
  };
}
