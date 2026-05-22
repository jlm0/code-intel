import type { CodeNode } from "../schema/schemas.js";
import type { EmbeddingProvider } from "../vectors/embedding.js";
import type { ChunkFact } from "./fact-cache.js";
import {
  chunkEmbeddingInput,
  embeddingBatchTelemetry,
  summarizeEmbeddingInputTokens,
  type EmbeddingInputTokenStats,
  type EmbeddingInputTopEntry,
} from "./embedding-input.js";

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
  embeddingInputsTotal: number;
  embeddingInputsMissing: number;
  embeddingInputsReused: number;
  duplicateInputChunks: number;
  inputTokensMax: number;
  inputTokensP50: number;
  inputTokensP90: number;
  inputTokensP95: number;
  inputTokensP99: number;
  oversizedInputs: number;
  splitChunks: number;
  truncationFallbacks: number;
  batchMaxTokens: number;
  batchTotalTokens: number;
  batchPaddedTokens: number;
  batchPaddingWasteTokens: number;
  batchPaddingWasteRatio: number;
  embeddingElapsedMs: number;
  embeddingEstimatedRemainingMs?: number;
};

export interface EmbedGraphChunksOptions {
  batchSize?: number;
  onProgress?: (update: EmbeddingBatchProgressUpdate) => void | Promise<void>;
}

export type EmbeddingInputSummary = EmbeddingInputTokenStats & {
  chunksTotal: number;
  duplicateInputChunks: number;
  topInputs: EmbeddingInputTopEntry[];
};

const defaultEmbeddingBatchSize = 16;

export async function embedGraphChunks(
  chunksById: Map<string, EmbeddableChunkNode>,
  embeddingProvider: EmbeddingProvider,
  embeddingCache: Map<string, number[]>,
  options: EmbedGraphChunksOptions = {},
): Promise<{ embedded: number; reused: number; embeddingInput: EmbeddingInputSummary }> {
  const missingInputs = new Map<string, EmbeddingInputEntry>();
  const allInputs = new Map<string, EmbeddingInputEntry>();
  const batchSize = normalizeBatchSize(options.batchSize);
  let reused = 0;
  let embedded = 0;
  let chunksVisited = 0;

  for (const chunk of chunksById.values()) {
    chunksVisited += 1;
    const input = chunkEmbeddingInput(chunk);
    const tokenCount = chunk.fact.embeddingInputTokenCount ?? (await embeddingProvider.countTokens([input]))[0] ?? 0;
    const inputEntry = allInputs.get(chunk.embeddingInputHash);
    if (inputEntry) {
      inputEntry.chunks.push(chunk);
    } else {
      allInputs.set(chunk.embeddingInputHash, {
        embeddingInputHash: chunk.embeddingInputHash,
        input,
        tokenCount,
        chunks: [chunk],
      });
    }
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
          input,
          tokenCount,
          chunks: [chunk],
        });
      }
    }
  }

  const embeddingInput = summarizeEmbeddingInputEntries([...allInputs.values()], chunksById);
  const batches = createLengthAwareBatches([...missingInputs.values()], batchSize);
  const embeddingStartedAt = performance.now();
  let batchesCompleted = 0;
  for (const batch of batches) {
    const progress = await flushMissingInputs(batch, embeddingProvider, embeddingCache, {
      batchIndex: batchesCompleted + 1,
      totalBatches: batches.length,
      batchesCompleted,
      chunksEmbedded: embedded,
      chunksVisited,
      embeddingInput,
      embeddingInputsMissing: missingInputs.size,
      embeddingInputsReused: allInputs.size - missingInputs.size,
      embeddingStartedAt,
      onProgress: options.onProgress,
    });
    batchesCompleted += 1;
    embedded += progress.embedded;
  }

  return { embedded, reused, embeddingInput };
}

