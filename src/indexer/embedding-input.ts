export const legacyMaxEmbeddingInputChars = 6_000;
export const defaultEmbeddingInputTokenBudget = 512;

export type EmbeddingInputHeader = {
  repo?: string;
  packageName?: string;
  path?: string;
  qualifiedName?: string;
  kind?: string;
  exported?: boolean;
  test?: boolean;
  sourceRoot?: string;
};

export function chunkEmbeddingInput(chunk: {
  content: string;
  name?: string;
  kind?: string;
  repo?: string;
  packageName?: string;
  file?: string;
  metadata?: Record<string, unknown>;
  fact?: {
    embeddingInputMode?: "minimal" | "semantic-header";
    embeddingInputHeader?: EmbeddingInputHeader;
  };
}): string {
  if (chunk.fact?.embeddingInputMode === "semantic-header") {
    return `${semanticHeader(chunk)}\n${chunk.content}`;
  }
  return `${chunk.name ?? "chunk"}\n${chunk.content}`;
}

function semanticHeader(chunk: Parameters<typeof chunkEmbeddingInput>[0]): string {
  const header = chunk.fact?.embeddingInputHeader ?? headerFromChunk(chunk);
  const first = [
    field("repo", header.repo),
    field("package", header.packageName),
    field("path", header.path),
  ].filter(Boolean).join(" ");
  const second = [
    field("qualifiedName", header.qualifiedName ?? chunk.name),
    field("kind", header.kind ?? chunk.kind),
    field("exported", header.exported),
    field("test", header.test),
    field("sourceRoot", header.sourceRoot),
  ].filter(Boolean).join(" ");
  return [first, second].filter((line) => line.length > 0).join("\n");
}

function headerFromChunk(chunk: Parameters<typeof chunkEmbeddingInput>[0]): EmbeddingInputHeader {
  return {
    repo: chunk.repo,
    packageName: chunk.packageName,
    path: chunk.file,
    qualifiedName: stringFromMetadata(chunk.metadata, "qualifiedName") ?? chunk.name,
    kind: stringFromMetadata(chunk.metadata, "declarationKind") ?? chunk.kind,
    exported: booleanFromMetadata(chunk.metadata, "exported"),
    test: stringFromMetadata(chunk.metadata, "fileKind") === "test",
    sourceRoot: stringFromMetadata(chunk.metadata, "sourceRoot"),
  };
}

function field(name: string, value: string | boolean | undefined): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  return `${name}=${String(value)}`;
}

function stringFromMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanFromMetadata(metadata: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = metadata?.[key];
  return typeof value === "boolean" ? value : undefined;
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
