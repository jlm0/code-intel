export interface StableIdInput {
  kind: string;
  workspace: string;
  repo: string;
  commit: string;
  relativePath: string;
  suffix: string;
}

export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function createStableId(input: StableIdInput): string {
  const relativePath = normalizeRelativePath(input.relativePath);
  return `${input.kind}:${input.workspace}:${input.repo}@${input.commit}:${relativePath}#${input.suffix}`;
}

export function createEdgeId(kind: string, fromId: string, toId: string): string {
  return `edge:${kind}:${fromId}->${toId}`;
}
