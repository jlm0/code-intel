import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { chunkEmbeddingInput } from "../../src/indexer/embedding-input.js";
import { prepareFileFacts } from "../../src/indexer/file-facts.js";
import { resolveIndexPolicy } from "../../src/core/index-policy.js";
import type { EmbeddingProvider } from "../../src/vectors/embedding.js";
import type { DiscoveredWorkspace } from "../../src/workspace/discovery.js";

describe("embedding input preparation", () => {
  it("does not silently character-truncate real source chunk input", () => {
    const tailSignal = "rare_after_cutoff_semantic_marker";
    const input = chunkEmbeddingInput({
      name: "oversizedSource",
      content: `${"const filler = 1;\n".repeat(500)}\nexport const finalSignal = "${tailSignal}";\n`,
    });

    expect(input).toContain(tailSignal);
    expect(input).not.toContain("[truncated");
  });

  it("can include compact semantic headers for disambiguating monorepo chunks", () => {
    const input = chunkEmbeddingInput({
      name: "createClient",
      content: "export const createClient = () => null;",
      fact: {
        embeddingInputMode: "semantic-header",
        embeddingInputHeader: {
          repo: "workspace",
          packageName: "@fixture/sdk",
          path: "packages/sdk/src/client.ts",
          qualifiedName: "createClient",
          kind: "Variable",
          exported: true,
          test: false,
          sourceRoot: "packages/sdk/src",
        },
      },
    });

    expect(input.split("\n").slice(0, 2)).toEqual([
      "repo=workspace package=@fixture/sdk path=packages/sdk/src/client.ts",
      "qualifiedName=createClient kind=Variable exported=true test=false sourceRoot=packages/sdk/src",
    ]);
    expect(input).toContain("export const createClient");
  });

  it("preserves minimal input mode for lean profile behavior", () => {
    const input = chunkEmbeddingInput({
      name: "leanChunk",
      content: "export const value = 1;",
      fact: {
        embeddingInputMode: "minimal",
        embeddingInputHeader: {
          repo: "workspace",
          path: "packages/sdk/src/client.ts",
        },
      },
    });

    expect(input).toBe("leanChunk\nexport const value = 1;");
  });

  it("counts oversized semantic-header chunks with the same header-aware input used for embedding", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "code-intel-embedding-header-budget-"));
    const filePath = join(repoPath, "src", "large.ts");
    const countedInputs: string[] = [];
    try {
      await mkdir(join(repoPath, "src"), { recursive: true });
      await writeFile(filePath, [
        "export function largeHeaderedChunk() {",
        "  const marker0 = 0;",
        "  const marker1 = 1;",
        "  const marker2 = 2;",
        "  const marker3 = 3;",
        "  const marker4 = 4;",
        "  return marker4;",
        "}",
      ].join("\n"), { flag: "w" });

      await prepareFileFacts({
        workspace: workspaceFor(repoPath, filePath),
        embeddingProvider: tokenCountingProvider(countedInputs),
        mode: "index",
        policy: resolveIndexPolicy({
          profile: "monorepo",
          overrides: { embedding: { tokenBudget: 12 } },
        }),
      });

      const sourceCounts = countedInputs.filter((input) => input.includes("marker"));
      expect(sourceCounts.length).toBeGreaterThan(1);
      expect(sourceCounts.every((input) => input.startsWith("repo=fixture "))).toBe(true);
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });
});

function workspaceFor(repoPath: string, filePath: string): DiscoveredWorkspace {
  return {
    workspaceName: "fixture",
    workspaceRoot: repoPath,
    repos: [{
      name: "fixture",
      path: repoPath,
      relativePath: ".",
      commit: "test",
      packageManager: "npm",
      packages: [{
        name: "@fixture/app",
        path: repoPath,
        relativePath: ".",
        exports: undefined,
        dependencies: {},
        sourceRoots: [join(repoPath, "src")],
        excludePatterns: [],
      }],
      files: [{
        absolutePath: filePath,
        relativePath: "src/large.ts",
        packageName: "@fixture/app",
        language: "typescript",
      }],
    }],
    diagnostics: { files: [] },
  };
}

function tokenCountingProvider(countedInputs: string[]): EmbeddingProvider {
  return {
    provider: "hash",
    model: "test-token-counts",
    dimension: 1,
    maxInputTokens: 512,
    async embed() {
      return [1];
    },
    async embedBatch(texts) {
      return texts.map(() => [1]);
    },
    async countTokens(texts) {
      countedInputs.push(...texts);
      return texts.map((text) => text.split(/\s+/).filter(Boolean).length);
    },
  };
}
