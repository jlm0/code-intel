import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { indexWorkspace } from "../../src/indexer/indexer.js";
import { createQueryEngine } from "../../src/query/query-engine.js";

const fixturePath = new URL("../fixtures/js-ts-workspace", import.meta.url).pathname;

describe("index and query integration", () => {
  it("indexes fixtures into a persistent Ladybug graph and answers relationships", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-index-"));
    try {
      const manifest = await indexWorkspace({
        workspaceRoot: fixturePath,
        repoPaths: [fixturePath],
        indexPath,
      });

      expect(manifest.stats.nodes).toBeGreaterThan(0);
      expect(manifest.stats.edges).toBeGreaterThan(0);
      expect(manifest.stats.chunks).toBeGreaterThan(0);

      const firstEngine = createQueryEngine({ indexPath });
      try {
        const symbol = await firstEngine.findSymbol("calculateGivingTotal", { limit: 5 });
        expect(symbol.results[0]).toMatchObject({
          kind: "Function",
          file: "packages/core/src/tithe.ts",
        });

        const callers = await firstEngine.getCallers("calculateGivingTotal", { limit: 10 });
        expect(callers.results.map((result) => result.file)).toContain(
          "packages/core/src/ledger.ts",
        );

        const callees = await firstEngine.getCallees("summarize", { limit: 10 });
        expect(callees.results.map((result) => result.file)).toContain(
          "packages/core/src/tithe.ts",
        );
      } finally {
        await firstEngine.close();
      }

      const secondEngine = createQueryEngine({ indexPath });
      try {
        const semantic = await secondEngine.semanticSearch("giving receipt summary", {
          limit: 5,
        });
        expect(semantic.results.length).toBeGreaterThan(0);
        expect(semantic.results.some((result) => result.file?.includes("tithe.ts"))).toBe(true);
        expect(semantic.results[0]?.metadata).not.toHaveProperty("content");

        const packageFilteredSemantic = await secondEngine.semanticSearch("giving receipt summary", {
          limit: 5,
          packageName: "@fixture/ui",
        });
        expect(packageFilteredSemantic.results.length).toBeGreaterThan(0);
        expect(packageFilteredSemantic.results.every((result) => result.packageName === "@fixture/ui")).toBe(true);

        const testFilteredSemantic = await secondEngine.semanticSearch("calculates giving totals", {
          limit: 5,
          fileKind: "test",
        });
        expect(testFilteredSemantic.results.length).toBeGreaterThan(0);
        expect(testFilteredSemantic.results.every((result) => result.metadata.fileKind === "test")).toBe(true);

        const context = await secondEngine.getContext(semantic.results[0]!.id, { limit: 1 });
        expect(context.results[0]?.excerpt).toMatch(/giving/i);

        const expanded = await secondEngine.expandContext(semantic.results[0]!.id, {
          depth: 1,
          limit: 10,
        });
        expect(expanded.results.length).toBeGreaterThan(0);

        const summarize = await secondEngine.findSymbol("summarize", { limit: 1 });
        const calculate = await secondEngine.findSymbol("calculateGivingTotal", { limit: 1 });
        const path = await secondEngine.tracePath(
          summarize.results[0]!.id,
          calculate.results[0]!.id,
          { limit: 10 },
        );
        expect(path.results.map((result) => result.id)).toContain(calculate.results[0]!.id);

        const renderMethods = await secondEngine.findSymbol("render", { limit: 10 });
        const duplicateMethodResults = renderMethods.results.filter(
          (result) =>
            result.file === "packages/core/src/duplicateMethods.ts" &&
            result.kind === "Function" &&
            result.symbol?.name === "render",
        );
        expect(duplicateMethodResults).toHaveLength(2);
        expect(new Set(duplicateMethodResults.map((result) => result.id)).size).toBe(2);
      } finally {
        await secondEngine.close();
      }

      const mismatchedEngine = createQueryEngine({
        indexPath,
        embeddingProviderName: "jina",
      });
      try {
        await expect(
          mismatchedEngine.semanticSearch("giving receipt summary", { limit: 1 }),
        ).rejects.toThrow(/Embedding provider mismatch/);
      } finally {
        await mismatchedEngine.close();
      }
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });
});
