import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { planScipShardsForRepo } from "../../src/indexer/indexer.js";
import type { DiscoveredRepo } from "../../src/workspace/discovery.js";

describe("SCIP shard planning", () => {
  it("splits oversized package shards into bounded file groups without dropping files", () => {
    const repoPath = "/tmp/code-intel-large-repo";
    const packagePath = join(repoPath, "apps", "web");
    const files = Array.from({ length: 801 }, (_, index) => {
      const sourceRoot = index < 401 ? "src" : "routes";
      return sourceFile(repoPath, `apps/web/${sourceRoot}/file-${index}.ts`, "@fixture/web");
    });
    const repo: DiscoveredRepo = {
      name: "large-repo",
      path: repoPath,
      relativePath: ".",
      commit: "test",
      packageManager: "npm",
      packages: [{
        name: "@fixture/web",
        path: packagePath,
        relativePath: "apps/web",
        exports: undefined,
        dependencies: {},
        sourceRoots: [join(packagePath, "src"), join(packagePath, "routes")],
        excludePatterns: [],
      }],
      files,
    };

    const shards = planScipShardsForRepo(repo, "/tmp/code-intel-index");
    const packageShards = shards.filter((shard) => shard.kind === "package");

    expect(packageShards.length).toBeGreaterThan(1);
    expect(packageShards.every((shard) => (shard.includedFiles?.length ?? 0) <= 350)).toBe(true);
    expect(packageShards.flatMap((shard) => shard.includedFiles ?? []).sort()).toEqual(
      files.map((file) => file.absolutePath).sort(),
    );
  });
});

function sourceFile(repoPath: string, relativePath: string, packageName: string) {
  return {
    absolutePath: join(repoPath, relativePath),
    relativePath,
    packageName,
    language: "typescript" as const,
  };
}
