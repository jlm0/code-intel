import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { calculateConfigHash } from "../../src/indexer/fingerprints.js";
import { createHashEmbeddingProvider } from "../../src/vectors/embedding.js";
import type { DiscoveredWorkspace } from "../../src/workspace/discovery.js";

describe("config fingerprints", () => {
  it("changes when tsconfig.base.json changes", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "code-intel-config-hash-"));
    try {
      await mkdir(join(workspaceRoot, "src"), { recursive: true });
      await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({ name: "fixture" }));
      await writeFile(join(workspaceRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
      await writeFile(join(workspaceRoot, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { baseUrl: "." } }));
      const workspace = fixtureWorkspace(workspaceRoot);

      const before = await calculateConfigHash({
        workspace,
        embeddingProvider: createHashEmbeddingProvider(),
      });
      await writeFile(
        join(workspaceRoot, "tsconfig.base.json"),
        JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@fixture/*": ["src/*"] } } }),
      );
      const after = await calculateConfigHash({
        workspace,
        embeddingProvider: createHashEmbeddingProvider(),
      });

      expect(after).not.toBe(before);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

function fixtureWorkspace(workspaceRoot: string): DiscoveredWorkspace {
  return {
    workspaceName: "fixture",
    workspaceRoot,
    repos: [{
      name: "fixture",
      path: workspaceRoot,
      relativePath: ".",
      commit: "HEAD",
      packageManager: "npm",
      packages: [{
        name: "fixture",
        path: workspaceRoot,
        relativePath: ".",
        exports: undefined,
        dependencies: {},
        sourceRoots: [join(workspaceRoot, "src")],
        excludePatterns: [],
      }],
      files: [],
    }],
    diagnostics: {
      files: [],
    },
  };
}
