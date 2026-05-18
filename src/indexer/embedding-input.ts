export const maxEmbeddingInputChars = 6_000;

export function chunkEmbeddingInput(chunk: { content: string; name?: string }): string {
  const input = `${chunk.name ?? "chunk"}\n${chunk.content}`;
  if (input.length <= maxEmbeddingInputChars) {
    return input;
  }
  return `${input.slice(0, maxEmbeddingInputChars)}\n[truncated ${input.length - maxEmbeddingInputChars} chars]`;
}
