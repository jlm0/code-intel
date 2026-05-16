import type { CodeNode } from "../schema/schemas.js";
import type { EmbeddingProvider } from "../vectors/embedding.js";
import type { ChunkFact } from "./fact-cache.js";

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
  const chunks = [...chunksById.values()].sort((left, right) => left.id.localeCompare(right.id));
  const missingChunks: EmbeddableChunkNode[] = [];
  let reused = 0;

  for (const chunk of chunks) {
    const cachedEmbedding = chunk.embedding.length === embeddingProvider.dimension
      ? chunk.embedding
      : embeddingCache.get(chunk.embeddingInputHash);
    if (cachedEmbedding?.length === embeddingProvider.dimension) {
      chunk.embedding = cachedEmbedding;
      chunk.fact.embedding = cachedEmbedding;
      reused += 1;
    } else {
      missingChunks.push(chunk);
    }
  }

  let embedded = 0;
  for (const batch of chunkArray(missingChunks, 16)) {
    const embeddings = await embeddingProvider.embedBatch(
      batch.map((chunk) => `${chunk.name}\n${chunk.content}`),
    );
    batch.forEach((chunk, index) => {
      chunk.embedding = embeddings[index] ?? [];
      chunk.fact.embedding = chunk.embedding;
      embedded += 1;
    });
  }

  return { embedded, reused };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
