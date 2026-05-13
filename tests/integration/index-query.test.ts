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

      const secondEngine = createQueryEngine({ indexPath });
      const semantic = await secondEngine.semanticSearch("giving receipt summary", {
        limit: 5,
      });
      expect(semantic.results.length).toBeGreaterThan(0);
      expect(semantic.results.some((result) => result.file?.includes("tithe.ts"))).toBe(true);

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
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });
});
