import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("SCIP sharding memory contracts", () => {
  it("does not batch multiple project shards into one scip-typescript child process", async () => {
    const runner = await source("src/scip/runner.ts");

    expect(
      runner.includes("...preparedProject.projects"),
      "runner should execute one scip-typescript child per shard instead of one child with every project argument",
    ).toBe(false);
  });

  it("keeps the default SCIP child heap at or below one gigabyte", async () => {
    const runner = await source("src/scip/runner.ts");
    const defaultHeap = runner.match(/maxOldSpaceSizeMb\s*\?\?\s*(\d+)/)?.[1];

    expect(defaultHeap, "runner should declare an explicit default heap").toBeDefined();
    expect(Number(defaultHeap)).toBeLessThanOrEqual(1024);
  });

  it("writes raw SCIP artifacts per shard instead of one repo-wide output", async () => {
    const indexer = await source("src/indexer/indexer.ts");

    expect(
      indexer.includes('join(input.indexPath, "scip", `${repo.name}.scip`)'),
      "indexer should not collapse all shard output into <repo>.scip",
    ).toBe(false);
  });

  it("tracks shard fact spill files separately from repo fact spill files", async () => {
    const indexer = await source("src/indexer/indexer.ts");

    expect(
      /writeRepoScipFacts\(/.test(indexer),
      "SCIP fact spilling should be keyed by shard identity, not only repo identity",
    ).toBe(false);
  });

  it("aligns inferred shard excludes with discovery ignored generated directories", async () => {
    const runner = await source("src/scip/runner.ts");

    for (const ignoredGeneratedDirectory of [".next/**", "generated/**", "__generated__/**"]) {
      expect(
        runner.includes(`"${ignoredGeneratedDirectory}"`),
        `inferred shard configs should exclude ${ignoredGeneratedDirectory}`,
      ).toBe(true);
    }
  });
});

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}
