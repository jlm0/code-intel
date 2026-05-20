import { describe, expect, it } from "vitest";

import {
  embedGraphChunks,
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

    expect(result).toEqual({
      embedded: 3,
      reused: 1,
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
    batches,
    async embed(text: string): Promise<number[]> {
      return [text.length, text.length + 1];
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      batches.push(texts);
      return texts.map((text, index) => [text.length, index]);
    },
  };
}
