import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveIndexPolicy } from "../../src/core/index-policy.js";
import { planScipShardsForRepo } from "../../src/indexer/scip-shard-planning.js";
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

  it("splits repo-root outside-package files by top-level directory under monorepo policy", () => {
    const repoPath = "/tmp/code-intel-root-files";
    const files = [
      sourceFile(repoPath, "scripts/release.ts", undefined),
      sourceFile(repoPath, "scripts/audit.ts", undefined),
      sourceFile(repoPath, "tools/codegen.ts", undefined),
      sourceFile(repoPath, "types/generated/api.d.ts", undefined),
    ];
    const repo: DiscoveredRepo = {
      name: "root-files",
      path: repoPath,
      relativePath: ".",
      commit: "test",
      packageManager: "pnpm",
      packages: [],
      files,
    };

    const shards = planScipShardsForRepo(repo, "/tmp/code-intel-index", {
      policy: resolveIndexPolicy({ profile: "monorepo" }).scip,
    });

    expect(shards.map((shard) => shard.id)).toEqual([
      "repo-root-scripts",
      "repo-root-tools",
      "repo-root-types",
    ]);
    expect(shards.flatMap((shard) => shard.includedFiles ?? []).sort()).toEqual(
      files.map((file) => file.absolutePath).sort(),
    );
  });

  it("uses previous OOM history to pre-split matching paths deterministically", () => {
    const repoPath = "/tmp/code-intel-history";
    const packagePath = join(repoPath, "packages", "api");
    const files = Array.from({ length: 8 }, (_, index) =>
      sourceFile(repoPath, `packages/api/src/large-${index}.ts`, "@fixture/api")
    );
    const repo: DiscoveredRepo = {
      name: "history",
      path: repoPath,
      relativePath: ".",
      commit: "test",
      packageManager: "npm",
      packages: [{
        name: "@fixture/api",
        path: packagePath,
        relativePath: "packages/api",
        exports: undefined,
        dependencies: {},
        sourceRoots: [join(packagePath, "src")],
        excludePatterns: [],
      }],
      files,
    };

    const shards = planScipShardsForRepo(repo, "/tmp/code-intel-index", {
      policy: resolveIndexPolicy({ profile: "balanced" }).scip,
      failureHistory: [{
        repo: "history",
        pathPrefix: "packages/api/src",
        failureKind: "oom",
        lastFailedAt: "2026-05-23T00:00:00.000Z",
      }],
    });

    expect(shards.length).toBeGreaterThan(1);
    expect(shards.every((shard) => shard.reason.includes("history"))).toBe(true);
    expect(shards.flatMap((shard) => shard.includedFiles ?? []).sort()).toEqual(
      files.map((file) => file.absolutePath).sort(),
    );
  });

  it("does not apply single-file OOM history as a whole-source-root one-file split", () => {
    const repoPath = "/tmp/code-intel-history-scope";
    const packagePath = join(repoPath, "packages", "api");
    const files = Array.from({ length: 12 }, (_, index) =>
      sourceFile(repoPath, `packages/api/src/file-${index}.ts`, "@fixture/api")
    );
    const repo: DiscoveredRepo = {
      name: "history-scope",
      path: repoPath,
      relativePath: ".",
      commit: "test",
      packageManager: "npm",
      packages: [{
        name: "@fixture/api",
        path: packagePath,
        relativePath: "packages/api",
        exports: undefined,
        dependencies: {},
        sourceRoots: [join(packagePath, "src")],
        excludePatterns: [],
      }],
      files,
    };

    const shards = planScipShardsForRepo(repo, "/tmp/code-intel-index", {
      policy: resolveIndexPolicy({ profile: "balanced" }).scip,
      failureHistory: [{
        repo: "history-scope",
        pathPrefix: "packages/api/src/file-11.ts",
        filePaths: ["packages/api/src/file-11.ts"],
        failureKind: "oom",
        lastFailedAt: "2026-05-23T00:00:00.000Z",
      }],
    });

    expect(shards.filter((shard) => (shard.includedFiles?.length ?? 0) === 1)).toHaveLength(0);
    expect(shards.flatMap((shard) => shard.includedFiles ?? []).sort()).toEqual(
      files.map((file) => file.absolutePath).sort(),
    );
  });

  it("does not plan unconstrained SCIP shards for empty packages or empty repos", () => {
    const emptyPackageRepoPath = "/tmp/code-intel-empty-package";
    const packagePath = join(emptyPackageRepoPath, "packages", "empty");
    const emptyPackageRepo: DiscoveredRepo = {
      name: "empty-package",
      path: emptyPackageRepoPath,
      relativePath: ".",
      commit: "test",
      packageManager: "npm",
      packages: [{
        name: "@fixture/empty",
        path: packagePath,
        relativePath: "packages/empty",
        exports: undefined,
        dependencies: {},
        sourceRoots: [join(packagePath, "src")],
        excludePatterns: [],
      }],
      files: [],
    };
    const emptyRepo: DiscoveredRepo = {
      name: "empty-repo",
      path: "/tmp/code-intel-empty-repo",
      relativePath: ".",
      commit: "test",
      packageManager: "npm",
      packages: [],
      files: [],
    };

    expect(planScipShardsForRepo(emptyPackageRepo, "/tmp/code-intel-index")).toEqual([]);
    expect(planScipShardsForRepo(emptyRepo, "/tmp/code-intel-index")).toEqual([]);
  });
});

function sourceFile(repoPath: string, relativePath: string, packageName: string | undefined) {
  return {
    absolutePath: join(repoPath, relativePath),
    relativePath,
    ...(packageName ? { packageName } : {}),
    language: "typescript" as const,
  };
}
