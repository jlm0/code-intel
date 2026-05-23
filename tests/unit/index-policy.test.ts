import { describe, expect, it } from "vitest";

import { resolveIndexPolicy } from "../../src/core/index-policy.js";

describe("index policy profiles", () => {
  it("resolves deterministic policy defaults for every supported profile", () => {
    const profiles = ["lean", "balanced", "monorepo", "quality"] as const;
    const resolved = profiles.map((profile) => resolveIndexPolicy({ profile }));

    expect(resolved.map((policy) => policy.profile)).toEqual(profiles);
    expect(resolved.map((policy) => policy.discovery.generatedSourceMode)).toEqual([
      "exclude",
      "exclude",
      "types-only",
      "include",
    ]);
    expect(resolved.map((policy) => policy.scip.targetShardCost)).toEqual([160, 220, 140, 320]);
    expect(resolved.map((policy) => policy.embedding.inputMode)).toEqual([
      "minimal",
      "minimal",
      "semantic-header",
      "semantic-header",
    ]);
    expect(resolved.map((policy) => policy.graph.transitiveCallLimit)).toEqual([0, 2_000, 1_000, 8_000]);
  });

  it("merges explicit overrides without mutating the profile baseline", () => {
    const first = resolveIndexPolicy({
      profile: "monorepo",
      overrides: {
        scip: { targetShardCost: 75 },
        embedding: { maxBatchTotalTokens: 512 },
      },
    });
    const second = resolveIndexPolicy({ profile: "monorepo" });

    expect(first.scip.targetShardCost).toBe(75);
    expect(first.embedding.maxBatchTotalTokens).toBe(512);
    expect(second.scip.targetShardCost).toBe(140);
    expect(second.embedding.maxBatchTotalTokens).not.toBe(512);
  });
});
