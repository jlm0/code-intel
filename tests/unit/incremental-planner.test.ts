import { describe, expect, it } from "vitest";

import { planIncrementalUpdate } from "../../src/indexer/update-planner.js";
import type { FileFingerprint } from "../../src/schema/schemas.js";

describe("incremental update planner", () => {
  it("classifies added, changed, deleted, and unchanged files by content hash", () => {
    const previous = new Map<string, FileFingerprint>([
      ["repo:src/a.ts", fingerprint("repo", "src/a.ts", "hash-a")],
      ["repo:src/b.ts", fingerprint("repo", "src/b.ts", "hash-b-old")],
      ["repo:src/deleted.ts", fingerprint("repo", "src/deleted.ts", "hash-deleted")],
    ]);
    const current = new Map<string, FileFingerprint>([
      ["repo:src/a.ts", fingerprint("repo", "src/a.ts", "hash-a", 20_000)],
      ["repo:src/b.ts", fingerprint("repo", "src/b.ts", "hash-b-new")],
      ["repo:src/added.ts", fingerprint("repo", "src/added.ts", "hash-added")],
    ]);

    const plan = planIncrementalUpdate({ previous, current, configChanged: false });

    expect(plan.added.map((file) => file.relativePath)).toEqual(["src/added.ts"]);
    expect(plan.changed.map((file) => file.relativePath)).toEqual(["src/b.ts"]);
    expect(plan.deleted.map((file) => file.relativePath)).toEqual(["src/deleted.ts"]);
    expect(plan.unchanged.map((file) => file.relativePath)).toEqual(["src/a.ts"]);
  });

  it("widens to a full rebuild when config inputs change", () => {
    const previous = new Map<string, FileFingerprint>([
      ["repo:src/a.ts", fingerprint("repo", "src/a.ts", "hash-a")],
    ]);
    const current = new Map<string, FileFingerprint>([
      ["repo:src/a.ts", fingerprint("repo", "src/a.ts", "hash-a")],
    ]);

    const plan = planIncrementalUpdate({ previous, current, configChanged: true });

    expect(plan.fullRebuild).toBe(true);
    expect(plan.changed.map((file) => file.relativePath)).toEqual(["src/a.ts"]);
    expect(plan.unchanged).toEqual([]);
  });
});

function fingerprint(
  repo: string,
  relativePath: string,
  contentHash: string,
  mtimeMs = 10_000,
): FileFingerprint {
  return {
    repo,
    relativePath,
    packageName: "@fixture/core",
    language: "typescript",
    size: 10,
    mtimeMs,
    contentHash,
  };
}
