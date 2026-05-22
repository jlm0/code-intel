import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { schemaVersion, type CodeEdge, type CodeNode, type IncrementalStats, type IndexManifest } from "../schema/schemas.js";
import { indexWorkspace, updateWorkspace } from "../indexer/indexer.js";
import { LadybugGraphStore, type GraphGenerationTimings } from "../graph/ladybug-store.js";
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
  graphStoreScale?: {
    nodes: number;
    edges: number;
    chunks: number;
  };
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
  embeddingInput?: NonNullable<IndexManifest["embeddingInput"]>;
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
    graphStorePublish: {
      schemaMs: number;
      nodeWriteMs: number;
      edgeWriteMs: number;
      vectorIndexMs: number;
      closeMs: number;
      publishMs: number;
      totalMs: number;
      peakRssMb: number;
      scale: {
        nodes: number;
        edges: number;
        chunks: number;
      };
      failureClassification: "none" | "graph-store-lifecycle" | "active-generation-pointer" | "test-harness" | "unknown";
      failureMessage?: string;
    };
    ladybugLock: {
      concurrentRead: "pass" | "fail";
      readerDuringUpdate: "pass" | "fail";
      readerAfterPublish: "pass" | "fail";
      latencyMs: number;
      retryCount: number;
      queueWaitMs: number;
      lockWaitMs: number;
      failureClassification:
        | "none"
        | "ladybug-connection-limit"
        | "graph-store-lifecycle"
        | "active-generation-pointer"
        | "mcp-server-reuse"
        | "test-harness"
        | "unknown";
      failureMessage?: string;
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

const defaultGraphStoreScale = {
  nodes: 10_000,
  edges: 100_000,
  chunks: 2_000,
};

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
    const ladybugLock = await measureConcurrentAccess({
      benchmarkWorkspace,
      repoPaths,
      indexPath,
      embeddingProvider,
      memorySamples,
    });
    const graphStorePublish = await measureGraphStorePublish(
      memorySamples,
      options.graphStoreScale ?? defaultGraphStoreScale,
    );
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
      embeddingInput: coldIndex.manifest.embeddingInput,
      scenarios: {
        coldIndex: stripScenarioManifest(coldIndex),
        warmUpdate: stripScenarioManifest(warmUpdate),
        oneFileUpdate: stripScenarioManifest(oneFileUpdate),
        deletedFileUpdate: stripScenarioManifest(deletedFileUpdate),
        queryLatency,
        mcpQueryLatency,
        graphStorePublish,
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

async function measureGraphStorePublish(
  memorySamples: number[],
  scale: { nodes: number; edges: number; chunks: number },
): Promise<BenchmarkReport["scenarios"]["graphStorePublish"]> {
  const indexPath = await mkdtemp(join(tmpdir(), "code-intel-graph-store-benchmark-"));
  const start = performance.now();
  const timings: GraphGenerationTimings = {
    schemaMs: 0,
    nodeWriteMs: 0,
    edgeWriteMs: 0,
    vectorIndexMs: 0,
    closeMs: 0,
    publishMs: 0,
  };
  try {
    const store = new LadybugGraphStore(indexPath);
    const input = createSyntheticGraphWriteInput(scale);
    const generation = await store.rebuild(input);
    Object.assign(timings, generation.timings);
    const publish = await store.publishGeneration(generation.generationId);
    timings.publishMs = publish.durationMs;
    const peakRssMb = rssMb();
    memorySamples.push(peakRssMb);
    return {
      ...timings,
      totalMs: elapsedMs(start),
      peakRssMb,
      scale,
      failureClassification: "none",
    };
  } catch (error) {
    const peakRssMb = rssMb();
    memorySamples.push(peakRssMb);
    return {
      ...timings,
      totalMs: elapsedMs(start),
      peakRssMb,
      scale,
      failureClassification: classifyGraphStorePublishFailure(error),
      failureMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await rm(indexPath, { recursive: true, force: true });
  }
}

function createSyntheticGraphWriteInput(scale: {
  nodes: number;
  edges: number;
  chunks: number;
}): Parameters<LadybugGraphStore["rebuild"]>[0] {
  const embeddingDimension = 8;
  const nodes = new Map<string, CodeNode>();
  const chunksById = new Map<string, CodeNode & { content: string; embedding: number[] }>();
  const fileCount = Math.max(1, Math.min(500, Math.floor(scale.nodes * 0.1)));
  for (let index = 0; index < fileCount; index += 1) {
    const node = graphNode(`file:${index}`, "File", {
      file: `src/file-${index}.ts`,
      name: `file-${index}.ts`,
    });
    nodes.set(node.id, node);
  }
  const chunkCount = Math.min(scale.chunks, scale.nodes);
  for (let index = 0; index < chunkCount; index += 1) {
    const node = graphNode(`chunk:${index}`, "Chunk", {
      file: `src/file-${index % fileCount}.ts`,
      name: `chunk${index}`,
    }) as CodeNode & { content: string; embedding: number[] };
    node.content = `export function chunk${index}() { return ${index}; }`;
    node.embedding = Array.from({ length: embeddingDimension }, (_, dimension) =>
      ((index + dimension) % embeddingDimension) / embeddingDimension
    );
    nodes.set(node.id, node);
    chunksById.set(node.id, node);
  }
  for (let index = nodes.size; index < scale.nodes; index += 1) {
    const node = graphNode(`symbol:${index}`, "Function", {
      file: `src/file-${index % fileCount}.ts`,
      name: `symbol${index}`,
    });
    nodes.set(node.id, node);
  }

  const nodeIds = [...nodes.keys()];
  const edges = new Map<string, CodeEdge>();
  const edgeKinds: CodeEdge["kind"][] = ["CONTAINS", "DEFINES", "HAS_CHUNK", "REFERENCES", "CALLS"];
  for (let index = 0; index < scale.edges; index += 1) {
    const fromId = nodeIds[index % nodeIds.length]!;
    const toId = nodeIds[(index * 17 + 11) % nodeIds.length]!;
    const kind = edgeKinds[index % edgeKinds.length]!;
    edges.set(`edge:${index}`, {
      schemaVersion,
      id: `edge:${index}`,
      kind,
      fromId,
      toId,
      workspace: "graph-store-benchmark",
      repo: "synthetic",
      metadata: {
        origin: "benchmark",
        sequence: index,
      },
    });
  }

  return {
    nodes,
    edges,
    chunksById,
    embeddingDimension,
  };
}

function graphNode(
  id: string,
  kind: CodeNode["kind"],
  input: { file: string; name: string },
): CodeNode {
  return {
    schemaVersion,
    id,
    kind,
    workspace: "graph-store-benchmark",
    repo: "synthetic",
    file: input.file,
    name: input.name,
    language: "typescript",
    range: {
      startLine: 1,
      endLine: 2,
      startColumn: 0,
      endColumn: 1,
    },
    metadata: {
      ownerRepo: "synthetic",
      ownerFile: input.file,
      origin: "benchmark",
    },
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

async function measureConcurrentAccess(input: {
  benchmarkWorkspace: string;
  repoPaths: string[];
  indexPath: string;
  embeddingProvider: Awaited<ReturnType<typeof createEmbeddingProvider>>;
  memorySamples: number[];
}): Promise<BenchmarkReport["scenarios"]["ladybugLock"]> {
  const start = performance.now();
  const stats = createAccessStats();
  const engine = createQueryEngine({ indexPath: input.indexPath });
  let concurrentRead: "pass" | "fail" = "pass";
  let readerDuringUpdate: "pass" | "fail" = "pass";
  let readerAfterPublish: "pass" | "fail" = "pass";
  let failureClassification: BenchmarkReport["scenarios"]["ladybugLock"]["failureClassification"] = "none";
  let failureMessage: string | undefined;

  try {
    await Promise.all([
      engine.findSymbol("calculateGivingTotal", { limit: 5 }),
      engine.semanticSearch("giving receipt summary", { limit: 5 }),
    ]);
  } catch (error) {
    concurrentRead = "fail";
    failureClassification = classifyConcurrencyFailure(error);
    failureMessage = error instanceof Error ? error.message : String(error);
  } finally {
    mergeQueryStats(stats, engine.getRuntimeStats());
    await engine.close();
  }

  try {
    const changedFile = await firstSourceFile(input.repoPaths);
    await writeFile(
      changedFile,
      `${await readFile(changedFile, "utf8")}\nexport const benchmarkConcurrentUpdateValue = true;\n`,
    );
    const updatePromise = updateWorkspace({
      workspaceRoot: input.benchmarkWorkspace,
      repoPaths: input.repoPaths,
      indexPath: input.indexPath,
      embeddingProvider: input.embeddingProvider,
    });
    const reader = createQueryEngine({ indexPath: input.indexPath });
    try {
      await reader.findSymbol("calculateGivingTotal", { limit: 5 });
    } catch (error) {
      readerDuringUpdate = "fail";
      failureClassification = failureClassification === "none" ? classifyConcurrencyFailure(error) : failureClassification;
      failureMessage ??= error instanceof Error ? error.message : String(error);
    } finally {
      mergeQueryStats(stats, reader.getRuntimeStats());
      await reader.close();
    }
    await updatePromise;
    const afterPublish = createQueryEngine({ indexPath: input.indexPath });
    try {
      const result = await afterPublish.findSymbol("benchmarkConcurrentUpdateValue", { limit: 5 });
      if (result.results.length === 0) {
        readerAfterPublish = "fail";
        failureClassification = failureClassification === "none" ? "active-generation-pointer" : failureClassification;
        failureMessage ??= "Updated symbol was not visible after active generation publish.";
      }
    } catch (error) {
      readerAfterPublish = "fail";
      failureClassification = failureClassification === "none" ? classifyConcurrencyFailure(error) : failureClassification;
      failureMessage ??= error instanceof Error ? error.message : String(error);
    } finally {
      mergeQueryStats(stats, afterPublish.getRuntimeStats());
      await afterPublish.close();
    }
  } catch (error) {
    readerDuringUpdate = "fail";
    readerAfterPublish = "fail";
    failureClassification = failureClassification === "none" ? classifyConcurrencyFailure(error) : failureClassification;
    failureMessage ??= error instanceof Error ? error.message : String(error);
  }

  input.memorySamples.push(rssMb());
  return {
    concurrentRead,
    readerDuringUpdate,
    readerAfterPublish,
    latencyMs: elapsedMs(start),
    retryCount: stats.retryCount,
    queueWaitMs: Math.round(stats.queueWaitMs),
    lockWaitMs: Math.round(stats.lockWaitMs),
    failureClassification,
    ...(failureMessage ? { failureMessage } : {}),
  };
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

function createAccessStats(): { retryCount: number; queueWaitMs: number; lockWaitMs: number } {
  return {
    retryCount: 0,
    queueWaitMs: 0,
    lockWaitMs: 0,
  };
}

function mergeQueryStats(
  target: { retryCount: number; queueWaitMs: number; lockWaitMs: number },
  stats: ReturnType<ReturnType<typeof createQueryEngine>["getRuntimeStats"]>,
): void {
  target.queueWaitMs += stats.queueWaitMs;
  target.lockWaitMs += stats.store?.lockWaitMs ?? 0;
  target.retryCount += stats.store?.openRetryCount ?? 0;
}

function classifyConcurrencyFailure(
  error: unknown,
): BenchmarkReport["scenarios"]["ladybugLock"]["failureClassification"] {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Could not set lock") || message.includes("shadow file") || message.includes(".shadow")) {
    return "ladybug-connection-limit";
  }
  if (message.includes("Ladybug process lock") || message.includes(".ladybug.lock")) {
    return "graph-store-lifecycle";
  }
  if (message.includes("current.json") || message.includes("generation") || message.includes("active")) {
    return "active-generation-pointer";
  }
  if (message.includes("MCP") || message.includes("stdio")) {
    return "mcp-server-reuse";
  }
  if (message.includes("benchmark") || message.includes("fixture")) {
    return "test-harness";
  }
  return "unknown";
}

function classifyGraphStorePublishFailure(
  error: unknown,
): BenchmarkReport["scenarios"]["graphStorePublish"]["failureClassification"] {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Ladybug process lock") || message.includes(".ladybug.lock")) {
    return "graph-store-lifecycle";
  }
  if (message.includes("current.json") || message.includes("generation") || message.includes("active")) {
    return "active-generation-pointer";
  }
  if (message.includes("benchmark") || message.includes("synthetic")) {
    return "test-harness";
  }
  return "unknown";
}
