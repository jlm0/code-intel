import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  embedGraphChunks,
  readDurableEmbeddingCache,
  type EmbeddableChunkNode,
} from "../../src/indexer/chunk-embeddings.js";
import { chunkEmbeddingInput } from "../../src/indexer/embedding-input.js";
import type { ChunkFact } from "../../src/indexer/fact-cache.js";
import { schemaVersion } from "../../src/schema/schemas.js";
import type { EmbeddingProvider } from "../../src/vectors/embedding.js";

describe("chunk embeddings", () => {
  it("reuses cached embeddings and embeds each missing input once", async () => {
    const cached = chunk("cached", "Cached", "already embedded", "hash-cached");
    const duplicateLeft = chunk("duplicate-left", "Duplicate", "same input", "hash-duplicate");
    const duplicateRight = chunk("duplicate-right", "Duplicate", "same input", "hash-duplicate");
    const unique = chunk("unique", "Unique", "fresh input", "hash-unique");
    const provider = countingProvider();

    const result = await embedGraphChunks(
      new Map([
        [cached.id, cached],
        [duplicateLeft.id, duplicateLeft],
        [duplicateRight.id, duplicateRight],
        [unique.id, unique],
      ]),
      provider,
      new Map([["hash-cached", [0.25, 0.75]]]),
    );

    expect(result).toMatchObject({
      embedded: 3,
      reused: 1,
      embeddingInput: expect.objectContaining({
        inputsTotal: 3,
        duplicateInputChunks: 1,
      }),
    });
    expect(provider.batches).toEqual([[
      chunkEmbeddingInput(duplicateLeft),
      chunkEmbeddingInput(unique),
    ]]);
    expect(cached.embedding).toEqual([0.25, 0.75]);
    expect(cached.fact.embedding).toEqual([0.25, 0.75]);
    expect(duplicateLeft.embedding).toEqual(duplicateRight.embedding);
    expect(duplicateLeft.fact.embedding).toEqual(duplicateLeft.embedding);
    expect(duplicateRight.fact.embedding).toEqual(duplicateRight.embedding);
  });

  it("reports embedding batch progress while missing chunks are embedded", async () => {
    const first = chunk("first", "First", "first input", "hash-first");
    const second = chunk("second", "Second", "second input", "hash-second");
    const third = chunk("third", "Third", "third input", "hash-third");
    const provider = countingProvider();
    const progress: Array<{
      event: string;
      batchIndex: number;
      batchSize: number;
      batchesCompleted: number;
      chunksEmbedded: number;
      chunksVisited: number;
    }> = [];

    await embedGraphChunks(
      new Map([
        [first.id, first],
        [second.id, second],
        [third.id, third],
      ]),
      provider,
      new Map(),
      {
        batchSize: 2,
        onProgress: (update) => {
          progress.push(update);
        },
      },
    );

    expect(progress).toMatchObject([
      {
        event: "batch_started",
        batchIndex: 1,
        batchSize: 2,
        batchesCompleted: 0,
        chunksEmbedded: 0,
        chunksVisited: 3,
      },
      {
        event: "batch_completed",
        batchIndex: 1,
        batchSize: 2,
        batchesCompleted: 1,
        chunksEmbedded: 2,
        chunksVisited: 3,
      },
      {
        event: "batch_started",
        batchIndex: 2,
        batchSize: 1,
        batchesCompleted: 1,
        chunksEmbedded: 2,
        chunksVisited: 3,
      },
      {
        event: "batch_completed",
        batchIndex: 2,
        batchSize: 1,
        batchesCompleted: 2,
        chunksEmbedded: 3,
        chunksVisited: 3,
      },
    ]);
  });

  it("groups missing embedding inputs by token length while preserving chunk assignment", async () => {
    const shortLeft = chunk("short-left", "ShortLeft", "tiny alpha", "hash-short-left");
    const longLeft = chunk("long-left", "LongLeft", "long ".repeat(120), "hash-long-left");
    const shortRight = chunk("short-right", "ShortRight", "tiny beta", "hash-short-right");
    const longRight = chunk("long-right", "LongRight", "verbose ".repeat(130), "hash-long-right");
    const provider = countingProvider();

    await embedGraphChunks(
      new Map([
        [shortLeft.id, shortLeft],
        [longLeft.id, longLeft],
        [shortRight.id, shortRight],
        [longRight.id, longRight],
      ]),
      provider,
      new Map(),
      { batchSize: 2 },
    );

    expect(provider.batches).toEqual([
      [chunkEmbeddingInput(shortLeft), chunkEmbeddingInput(shortRight)],
      [chunkEmbeddingInput(longLeft), chunkEmbeddingInput(longRight)],
    ]);
    expect(shortLeft.embedding).toEqual([chunkEmbeddingInput(shortLeft).length, 0]);
    expect(shortRight.embedding).toEqual([chunkEmbeddingInput(shortRight).length, 1]);
    expect(longLeft.embedding).toEqual([chunkEmbeddingInput(longLeft).length, 0]);
    expect(longRight.embedding).toEqual([chunkEmbeddingInput(longRight).length, 1]);
  });

  it("reports token telemetry and padding waste for embedding batches", async () => {
    const short = chunk("short", "Short", "tiny", "hash-short");
    const long = chunk("long", "Long", "long ".repeat(40), "hash-long");
    const provider = countingProvider();
    const progress: Array<Record<string, unknown>> = [];

    await embedGraphChunks(
      new Map([
        [short.id, short],
        [long.id, long],
      ]),
      provider,
      new Map(),
      {
        batchSize: 2,
        onProgress: (update) => {
          progress.push(update as unknown as Record<string, unknown>);
        },
      },
    );

    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "batch_started",
          embeddingInputsTotal: 2,
          embeddingInputsMissing: 2,
          inputTokensMax: expect.any(Number),
          inputTokensP50: expect.any(Number),
          inputTokensP95: expect.any(Number),
          oversizedInputs: 0,
          batchMaxTokens: expect.any(Number),
          batchPaddingWasteTokens: expect.any(Number),
        }),
      ]),
    );
  });

  it("plans batches by padded and total token ceilings before fixed batch size", async () => {
    const entries = [
      chunk("one", "One", "a b", "hash-one"),
      chunk("two", "Two", "a b c", "hash-two"),
      chunk("three", "Three", "a b c d e", "hash-three"),
      chunk("four", "Four", "a b c d e f", "hash-four"),
    ];
    const provider = countingProvider();

    await embedGraphChunks(
      new Map(entries.map((entry) => [entry.id, entry])),
      provider,
      new Map(),
      {
        batchSize: 10,
        maxBatchTotalTokens: 8,
        maxBatchPaddedTokens: 18,
      },
    );

    expect(provider.batches.map((batch) => batch.length)).toEqual([2, 1, 1]);
  });

  it("flushes successful embedding batches to a durable provider/model cache", async () => {
    const first = chunk("durable-first", "DurableFirst", "cache me", "hash-durable-first");
    const second = chunk("durable-second", "DurableSecond", "cache me too", "hash-durable-second");
    const provider = countingProvider();
    const cacheDir = await mkdtemp(join(tmpdir(), "code-intel-embedding-cache-"));
    const cachePath = join(cacheDir, "cache.json");

    try {
      await embedGraphChunks(
        new Map([[first.id, first], [second.id, second]]),
        provider,
        new Map(),
        {
          batchSize: 1,
          durableCache: {
            path: cachePath,
            provider: provider.provider,
            model: provider.model,
            dimension: provider.dimension,
          },
        },
      );

      const durable = await readDurableEmbeddingCache({
        path: cachePath,
        provider: provider.provider,
        model: provider.model,
        dimension: provider.dimension,
      });
      expect(durable.get("hash-durable-first")).toEqual(first.embedding);
      expect(durable.get("hash-durable-second")).toEqual(second.embedding);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});

function chunk(
  id: string,
  name: string,
  content: string,
  embeddingInputHash: string,
): EmbeddableChunkNode {
  const fact: ChunkFact = {
    idSuffix: id,
    name,
    kind: "Chunk",
    range: {
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 1,
    },
    content,
    contentHash: `${id}-content`,
    calls: [],
    embeddingInputHash,
  };
  return {
    schemaVersion,
    id,
    kind: "Chunk",
    workspace: "workspace",
    repo: "repo",
    file: `${id}.ts`,
    name,
    language: "typescript",
    range: {
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 1,
    },
    textHash: `${id}-text`,
    metadata: {},
    content,
    embedding: [],
    embeddingInputHash,
    fact,
  };
}

function countingProvider(): EmbeddingProvider & { batches: string[][] } {
  const batches: string[][] = [];
  return {
    provider: "hash",
    model: "counting-test",
    dimension: 2,
    maxInputTokens: 8_192,
    batches,
    async embed(text: string): Promise<number[]> {
      return [text.length, text.length + 1];
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      batches.push(texts);
      return texts.map((text, index) => [text.length, index]);
    },
    async countTokens(texts: string[]): Promise<number[]> {
      return texts.map((text) => text.split(/\s+/).filter(Boolean).length);
    },
  };
}
