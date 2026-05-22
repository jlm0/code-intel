import { describe, expect, it } from "vitest";

import { runBenchmarkSuite } from "../../src/benchmark/benchmark.js";

describe("benchmark harness", () => {
  it("records repeatable indexing, update, query, MCP, batching, memory, and lock metrics", async () => {
    const report = await runBenchmarkSuite({
      suite: "js-ts-general",
      embeddingProvider: "hash",
      includeMcpLatency: false,
      graphStoreScale: { nodes: 120, edges: 300, chunks: 30 },
    });

    expect(report).toMatchObject({
      schemaVersion: "code-intel.v1",
      benchmarkSchemaVersion: "code-intel.benchmark.v1",
      suite: {
        id: "js-ts-general",
      },
      embedding: {
        provider: "hash",
      },
      scenarios: {
        coldIndex: {
          durationMs: expect.any(Number),
          stats: {
            chunks: expect.any(Number),
          },
        },
        warmUpdate: {
          incremental: {
            mode: "incremental",
          },
        },
        oneFileUpdate: {
          incremental: {
            files: {
              changed: 1,
            },
          },
        },
        deletedFileUpdate: {
          incremental: {
            files: {
              deleted: 1,
            },
          },
        },
        queryLatency: {
          semanticMs: expect.any(Number),
          findSymbolMs: expect.any(Number),
        },
        mcpQueryLatency: {
          skipped: true,
        },
        graphStorePublish: {
          nodeWriteMs: expect.any(Number),
          edgeWriteMs: expect.any(Number),
          vectorIndexMs: expect.any(Number),
          closeMs: expect.any(Number),
          publishMs: expect.any(Number),
          totalMs: expect.any(Number),
          peakRssMb: expect.any(Number),
          failureClassification: "none",
          scale: {
            nodes: expect.any(Number),
            edges: expect.any(Number),
            chunks: expect.any(Number),
          },
        },
        ladybugLock: {
          concurrentRead: "pass",
          readerDuringUpdate: "pass",
          readerAfterPublish: "pass",
          retryCount: expect.any(Number),
          queueWaitMs: expect.any(Number),
          lockWaitMs: expect.any(Number),
          failureClassification: "none",
        },
      },
      batching: {
        embeddingBatchSize: 16,
        graphNodeBatchSize: 200,
        graphEdgeBatchSize: 100,
      },
      memory: {
        peakRssMb: expect.any(Number),
      },
    });
  }, 60_000);
});
