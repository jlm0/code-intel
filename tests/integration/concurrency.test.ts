import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveActiveIndexSnapshot } from "../../src/core/index-artifacts.js";
import { LadybugGraphStore } from "../../src/graph/ladybug-store.js";
import { indexWorkspace, updateWorkspace } from "../../src/indexer/indexer.js";
import { createQueryEngine } from "../../src/query/query-engine.js";
import { copyFixtureWorkspace, mutateFixtureWorkspace } from "../helpers/incremental-fixture.js";

describe("concurrency and Ladybug locking", () => {
  it("serializes parallel query-engine reads without self-contending on the process lock", async () => {
    const { workspaceRoot, indexPath } = await createIndexedWorkspace("code-intel-concurrent-read-");
    const engine = createQueryEngine({ indexPath });
    try {
      const [symbol, semantic, references, callers] = await Promise.all([
        engine.findSymbol("calculateGivingTotal", { limit: 5 }),
        engine.semanticSearch("giving receipt summary", { limit: 5 }),
        engine.getReferences("calculateGivingTotal", { limit: 5 }),
        engine.getCallers("calculateGivingTotal", { limit: 5 }),
      ]);

      expect(symbol.results[0].file).toBe("packages/core/src/tithe.ts");
      expect(semantic.results.length).toBeGreaterThan(0);
      expect(references.results.map((result) => result.file)).toContain("packages/core/src/tithe.test.ts");
      expect(callers.results.map((result) => result.file)).toContain("packages/core/src/ledger.ts");
      expect(engine.getRuntimeStats()).toMatchObject({
        serializedOperations: 4,
        maxQueueDepth: expect.any(Number),
        store: {
          openRetryCount: 0,
        },
      });
      expect(engine.getRuntimeStats().maxQueueDepth).toBeGreaterThan(1);
    } finally {
      await engine.close();
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(indexPath, { recursive: true, force: true });
    }
  }, 60_000);

  it("keeps readers on a stable generation while update publishes the next generation atomically", async () => {
    const { workspaceRoot, indexPath } = await createIndexedWorkspace("code-intel-concurrent-update-");
    const staleReader = createQueryEngine({ indexPath });
    try {
      expect((await staleReader.findSymbol("PrimaryRenderer", { limit: 5 })).results.length).toBeGreaterThan(0);
      await mutateFixtureWorkspace(workspaceRoot);

      const updatePromise = updateWorkspace({
        workspaceRoot,
        repoPaths: [workspaceRoot],
        indexPath,
        embeddingProviderName: "hash",
      });
      const duringUpdate = await staleReader.findSymbol("PrimaryRenderer", { limit: 5 });
      await updatePromise;

      expect(duringUpdate.results.length).toBeGreaterThan(0);
      expect((await staleReader.findSymbol("PrimaryRenderer", { limit: 5 })).results.length).toBeGreaterThan(0);

      const freshReader = createQueryEngine({ indexPath });
      try {
        expect((await freshReader.findSymbol("createBlessingNote", { limit: 5 })).results[0].file).toBe(
          "packages/core/src/blessing.ts",
        );
        expect((await freshReader.findSymbol("PrimaryRenderer", { limit: 5 })).results).toEqual([]);
      } finally {
        await freshReader.close();
      }
    } finally {
      await staleReader.close();
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(indexPath, { recursive: true, force: true });
    }
  }, 60_000);

  it("reports live lock timeouts and recovers stale Ladybug process locks", async () => {
    const { workspaceRoot, indexPath } = await createIndexedWorkspace("code-intel-lock-recovery-");
    const lockPath = `${(await resolveActiveIndexSnapshot(indexPath)).databasePath}.process.lock`;
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid }));
      const blockedStore = new LadybugGraphStore(indexPath, { lockTimeoutMs: 10, lockRetryDelayMs: 1 });
      await expect(blockedStore.open()).rejects.toThrow(/Timed out waiting for Ladybug process lock/);
      await blockedStore.close();

      await rm(lockPath, { recursive: true, force: true });
      await mkdir(lockPath);
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: 9_999_999 }));
      const recoveredStore = new LadybugGraphStore(indexPath, { lockTimeoutMs: 500, lockRetryDelayMs: 1 });
      await recoveredStore.open();
      expect(recoveredStore.getRuntimeStats().lockContentionCount).toBeGreaterThan(0);
      await recoveredStore.close();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(indexPath, { recursive: true, force: true });
    }
  }, 60_000);
});

async function createIndexedWorkspace(prefix: string): Promise<{ workspaceRoot: string; indexPath: string }> {
  const workspaceRoot = await copyFixtureWorkspace();
  const indexPath = await mkdtemp(join(tmpdir(), prefix));
  await indexWorkspace({
    workspaceRoot,
    repoPaths: [workspaceRoot],
    indexPath,
    embeddingProviderName: "hash",
  });
  return { workspaceRoot, indexPath };
}
