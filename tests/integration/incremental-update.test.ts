import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readActiveManifest } from "../../src/core/index-artifacts.js";
import { LadybugGraphStore } from "../../src/graph/ladybug-store.js";
import { readActiveIndexFacts } from "../../src/indexer/fact-cache.js";
import { indexWorkspace, updateWorkspace } from "../../src/indexer/indexer.js";
import { createQueryEngine } from "../../src/query/query-engine.js";
import type { EmbeddingProvider } from "../../src/vectors/embedding.js";
import { copyFixtureWorkspace, mutateFixtureWorkspace } from "../helpers/incremental-fixture.js";

describe("incremental changed-file reindexing", () => {
  it("reuses unchanged embeddings, refreshes changed facts, and matches a fresh full index", async () => {
    const workspaceRoot = await copyFixtureWorkspace();
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-incremental-"));
    const fullIndexPath = await mkdtemp(join(tmpdir(), "code-intel-full-equivalent-"));
    try {
      const initialProvider = createCountingProvider();
      const initialManifest = await indexWorkspace({
        workspaceRoot,
        repoPaths: [workspaceRoot],
        indexPath,
        embeddingProvider: initialProvider,
      });
      expect(initialProvider.embeddedTexts).toHaveLength(initialManifest.stats.chunks);

      await mutateFixtureWorkspace(workspaceRoot);

      const updateProvider = createCountingProvider();
      const updateManifest = await updateWorkspace({
        workspaceRoot,
        repoPaths: [workspaceRoot],
        indexPath,
        embeddingProvider: updateProvider,
      });

      expect(updateManifest.incremental).toMatchObject({
        mode: "incremental",
        files: {
          added: 1,
          changed: 1,
          deleted: 2,
          unchanged: 22,
        },
        chunks: {
          reused: 27,
          embedded: 3,
        },
      });
      expect(updateManifest.incremental?.chunks.embedded).toBe(updateProvider.embeddedTexts.length);
      expect(updateProvider.embeddedTexts.length).toBeLessThan(updateManifest.stats.chunks);
      expect(embeddedChunkNames(updateProvider)).toEqual(["GivingLedger", "createBlessingNote", "summarize"]);

      const engine = createQueryEngine({ indexPath, embeddingProvider: createCountingProvider() });
      try {
        const addedSymbol = await engine.findSymbol("createBlessingNote", { limit: 5 });
        expect(addedSymbol.results[0]).toMatchObject({
          file: "packages/core/src/blessing.ts",
          kind: "Function",
        });

        const references = await engine.getReferences("calculateGivingTotal", { limit: 20 });
        expect(references.results.map((result) => result.file)).not.toContain(
          "packages/core/src/tithe.test.ts",
        );

        const deletedSymbol = await engine.findSymbol("PrimaryRenderer", { limit: 5 });
        expect(deletedSymbol.results).toEqual([]);

        const semanticTestResults = await engine.semanticSearch("calculates giving totals", {
          limit: 5,
          fileKind: "test",
        });
        expect(semanticTestResults.results.map((result) => result.file)).not.toContain(
          "packages/core/src/tithe.test.ts",
        );
        const semanticSourceResults = await engine.semanticSearch("primary renderer", {
          limit: 5,
          fileKind: "source",
        });
        expect(semanticSourceResults.results.map((result) => result.file)).not.toContain(
          "packages/core/src/duplicateMethods.ts",
        );

        const callees = await engine.getCallees("summarize", { limit: 10 });
        const calleeNames = callees.results.map((result) => result.symbol?.name);
        expect(calleeNames).toContain("formatGivingReceipt");
        expect(calleeNames).not.toContain("calculateGivingTotal");
      } finally {
        await engine.close();
      }

      await indexWorkspace({
        workspaceRoot,
        repoPaths: [workspaceRoot],
        indexPath: fullIndexPath,
        embeddingProvider: createCountingProvider(),
      });

      await expectGraphEquivalent(indexPath, fullIndexPath);
      await expectFactsEquivalent(indexPath, fullIndexPath);
      await expectManifestEquivalent(indexPath, fullIndexPath);
      await expectSemanticEquivalent(indexPath, fullIndexPath, "giving receipt summary");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(indexPath, { recursive: true, force: true });
      await rm(fullIndexPath, { recursive: true, force: true });
    }
  });

  it("queries one active generation snapshot even when update publishes a new generation", async () => {
    const workspaceRoot = await copyFixtureWorkspace();
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-snapshot-"));
    try {
      await indexWorkspace({
        workspaceRoot,
        repoPaths: [workspaceRoot],
        indexPath,
        embeddingProviderName: "hash",
      });
      const snapshotEngine = createQueryEngine({ indexPath });
      await new Promise((resolve) => setTimeout(resolve, 100));

      await updateWorkspace({
        workspaceRoot,
        repoPaths: [workspaceRoot],
        indexPath,
        embeddingProvider: createCountingProvider(),
      });

      try {
        const semantic = await snapshotEngine.semanticSearch("giving receipt summary", {
          limit: 5,
        });
        expect(semantic.results.length).toBeGreaterThan(0);
      } finally {
        await snapshotEngine.close();
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(indexPath, { recursive: true, force: true });
    }
  });
});

async function expectGraphEquivalent(incrementalIndexPath: string, fullIndexPath: string): Promise<void> {
  const incremental = new LadybugGraphStore(incrementalIndexPath);
  const full = new LadybugGraphStore(fullIndexPath);
  try {
    const incrementalNodes = await incremental.getNodes();
    const fullNodes = await full.getNodes();
    const incrementalEdges = await incremental.getEdges();
    const fullEdges = await full.getEdges();

    expect(incrementalNodes).toEqual(fullNodes);
    expect(incrementalEdges).toEqual(fullEdges);
  } finally {
    await incremental.close();
    await full.close();
  }
}

async function expectFactsEquivalent(incrementalIndexPath: string, fullIndexPath: string): Promise<void> {
  const incrementalFacts = await readActiveIndexFacts(incrementalIndexPath);
  const fullFacts = await readActiveIndexFacts(fullIndexPath);

  expect(incrementalFacts?.embedding).toEqual(fullFacts?.embedding);
  expect(incrementalFacts?.configHash).toBe(fullFacts?.configHash);
  expect(incrementalFacts?.files).toEqual(fullFacts?.files);
}

async function expectManifestEquivalent(incrementalIndexPath: string, fullIndexPath: string): Promise<void> {
  const incrementalManifest = await readActiveManifest(incrementalIndexPath);
  const fullManifest = await readActiveManifest(fullIndexPath);

  expect(incrementalManifest?.repos).toEqual(fullManifest?.repos);
  expect(incrementalManifest?.stats).toEqual(fullManifest?.stats);
  expect(incrementalManifest?.embedding).toEqual(fullManifest?.embedding);
}

async function expectSemanticEquivalent(
  incrementalIndexPath: string,
  fullIndexPath: string,
  query: string,
): Promise<void> {
  const incremental = createQueryEngine({ indexPath: incrementalIndexPath, embeddingProvider: createCountingProvider() });
  const full = createQueryEngine({ indexPath: fullIndexPath, embeddingProvider: createCountingProvider() });
  try {
    const [incrementalResult, fullResult] = await Promise.all([
      incremental.semanticSearch(query, { limit: 5 }),
      full.semanticSearch(query, { limit: 5 }),
    ]);
    expect(incrementalResult.results.map((result) => result.id)).toEqual(
      fullResult.results.map((result) => result.id),
    );
  } finally {
    await incremental.close();
    await full.close();
  }
}

function embeddedChunkNames(provider: { embeddedTexts: string[] }): string[] {
  return provider.embeddedTexts.map((text) => text.split("\n")[0] ?? "").sort();
}

function createCountingProvider(): EmbeddingProvider & { embeddedTexts: string[] } {
  const embeddedTexts: string[] = [];
  return {
    provider: "hash",
    model: "counting-hash-v1",
    dimension: 4,
    embeddedTexts,
    async embed(text: string) {
      return this.embedBatch([text]).then((vectors) => vectors[0] ?? []);
    },
    async embedBatch(texts: string[]) {
      embeddedTexts.push(...texts);
      return texts.map((text) => vectorForText(text));
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
