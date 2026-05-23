import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("indexing memory source contracts", () => {
  it("runs SCIP with explicit project shards instead of only the repo root", async () => {
    const runner = await source("src/scip/runner.ts");

    expect(runner.includes("projectPaths"), "RunScipTypescriptInput should accept explicit projectPaths").toBe(true);
  });

  it("runs scip-typescript through a configurable Node heap", async () => {
    const runner = await source("src/scip/runner.ts");

    expect(runner.includes("--max-old-space-size"), "runner should invoke Node with --max-old-space-size").toBe(true);
  });

  it("disables scip-typescript global caches for large or sharded work", async () => {
    const runner = await source("src/scip/runner.ts");

    expect(runner.includes("--no-global-caches"), "runner should pass --no-global-caches").toBe(true);
  });

  it("does not record a failed SCIP child process as step_succeeded before checking ok", async () => {
    const indexer = await source("src/indexer/indexer.ts");
    const scipRunIndex = indexer.indexOf("const outcomes = await executeAdaptiveScipShard");
    const successEventIndex = indexer.indexOf('event: "step_succeeded"', scipRunIndex);
    const okCheckIndex = indexer.indexOf("if (scipRun.ok)", scipRunIndex);

    expect(scipRunIndex).toBeGreaterThanOrEqual(0);
    expect(okCheckIndex).toBeGreaterThan(scipRunIndex);
    expect(
      successEventIndex === -1 || successEventIndex > okCheckIndex,
      "SCIP step_succeeded should not be emitted before scipRun.ok is checked",
    ).toBe(true);
  });

  it("routes tiny or zero-fact successful SCIP output through fallback handling", async () => {
    const indexer = await source("src/indexer/indexer.ts");

    expect(
      /scip-empty-or-tiny[\s\S]*addTreeSitterFallbackRelationships|addTreeSitterFallbackRelationships[\s\S]*scip-empty-or-tiny/.test(indexer),
      "indexer should route scip-empty-or-tiny through Tree-sitter fallback",
    ).toBe(true);
  });

  it("spills per-repo SCIP facts instead of retaining all repo facts until publish", async () => {
    const indexer = await source("src/indexer/indexer.ts");

    expect(indexer.includes("const scipFactsByRepo"), "workspace-wide scipFactsByRepo retention should be removed").toBe(false);
    expect(indexer.includes("scipFactsByRepo.push"), "SCIP facts should not be retained in an array until publish").toBe(false);
  });

  it("fingerprints and parses source files with bounded concurrency rather than repo-wide Promise.all", async () => {
    const fileFacts = await source("src/indexer/file-facts.ts");

    expect(
      /Promise\.all\(\s*repo\.files\.map/.test(fileFacts),
      "file facts should not read/fingerprint every repo file through one Promise.all",
    ).toBe(false);
  });

  it("embeds chunk inputs incrementally without materializing every chunk and missing input first", async () => {
    const chunkEmbeddings = await source("src/indexer/chunk-embeddings.ts");

    expect(chunkEmbeddings.includes("const chunks = [...chunksById.values()]"), "embedding should not copy all chunks first").toBe(false);
    expect(
      chunkEmbeddings.includes("chunkArray([...missingInputs.values()]"),
      "embedding should not materialize all missing inputs before batching",
    ).toBe(false);
  });

  it("streams graph rows into Ladybug instead of copying full maps into rebuild arrays", async () => {
    const indexer = await source("src/indexer/indexer.ts");
    const ladybugStore = await source("src/graph/ladybug-store.ts");

    expect(indexer.includes("nodes: [...graph.nodes.values()]"), "indexer should not copy all nodes into rebuild arrays").toBe(false);
    expect(indexer.includes("edges: [...graph.edges.values()]"), "indexer should not copy all edges into rebuild arrays").toBe(false);
    expect(indexer.includes("chunks: [...graph.chunks.values()]"), "indexer should not copy all chunks into rebuild arrays").toBe(false);
    expect(ladybugStore.includes("input.nodes.map"), "Ladybug rebuild should not map all nodes before batch writes").toBe(false);
    expect(ladybugStore.includes("input.edges.map"), "Ladybug rebuild should not map all edges before batch writes").toBe(false);
  });

  it("writes large publish artifacts without whole-object JSON stringification", async () => {
    const indexArtifacts = await source("src/core/index-artifacts.ts");

    expect(indexArtifacts.includes("JSON.stringify(value"), "large artifact writes should stream instead of whole-object stringify").toBe(false);
  });

  it("uses the same EPERM-aware liveness helper for index and Ladybug lock recovery", async () => {
    const indexer = await source("src/indexer/indexer.ts");
    const ladybugStore = await source("src/graph/ladybug-store.ts");

    expect(/code === "EPERM"[\s\S]*return true/.test(indexer), "index lock recovery should treat EPERM as alive").toBe(true);
    expect(/code === "EPERM"[\s\S]*return true/.test(ladybugStore), "Ladybug lock recovery should treat EPERM as alive").toBe(true);
  });
});

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}
