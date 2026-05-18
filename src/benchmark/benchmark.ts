import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { schemaVersion, type IncrementalStats, type IndexManifest } from "../schema/schemas.js";
import { indexWorkspace, updateWorkspace } from "../indexer/indexer.js";
import { createQueryEngine } from "../query/query-engine.js";
import { createEmbeddingProvider } from "../vectors/embedding.js";
import { loadEvalPack, prepareEvalCorpus } from "../eval/eval-pack.js";
import { firstDeletableSourceFile, firstSourceFile } from "./corpus-files.js";

export const benchmarkSchemaVersion = "code-intel.benchmark.v1";

export interface BenchmarkOptions {
  workspace?: string;
  suite?: string;
  evalPack?: string;
  evalCachePath?: string;
  fetch?: boolean;
  embeddingProvider?: string;
  embeddingModel?: string;
  includeMcpLatency?: boolean;
}

export interface BenchmarkReport {
  schemaVersion: typeof schemaVersion;
  benchmarkSchemaVersion: typeof benchmarkSchemaVersion;
  suite: {
    id: string;
    name: string;
    kind: string;
  };
  corpus: {
    path: string;
    repoPaths: string[];
  };
  embedding: IndexManifest["embedding"];
  scenarios: {
    coldIndex: BenchmarkIndexScenario;
    warmUpdate: BenchmarkIndexScenario;
    oneFileUpdate: BenchmarkIndexScenario;
    deletedFileUpdate: BenchmarkIndexScenario;
    queryLatency: {
      semanticMs: number;
      findSymbolMs: number;
    };
    mcpQueryLatency: {
      semanticMs?: number;
      skipped?: boolean;
      reason?: string;
    };
    ladybugLock: {
      concurrentRead: "pass" | "fail";
      latencyMs: number;
    };
  };
  batching: {
    embeddingBatchSize: number;
    graphNodeBatchSize: number;
    graphEdgeBatchSize: number;
  };
  memory: {
    peakRssMb: number;
  };
}

export interface BenchmarkIndexScenario {
  durationMs: number;
  stats: IndexManifest["stats"];
  incremental?: IncrementalStats;
}

