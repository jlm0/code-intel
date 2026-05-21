import type { CodeNode } from "../schema/schemas.js";
import type { EmbeddingProvider } from "../vectors/embedding.js";
import type { ChunkFact } from "./fact-cache.js";
import { chunkEmbeddingInput } from "./embedding-input.js";

export type EmbeddableChunkNode = CodeNode & {
  content: string;
  embedding: number[];
  embeddingInputHash: string;
  fact: ChunkFact;
};

export async function embedGraphChunks(
  chunksById: Map<string, EmbeddableChunkNode>,
  embeddingProvider: EmbeddingProvider,
  embeddingCache: Map<string, number[]>,
): Promise<{ embedded: number; reused: number }> {
  const missingInputs = new Map<string, { embeddingInputHash: string; input: string; chunks: EmbeddableChunkNode[] }>();
  let reused = 0;
  let embedded = 0;

  for (const chunk of chunksById.values()) {
    const cachedEmbedding = chunk.embedding.length === embeddingProvider.dimension
      ? chunk.embedding
      : embeddingCache.get(chunk.embeddingInputHash);
    if (cachedEmbedding?.length === embeddingProvider.dimension) {
      chunk.embedding = cachedEmbedding;
      chunk.fact.embedding = cachedEmbedding;
      reused += 1;
    } else {
      const existing = missingInputs.get(chunk.embeddingInputHash);
      if (existing) {
        existing.chunks.push(chunk);
      } else {
        missingInputs.set(chunk.embeddingInputHash, {
          embeddingInputHash: chunk.embeddingInputHash,
          input: chunkEmbeddingInput(chunk),
          chunks: [chunk],
        });
      }
      if (missingInputs.size >= 16) {
        embedded += await flushMissingInputs(missingInputs, embeddingProvider, embeddingCache);
      }
    }
  }

  embedded += await flushMissingInputs(missingInputs, embeddingProvider, embeddingCache);

  return { embedded, reused };
}

async function flushMissingInputs(
  missingInputs: Map<string, { embeddingInputHash: string; input: string; chunks: EmbeddableChunkNode[] }>,
  embeddingProvider: EmbeddingProvider,
  embeddingCache: Map<string, number[]>,
): Promise<number> {
  if (missingInputs.size === 0) {
    return 0;
  }
  const batch = [...missingInputs.values()];
  missingInputs.clear();
  const embeddings = await embeddingProvider.embedBatch(
    batch.map((entry) => entry.input),
  );
  let embedded = 0;
  batch.forEach((entry, index) => {
    const embedding = embeddings[index] ?? [];
    embeddingCache.set(entry.embeddingInputHash, embedding);
    for (const chunk of entry.chunks) {
      chunk.embedding = embedding;
      chunk.fact.embedding = chunk.embedding;
      embedded += 1;
    }
  });
  return embedded;
}
