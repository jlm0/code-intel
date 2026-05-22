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

export type EmbeddingBatchProgressUpdate = {
  event: "batch_started" | "batch_completed";
  batchIndex: number;
  batchSize: number;
  batchesCompleted: number;
  chunksEmbedded: number;
  chunksVisited: number;
};

export interface EmbedGraphChunksOptions {
  batchSize?: number;
  onProgress?: (update: EmbeddingBatchProgressUpdate) => void | Promise<void>;
}

const defaultEmbeddingBatchSize = 16;

export async function embedGraphChunks(
  chunksById: Map<string, EmbeddableChunkNode>,
  embeddingProvider: EmbeddingProvider,
  embeddingCache: Map<string, number[]>,
  options: EmbedGraphChunksOptions = {},
): Promise<{ embedded: number; reused: number }> {
  const missingInputs = new Map<string, { embeddingInputHash: string; input: string; chunks: EmbeddableChunkNode[] }>();
  const batchSize = normalizeBatchSize(options.batchSize);
  let reused = 0;
  let embedded = 0;
  let batchesCompleted = 0;
  let chunksVisited = 0;

  for (const chunk of chunksById.values()) {
    chunksVisited += 1;
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
      if (missingInputs.size >= batchSize) {
        const progress = await flushMissingInputs(missingInputs, embeddingProvider, embeddingCache, {
          batchIndex: batchesCompleted + 1,
          batchesCompleted,
          chunksEmbedded: embedded,
          chunksVisited,
          onProgress: options.onProgress,
        });
        batchesCompleted += 1;
        embedded += progress.embedded;
      }
    }
  }

  const progress = await flushMissingInputs(missingInputs, embeddingProvider, embeddingCache, {
    batchIndex: batchesCompleted + 1,
    batchesCompleted,
    chunksEmbedded: embedded,
    chunksVisited,
    onProgress: options.onProgress,
  });
  embedded += progress.embedded;

  return { embedded, reused };
}

async function flushMissingInputs(
  missingInputs: Map<string, { embeddingInputHash: string; input: string; chunks: EmbeddableChunkNode[] }>,
  embeddingProvider: EmbeddingProvider,
  embeddingCache: Map<string, number[]>,
  progress: {
    batchIndex: number;
    batchesCompleted: number;
    chunksEmbedded: number;
    chunksVisited: number;
    onProgress?: (update: EmbeddingBatchProgressUpdate) => void | Promise<void>;
  },
): Promise<{ embedded: number }> {
  if (missingInputs.size === 0) {
    return { embedded: 0 };
  }
  const batch = [...missingInputs.values()];
  missingInputs.clear();
  await progress.onProgress?.({
    event: "batch_started",
    batchIndex: progress.batchIndex,
    batchSize: batch.length,
    batchesCompleted: progress.batchesCompleted,
    chunksEmbedded: progress.chunksEmbedded,
    chunksVisited: progress.chunksVisited,
  });
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
  await progress.onProgress?.({
    event: "batch_completed",
    batchIndex: progress.batchIndex,
    batchSize: batch.length,
    batchesCompleted: progress.batchesCompleted + 1,
    chunksEmbedded: progress.chunksEmbedded + embedded,
    chunksVisited: progress.chunksVisited,
  });
  return { embedded };
}

function normalizeBatchSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return defaultEmbeddingBatchSize;
  }
  return Math.max(1, Math.floor(value));
}