export async function runBenchmarkSuite(options: BenchmarkOptions = {}): Promise<BenchmarkReport> {
  const workspaceRoot = resolve(options.workspace ?? process.cwd());
  const loadedPack = await loadEvalPack({
    suite: options.evalPack ? options.suite : options.suite ?? "js-ts-general",
    evalPackPath: options.evalPack,
    workspaceRoot,
  });
  const preparedCorpus = await prepareEvalCorpus({
    loadedPack,
    workspaceRoot,
    evalCachePath: options.evalCachePath,
    fetch: options.fetch,
  });
  const tempRoot = await mkdtemp(join(tmpdir(), "code-intel-benchmark-"));
  const benchmarkWorkspace = join(tempRoot, "workspace");
  const indexPath = join(tempRoot, "index");
  const memorySamples: number[] = [];

  try {
    await cp(preparedCorpus.path, benchmarkWorkspace, { recursive: true });
    const repoPaths = preparedCorpus.repoPaths.map((repoPath) =>
      join(benchmarkWorkspace, relative(preparedCorpus.path, repoPath)),
    );
    const embeddingProvider = await createEmbeddingProvider({
      provider: options.embeddingProvider,
      model: options.embeddingModel,
      indexPath,
    });

    const coldIndex = await measureIndexScenario(memorySamples, () =>
      indexWorkspace({
        workspaceRoot: benchmarkWorkspace,
        repoPaths,
        indexPath,
        embeddingProvider,
      }),
    );
    const warmUpdate = await measureIndexScenario(memorySamples, () =>
      updateWorkspace({
        workspaceRoot: benchmarkWorkspace,
        repoPaths,
        indexPath,
        embeddingProvider,
      }),
    );

    const changedFile = await firstSourceFile(repoPaths);
    await writeFile(changedFile, `${await readFile(changedFile, "utf8")}\nexport const benchmarkChangedValue = true;\n`);
    const oneFileUpdate = await measureIndexScenario(memorySamples, () =>
      updateWorkspace({
        workspaceRoot: benchmarkWorkspace,
        repoPaths,
        indexPath,
        embeddingProvider,
      }),
    );

    const deletedFile = await firstDeletableSourceFile(repoPaths, changedFile);
    await rm(deletedFile, { force: true });
    const deletedFileUpdate = await measureIndexScenario(memorySamples, () =>
      updateWorkspace({
        workspaceRoot: benchmarkWorkspace,
        repoPaths,
        indexPath,
        embeddingProvider,
      }),
    );

    const queryLatency = await measureQueryLatency(indexPath, memorySamples);
    const ladybugLock = await measureConcurrentRead(indexPath, memorySamples);
    const mcpQueryLatency = options.includeMcpLatency === false
      ? { skipped: true, reason: "disabled for focused benchmark run" }
      : await measureMcpLatency({ benchmarkWorkspace, indexPath, embeddingProvider: embeddingProvider.provider });

    return {
      schemaVersion,
      benchmarkSchemaVersion,
      suite: {
        id: loadedPack.pack.id,
        name: loadedPack.pack.name,
        kind: loadedPack.pack.kind,
      },
      corpus: {
        path: benchmarkWorkspace,
        repoPaths,
      },
      embedding: coldIndex.manifest.embedding,
      scenarios: {
        coldIndex: stripScenarioManifest(coldIndex),
        warmUpdate: stripScenarioManifest(warmUpdate),
        oneFileUpdate: stripScenarioManifest(oneFileUpdate),
        deletedFileUpdate: stripScenarioManifest(deletedFileUpdate),
        queryLatency,
        mcpQueryLatency,
        ladybugLock,
      },
      batching: {
        embeddingBatchSize: 16,
        graphNodeBatchSize: 200,
        graphEdgeBatchSize: 100,
      },
      memory: {
        peakRssMb: Math.max(...memorySamples, rssMb()),
      },
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function stripScenarioManifest(input: BenchmarkIndexScenario & { manifest: IndexManifest }): BenchmarkIndexScenario {
  return {
    durationMs: input.durationMs,
    stats: input.stats,
    incremental: input.incremental,
  };
}

async function measureIndexScenario(
  memorySamples: number[],
  callback: () => Promise<IndexManifest>,
): Promise<BenchmarkIndexScenario & { manifest: IndexManifest }> {
  const start = performance.now();
  const manifest = await callback();
  memorySamples.push(rssMb());
  return {
    durationMs: elapsedMs(start),
    stats: manifest.stats,
    incremental: manifest.incremental,
    manifest,
  };
}

async function measureQueryLatency(
  indexPath: string,
  memorySamples: number[],
): Promise<BenchmarkReport["scenarios"]["queryLatency"]> {
  const engine = createQueryEngine({ indexPath });
  try {
    const semanticStart = performance.now();
    await engine.semanticSearch("giving receipt summary", { limit: 5 });
    const semanticMs = elapsedMs(semanticStart);
    const symbolStart = performance.now();
    await engine.findSymbol("calculateGivingTotal", { limit: 5 });
    const findSymbolMs = elapsedMs(symbolStart);
    memorySamples.push(rssMb());
    return { semanticMs, findSymbolMs };
  } finally {
    await engine.close();
  }
}

async function measureConcurrentRead(
  indexPath: string,
  memorySamples: number[],
): Promise<BenchmarkReport["scenarios"]["ladybugLock"]> {
  const start = performance.now();
  const engine = createQueryEngine({ indexPath });
  try {
    await Promise.all([
      engine.findSymbol("calculateGivingTotal", { limit: 5 }),
      engine.semanticSearch("giving receipt summary", { limit: 5 }),
    ]);
    memorySamples.push(rssMb());
    return { concurrentRead: "pass", latencyMs: elapsedMs(start) };
  } catch {
    return { concurrentRead: "fail", latencyMs: elapsedMs(start) };
  } finally {
    await engine.close();
  }
}

async function measureMcpLatency(input: {
  benchmarkWorkspace: string;
  indexPath: string;
  embeddingProvider: string;
}): Promise<BenchmarkReport["scenarios"]["mcpQueryLatency"]> {
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "cli", "main.js");
  const transport = new StdioClientTransport({
    command: "node",
    args: [
      cliPath,
      "mcp",
      "--workspace",
      input.benchmarkWorkspace,
      "--index-path",
      input.indexPath,
      "--embedding-provider",
      input.embeddingProvider,
    ],
    stderr: "pipe",
  });
  const client = new Client({ name: "code-intel-benchmark", version: "0.1.0" });
  const start = performance.now();
  try {
    await client.connect(transport);
    await client.callTool({
      name: "semantic_search",
      arguments: { query: "giving receipt summary", limit: 5 },
    });
    return { semanticMs: elapsedMs(start) };
  } catch (error) {
    return { skipped: true, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function rssMb(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function elapsedMs(start: number): number {
  return Math.max(0, Math.round(performance.now() - start));
}
