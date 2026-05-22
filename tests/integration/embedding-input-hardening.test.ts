import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LadybugGraphStore } from "../../src/graph/ladybug-store.js";
import { readActiveIndexFacts } from "../../src/indexer/fact-cache.js";
import { indexWorkspace } from "../../src/indexer/indexer.js";
import type { EmbeddingProvider } from "../../src/vectors/embedding.js";

describe("embedding input hardening integration", () => {
  it("keeps generated and hidden artifact paths out of facts, graph nodes, and embeddings", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "code-intel-artifact-index-"));
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-artifact-index-db-"));
    try {
      await mkdir(join(repoPath, "src"), { recursive: true });
      await mkdir(join(repoPath, ".vercel", "output"), { recursive: true });
      await mkdir(join(repoPath, "dist"), { recursive: true });
      await writeFile(join(repoPath, "package.json"), JSON.stringify({ name: "@fixture/artifact-index" }));
      await writeFile(join(repoPath, "src", "index.ts"), "export const rawSourceNeedle = true;\n");
      await writeFile(join(repoPath, ".vercel", "output", "route.ts"), "export const hiddenArtifactNeedle = true;\n");
      await writeFile(join(repoPath, "dist", "bundle.ts"), "export const builtArtifactNeedle = true;\n");

      const manifest = await indexWorkspace({
        workspaceRoot: repoPath,
        repoPaths: [repoPath],
        indexPath,
        embeddingProviderName: "hash",
      });
      const facts = await readActiveIndexFacts(indexPath);
      const indexedFiles = facts?.files.map((file) => file.fingerprint.relativePath) ?? [];
      expect(indexedFiles).toEqual(["src/index.ts"]);

      const store = new LadybugGraphStore(indexPath);
      try {
        const nodes = await store.getNodes();
        expect(nodes.map((node) => node.file).filter(Boolean)).not.toContain(".vercel/output/route.ts");
        expect(nodes.map((node) => node.file).filter(Boolean)).not.toContain("dist/bundle.ts");
      } finally {
        await store.close();
      }

      expect(manifest.stats.chunks).toBe(1);
      expect(manifest.embeddingInput).toMatchObject({
        chunksTotal: 1,
        inputsTotal: 1,
        truncationFallbacks: 0,
      });
    } finally {
      await rm(indexPath, { recursive: true, force: true });
      await rm(repoPath, { recursive: true, force: true });
    }
  });

  it("splits oversized real source chunks into bounded token-aware embedding inputs", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "code-intel-oversized-source-"));
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-oversized-source-db-"));
    try {
      await mkdir(join(repoPath, "src"), { recursive: true });
      await writeFile(join(repoPath, "package.json"), JSON.stringify({ name: "@fixture/oversized-source" }));
      await writeFile(
        join(repoPath, "src", "oversized.ts"),
        `export function oversizedSource() {
  const values = [
${Array.from({ length: 80 }, (_value, index) => `    "filler token ${index}",`).join("\n")}
  ];
  return values.join(" ") + " rare_after_cutoff_semantic_marker";
}
`,
      );

      const provider = smallBudgetProvider();
      const manifest = await indexWorkspace({
        workspaceRoot: repoPath,
        repoPaths: [repoPath],
        indexPath,
        embeddingProvider: provider,
      });
      const facts = await readActiveIndexFacts(indexPath);
      const chunks = facts?.files[0]?.chunks ?? [];

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => (chunk.embeddingInputTokenCount ?? 0) <= provider.maxInputTokens)).toBe(true);
      expect(chunks.every((chunk) => chunk.embeddingInputTruncated !== true)).toBe(true);
      expect(chunks.some((chunk) => chunk.content.includes("rare_after_cutoff_semantic_marker"))).toBe(true);
      expect(manifest.embeddingInput).toMatchObject({
        splitChunks: chunks.length,
        truncationFallbacks: 0,
        maxTokens: expect.any(Number),
      });
    } finally {
      await rm(indexPath, { recursive: true, force: true });
      await rm(repoPath, { recursive: true, force: true });
    }
  });
});

function smallBudgetProvider(): EmbeddingProvider {
  return {
    provider: "hash",
    model: "small-budget-test",
    dimension: 4,
    maxInputTokens: 40,
    async embed(text: string) {
      return vectorForText(text);
    },
    async embedBatch(texts: string[]) {
      return texts.map(vectorForText);
    },
    async countTokens(texts: string[]) {
      return texts.map((text) => text.split(/\s+/).filter(Boolean).length);
    },
  };
}

function vectorForText(text: string): number[] {
  const length = Math.max(1, text.length);
  return [
    (length % 7) / 7,
    (length % 11) / 11,
    (length % 13) / 13,
    (length % 17) / 17,
  ];
}
