import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createIndexProgressFileReporter,
  readIndexProgress,
  type IndexProgressReporter,
} from "../../src/core/progress.js";
import { readActiveManifest } from "../../src/core/index-artifacts.js";
import { indexWorkspace, updateWorkspace } from "../../src/indexer/indexer.js";
import { copyFixtureWorkspace, mutateFixtureWorkspace } from "../helpers/incremental-fixture.js";

describe("index progress integration", () => {
  it("keeps each coarse index phase queryable while indexing runs", async () => {
    const workspaceRoot = await copyFixtureWorkspace();
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-progress-index-"));
    const fileReporter = createIndexProgressFileReporter({
      indexPath,
      operation: "index",
      runId: "integration-run",
    });
    const observedPhases: string[] = [];
    const progress: IndexProgressReporter = {
      report: async (update) => {
        await fileReporter.report(update);
        const snapshot = await readIndexProgress(indexPath);
        if (snapshot) {
          observedPhases.push(snapshot.phase);
        }
      },
    };

    try {
      const manifest = await indexWorkspace({
        workspaceRoot,
        repoPaths: [workspaceRoot],
        indexPath,
        embeddingProviderName: "hash",
        progress,
      });

      expect(manifest.stats.chunks).toBeGreaterThan(0);
      expect(observedPhases).toEqual(
        expect.arrayContaining([
          "starting",
          "discovering",
          "planning",
          "facts",
          "scip",
          "embeddings",
          "graph",
          "publishing",
          "succeeded",
        ]),
      );
      await expect(readIndexProgress(indexPath)).resolves.toMatchObject({
        operation: "index",
        status: "succeeded",
        phase: "succeeded",
        counters: {
          chunksTotal: manifest.stats.chunks,
          nodesWritten: manifest.stats.nodes,
          edgesWritten: manifest.stats.edges,
        },
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(indexPath, { recursive: true, force: true });
    }
  }, 60_000);

  it("records failed update progress without replacing the active generation", async () => {
    const workspaceRoot = await copyFixtureWorkspace();
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-progress-failed-update-"));
    try {
      const initialManifest = await indexWorkspace({
        workspaceRoot,
        repoPaths: [workspaceRoot],
        indexPath,
        embeddingProviderName: "hash",
        progress: createIndexProgressFileReporter({
          indexPath,
          operation: "index",
          runId: "initial-run",
        }),
      });

      await mutateFixtureWorkspace(workspaceRoot);
      await expect(updateWorkspace({
        workspaceRoot,
        repoPaths: [join(workspaceRoot, "missing-repo")],
        indexPath,
        embeddingProviderName: "hash",
        progress: createIndexProgressFileReporter({
          indexPath,
          operation: "update",
          runId: "failed-run",
        }),
      })).rejects.toThrow(/Repository path/);

      await expect(readIndexProgress(indexPath)).resolves.toMatchObject({
        operation: "update",
        status: "failed",
        phase: "failed",
      });
      await expect(readActiveManifest(indexPath)).resolves.toMatchObject({
        generatedAt: initialManifest.generatedAt,
        stats: initialManifest.stats,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(indexPath, { recursive: true, force: true });
    }
  }, 60_000);
});
