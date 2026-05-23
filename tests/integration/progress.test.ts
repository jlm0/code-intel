import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createIndexProgressFileReporter,
  getIndexProgress,
  readIndexProgress,
  type IndexProgressReporter,
} from "../../src/core/progress.js";
import { resolveIndexPolicy } from "../../src/core/index-policy.js";
import { readActiveManifest } from "../../src/core/index-artifacts.js";
import { indexWorkspace, updateWorkspace } from "../../src/indexer/indexer.js";
import { readScipFailureHistory } from "../../src/indexer/scip-failure-history.js";
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

      const progressResult = await getIndexProgress(
        { workspace: workspaceRoot, indexPath },
        { includeEvents: true, limit: 200 },
      );
      expect(progressResult.events?.map((event) => event.currentStep)).toEqual(
        expect.arrayContaining([
          "module-resolution",
          "resolved-module-graph",
          "framework-graph",
          "relationship-graph",
          "test-linking",
          "final-call-promotion",
          "embedding-batch",
          "graph-schema",
          "graph-node-write",
          "graph-edge-write",
          "graph-vector-index",
          "graph-close",
          "generation-manifest-write",
          "active-generation-publish",
          "root-manifest-copy",
        ]),
      );
      expect(progressResult.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "discovery_summary",
            discovery: expect.objectContaining({
              totals: expect.objectContaining({
                includedFiles: expect.any(Number),
                unsupportedFiles: expect.any(Number),
                ignoredDirectories: expect.any(Number),
                tsconfigExcludedFiles: expect.any(Number),
                outsideSourceRootFiles: expect.any(Number),
              }),
            }),
          }),
          expect.objectContaining({
            event: "scip_quality",
            currentRepo: expect.any(String),
            scip: expect.objectContaining({
              outputBytes: expect.any(Number),
              durationMs: expect.any(Number),
              definitions: expect.any(Number),
              references: expect.any(Number),
              occurrences: expect.any(Number),
              warnings: expect.any(Array),
            }),
          }),
          expect.objectContaining({
            event: "step_progress",
            phase: "embeddings",
            currentStep: "embedding-batch",
            counters: expect.objectContaining({
              embeddingBatchesCompleted: expect.any(Number),
              chunksVisited: expect.any(Number),
              chunksEmbedded: expect.any(Number),
              embeddingInputsTotal: expect.any(Number),
              embeddingInputsMissing: expect.any(Number),
              embeddingInputTokensMax: expect.any(Number),
              embeddingInputTokensP50: expect.any(Number),
              embeddingInputTokensP95: expect.any(Number),
              embeddingInputOversized: expect.any(Number),
              embeddingBatchMaxTokens: expect.any(Number),
              embeddingBatchPaddingWasteTokens: expect.any(Number),
              embeddingElapsedMs: expect.any(Number),
              embeddingEstimatedRemainingMs: expect.any(Number),
            }),
            memory: expect.objectContaining({
              rssMb: expect.any(Number),
              heapUsedMb: expect.any(Number),
            }),
          }),
          expect.objectContaining({
            event: "step_progress",
            phase: "graph",
            currentStep: "graph-node-write",
            counters: expect.objectContaining({
              nodesWritten: expect.any(Number),
              chunksWritten: expect.any(Number),
              nodeWriteBatches: expect.any(Number),
            }),
          }),
          expect.objectContaining({
            event: "step_progress",
            phase: "graph",
            currentStep: "graph-edge-write",
            counters: expect.objectContaining({
              edgesWritten: expect.any(Number),
              edgeWriteBatches: expect.any(Number),
            }),
          }),
          expect.objectContaining({
            event: "step_succeeded",
            phase: "publishing",
            currentStep: "active-generation-publish",
          }),
        ]),
      );
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(indexPath, { recursive: true, force: true });
    }
  }, 60_000);

  it("separates initial shard counts from adaptive attempts and leaf outcomes", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "code-intel-adaptive-scip-counters-repo-"));
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-adaptive-scip-counters-index-"));
    try {
      await mkdir(join(repoPath, "src"), { recursive: true });
      await writeFile(join(repoPath, "package.json"), JSON.stringify({ name: "@fixture/adaptive-counters" }));
      await writeFile(join(repoPath, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
      await writeFile(join(repoPath, "src", "a.ts"), "export const a = 1;\n");
      await writeFile(join(repoPath, "src", "b.ts"), "export const b = 2;\n");
      await writeFile(join(repoPath, "src", "c.ts"), "export const c = 3;\n");
      let calls = 0;

      const manifest = await indexWorkspace({
        workspaceRoot: repoPath,
        repoPaths: [repoPath],
        indexPath,
        embeddingProviderName: "hash",
        policy: resolveIndexPolicy({ profile: "balanced", overrides: { scip: { maxRetrySplits: 1 } } }),
        runScipTypescript: async (input) => {
          calls += 1;
          if (calls === 1) {
            return {
              ok: false,
              outputPath: input.outputPath,
              outputBytes: 0,
              durationMs: 10,
              stdout: "",
              stderr: "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
              exitCode: 1,
              signal: null,
              timedOut: false,
            };
          }
          return {
            ok: false,
            outputPath: input.outputPath,
            outputBytes: 0,
            durationMs: 10,
            stdout: "",
            stderr: "scip-typescript timed out after 120000ms",
            exitCode: 1,
            signal: null,
            timedOut: true,
          };
        },
      });

      expect(manifest.scip).toMatchObject({
        shardsPlanned: 1,
        shardsSucceeded: 0,
        initialShardsPlanned: 1,
        initialShardsSucceeded: 0,
        initialShardsFailed: 1,
        shardAttempts: 3,
        leafShardsSucceeded: 0,
        leafShardsFailed: 2,
        oomSplits: 1,
        heapEscalations: 0,
      });
      expect(await readScipFailureHistory(indexPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            repo: expect.any(String),
            failureKind: "oom",
            recovered: true,
            filePaths: [
              "src/a.ts",
              "src/b.ts",
              "src/c.ts",
            ],
          }),
        ]),
      );
    } finally {
      await rm(repoPath, { recursive: true, force: true });
      await rm(indexPath, { recursive: true, force: true });
    }
  });

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
        errorDetails: {
          name: "Error",
          stack: expect.stringContaining("Repository path"),
        },
      });
      const progressResult = await getIndexProgress(
        { workspace: workspaceRoot, indexPath },
        { includeEvents: true, limit: 10 },
      );
      expect(progressResult.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "run_failed",
            error: expect.objectContaining({
              name: "Error",
              message: expect.stringContaining("Repository path"),
              stack: expect.stringContaining("Repository path"),
            }),
          }),
        ]),
      );
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
