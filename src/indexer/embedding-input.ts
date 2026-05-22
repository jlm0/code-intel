export const legacyMaxEmbeddingInputChars = 6_000;
export const defaultEmbeddingInputTokenBudget = 512;

export function chunkEmbeddingInput(chunk: { content: string; name?: string }): string {
  return `${chunk.name ?? "chunk"}\n${chunk.content}`;
}

export interface EmbeddingInputTokenStats {
  inputsTotal: number;
  tokenBudget: number;
  oversizedInputs: number;
  splitChunks: number;
  truncationFallbacks: number;
  totalTokens: number;
  maxTokens: number;
  averageTokens: number;
  p50Tokens: number;
  p90Tokens: number;
  p95Tokens: number;
  p99Tokens: number;
}

export interface EmbeddingInputTopEntry {
  repo?: string;
  file?: string;
  name?: string;
  kind?: string;
  tokens: number;
  splitFromIdSuffix?: string;
}

export function summarizeEmbeddingInputTokens(
  tokenCounts: number[],
  options: {
    tokenBudget?: number;
    splitChunks?: number;
    truncationFallbacks?: number;
  } = {},
): EmbeddingInputTokenStats {
  const sorted = tokenCounts
    .filter((count) => Number.isFinite(count) && count >= 0)
    .map((count) => Math.floor(count))
    .sort((left, right) => left - right);
  const tokenBudget = normalizeTokenBudget(options.tokenBudget);
  const totalTokens = sorted.reduce((sum, count) => sum + count, 0);
  return {
    inputsTotal: sorted.length,
    tokenBudget,
    oversizedInputs: sorted.filter((count) => count > tokenBudget).length,
    splitChunks: Math.max(0, Math.floor(options.splitChunks ?? 0)),
    truncationFallbacks: Math.max(0, Math.floor(options.truncationFallbacks ?? 0)),
    totalTokens,
    maxTokens: sorted.at(-1) ?? 0,
    averageTokens: sorted.length > 0 ? Math.round(totalTokens / sorted.length) : 0,
    p50Tokens: percentile(sorted, 0.5),
    p90Tokens: percentile(sorted, 0.9),
    p95Tokens: percentile(sorted, 0.95),
    p99Tokens: percentile(sorted, 0.99),
  };
}

export function embeddingBatchTelemetry(tokenCounts: number[]): {
  batchMaxTokens: number;
  batchTotalTokens: number;
  batchPaddedTokens: number;
  batchPaddingWasteTokens: number;
  batchPaddingWasteRatio: number;
} {
  const normalized = tokenCounts
    .filter((count) => Number.isFinite(count) && count >= 0)
    .map((count) => Math.floor(count));
  const batchMaxTokens = Math.max(0, ...normalized);
  const batchTotalTokens = normalized.reduce((sum, count) => sum + count, 0);
  const batchPaddedTokens = batchMaxTokens * normalized.length;
  const batchPaddingWasteTokens = Math.max(0, batchPaddedTokens - batchTotalTokens);
  return {
    batchMaxTokens,
    batchTotalTokens,
    batchPaddedTokens,
    batchPaddingWasteTokens,
    batchPaddingWasteRatio: batchPaddedTokens > 0
      ? Math.round((batchPaddingWasteTokens / batchPaddedTokens) * 1_000_000) / 1_000_000
      : 0,
  };
}

export function normalizeTokenBudget(value: number | undefined): number {
  return value && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : defaultEmbeddingInputTokenBudget;
}

function percentile(sortedCounts: number[], fraction: number): number {
  if (sortedCounts.length === 0) {
    return 0;
  }
  const index = Math.min(sortedCounts.length - 1, Math.max(0, Math.ceil(sortedCounts.length * fraction) - 1));
  return sortedCounts[index] ?? 0;
}