async function flushMissingInputs(
  batch: EmbeddingInputEntry[],
  embeddingProvider: EmbeddingProvider,
  embeddingCache: Map<string, number[]>,
  progress: {
    batchIndex: number;
    totalBatches: number;
    batchesCompleted: number;
    chunksEmbedded: number;
    chunksVisited: number;
    embeddingInput: EmbeddingInputSummary;
    embeddingInputsMissing: number;
    embeddingInputsReused: number;
    embeddingStartedAt: number;
    onProgress?: (update: EmbeddingBatchProgressUpdate) => void | Promise<void>;
  },
): Promise<{ embedded: number }> {
  if (batch.length === 0) {
    return { embedded: 0 };
  }
  const batchTelemetry = embeddingBatchTelemetry(batch.map((entry) => entry.tokenCount));
  await progress.onProgress?.({
    event: "batch_started",
    batchIndex: progress.batchIndex,
    batchSize: batch.length,
    batchesCompleted: progress.batchesCompleted,
    chunksEmbedded: progress.chunksEmbedded,
    chunksVisited: progress.chunksVisited,
    ...progressFields(progress, batchTelemetry, progress.batchesCompleted),
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
  const completedBatches = progress.batchesCompleted + 1;
  await progress.onProgress?.({
    event: "batch_completed",
    batchIndex: progress.batchIndex,
    batchSize: batch.length,
    batchesCompleted: completedBatches,
    chunksEmbedded: progress.chunksEmbedded + embedded,
    chunksVisited: progress.chunksVisited,
    ...progressFields(progress, batchTelemetry, completedBatches),
  });
  return { embedded };
}

export function summarizeGraphEmbeddingInputs(
  chunksById: Map<string, EmbeddableChunkNode>,
): EmbeddingInputSummary {
  const uniqueInputs = new Map<string, EmbeddableChunkNode>();
  let splitChunks = 0;
  let truncationFallbacks = 0;
  for (const chunk of chunksById.values()) {
    if (!uniqueInputs.has(chunk.embeddingInputHash)) {
      uniqueInputs.set(chunk.embeddingInputHash, chunk);
    }
    if (chunk.fact.embeddingInputSplitPart !== undefined) {
      splitChunks += 1;
    }
    if (chunk.fact.embeddingInputTruncated) {
      truncationFallbacks += 1;
    }
  }
  const inputs = [...uniqueInputs.values()];
  const stats = summarizeEmbeddingInputTokens(
    inputs.map((chunk) => chunk.fact.embeddingInputTokenCount ?? 0),
    {
      tokenBudget: inputs[0]?.fact.embeddingInputTokenBudget,
      splitChunks,
      truncationFallbacks,
    },
  );
  return {
    ...stats,
    chunksTotal: chunksById.size,
    duplicateInputChunks: Math.max(0, chunksById.size - inputs.length),
    topInputs: inputs
      .map((chunk) => ({
        repo: chunk.repo,
        file: chunk.file,
        name: chunk.name,
        kind: chunk.kind,
        tokens: chunk.fact.embeddingInputTokenCount ?? 0,
        splitFromIdSuffix: chunk.fact.embeddingInputSplitFromIdSuffix,
      }))
      .sort((left, right) =>
        right.tokens - left.tokens ||
        (left.file ?? "").localeCompare(right.file ?? "") ||
        (left.name ?? "").localeCompare(right.name ?? ""),
      )
      .slice(0, 10),
  };
}

function summarizeEmbeddingInputEntries(
  entries: EmbeddingInputEntry[],
  chunksById: Map<string, EmbeddableChunkNode>,
): EmbeddingInputSummary {
  let splitChunks = 0;
  let truncationFallbacks = 0;
  for (const chunk of chunksById.values()) {
    if (chunk.fact.embeddingInputSplitPart !== undefined) {
      splitChunks += 1;
    }
    if (chunk.fact.embeddingInputTruncated) {
      truncationFallbacks += 1;
    }
  }
  const stats = summarizeEmbeddingInputTokens(
    entries.map((entry) => entry.tokenCount),
    {
      tokenBudget: entries[0]?.chunks[0]?.fact.embeddingInputTokenBudget,
      splitChunks,
      truncationFallbacks,
    },
  );
  return {
    ...stats,
    chunksTotal: chunksById.size,
    duplicateInputChunks: Math.max(0, chunksById.size - entries.length),
    topInputs: entries
      .map((entry) => {
        const chunk = entry.chunks[0];
        return {
          repo: chunk?.repo,
          file: chunk?.file,
          name: chunk?.name,
          kind: chunk?.kind,
          tokens: entry.tokenCount,
          splitFromIdSuffix: chunk?.fact.embeddingInputSplitFromIdSuffix,
        };
      })
      .sort((left, right) =>
        right.tokens - left.tokens ||
        (left.file ?? "").localeCompare(right.file ?? "") ||
        (left.name ?? "").localeCompare(right.name ?? ""),
      )
      .slice(0, 10),
  };
}

function createLengthAwareBatches(entries: EmbeddingInputEntry[], batchSize: number): EmbeddingInputEntry[][] {
  const sorted = [...entries].sort((left, right) =>
    left.tokenCount - right.tokenCount ||
    left.embeddingInputHash.localeCompare(right.embeddingInputHash),
  );
  const batches: EmbeddingInputEntry[][] = [];
  for (let index = 0; index < sorted.length; index += batchSize) {
    batches.push(sorted.slice(index, index + batchSize));
  }
  return batches;
}

function progressFields(
  progress: {
    totalBatches: number;
    embeddingInput: EmbeddingInputSummary;
    embeddingInputsMissing: number;
    embeddingInputsReused: number;
    embeddingStartedAt: number;
  },
  batchTelemetry: ReturnType<typeof embeddingBatchTelemetry>,
  batchesCompleted: number,
): Omit<
  EmbeddingBatchProgressUpdate,
  "event" | "batchIndex" | "batchSize" | "batchesCompleted" | "chunksEmbedded" | "chunksVisited"
> {
  const embeddingElapsedMs = Math.max(0, Math.round(performance.now() - progress.embeddingStartedAt));
  const embeddingEstimatedRemainingMs = batchesCompleted > 0
    ? Math.max(0, Math.round((embeddingElapsedMs / batchesCompleted) * (progress.totalBatches - batchesCompleted)))
    : undefined;
  return {
    embeddingInputsTotal: progress.embeddingInput.inputsTotal,
    embeddingInputsMissing: progress.embeddingInputsMissing,
    embeddingInputsReused: progress.embeddingInputsReused,
    duplicateInputChunks: progress.embeddingInput.duplicateInputChunks,
    inputTokensMax: progress.embeddingInput.maxTokens,
    inputTokensP50: progress.embeddingInput.p50Tokens,
    inputTokensP90: progress.embeddingInput.p90Tokens,
    inputTokensP95: progress.embeddingInput.p95Tokens,
    inputTokensP99: progress.embeddingInput.p99Tokens,
    oversizedInputs: progress.embeddingInput.oversizedInputs,
    splitChunks: progress.embeddingInput.splitChunks,
    truncationFallbacks: progress.embeddingInput.truncationFallbacks,
    ...batchTelemetry,
    embeddingElapsedMs,
    ...(embeddingEstimatedRemainingMs !== undefined ? { embeddingEstimatedRemainingMs } : {}),
  };
}

function normalizeBatchSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return defaultEmbeddingBatchSize;
  }
  return Math.max(1, Math.floor(value));
}

interface EmbeddingInputEntry {
  embeddingInputHash: string;
  input: string;
  tokenCount: number;
  chunks: EmbeddableChunkNode[];
}
