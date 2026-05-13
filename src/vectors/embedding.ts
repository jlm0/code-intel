export const embeddingDimension = 64;
export const embeddingModel = "local-hash-v1";

export function embedText(text: string): number[] {
  const vector = Array.from({ length: embeddingDimension }, () => 0);
  for (const token of tokenize(text)) {
    const index = hashToken(token) % embeddingDimension;
    vector[index] += 1;
  }

  const length = Math.hypot(...vector);
  return length === 0 ? vector : vector.map((value) => value / length);
}

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
