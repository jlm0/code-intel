import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { writeJsonAtomically } from "../core/index-artifacts.js";
import type { ScipShardPlan } from "./scip-shard-planning.js";

export const scipFailureHistorySchemaVersion = "code-intel.scip-failures.v1";

export type ScipFailureKind = "oom" | "timeout" | "oversized-output" | "killed" | "failed";

export interface ScipFailureHistoryEntry {
  repo: string;
  pathPrefix: string;
  failureKind: ScipFailureKind;
  lastFailedAt: string;
}

interface ScipFailureHistoryFile {
  schemaVersion: typeof scipFailureHistorySchemaVersion;
  failures: ScipFailureHistoryEntry[];
}

const maxFailureHistoryEntries = 500;

export async function readScipFailureHistory(indexPath: string): Promise<ScipFailureHistoryEntry[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(scipFailureHistoryPath(indexPath), "utf8"));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const payload = parsed as Partial<ScipFailureHistoryFile>;
  if (payload.schemaVersion !== scipFailureHistorySchemaVersion || !Array.isArray(payload.failures)) {
    return [];
  }
  return payload.failures.filter(isScipFailureHistoryEntry);
}

export async function appendScipFailureHistory(
  indexPath: string,
  entries: ScipFailureHistoryEntry[],
): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  const merged = mergeScipFailureHistory([
    ...await readScipFailureHistory(indexPath),
    ...entries,
  ]);
  const path = scipFailureHistoryPath(indexPath);
  await mkdir(dirname(path), { recursive: true });
  await writeJsonAtomically(path, {
    schemaVersion: scipFailureHistorySchemaVersion,
    failures: merged,
  } satisfies ScipFailureHistoryFile);
}

export function failureHistoryEntryForShard(
  repo: string,
  repoPath: string,
  shard: ScipShardPlan,
  failureKind: ScipFailureKind,
  lastFailedAt = new Date().toISOString(),
): ScipFailureHistoryEntry {
  return {
    repo,
    pathPrefix: commonPathPrefix((shard.includedFiles ?? []).map((file) => relative(repoPath, file))),
    failureKind,
    lastFailedAt,
  };
}

function mergeScipFailureHistory(entries: ScipFailureHistoryEntry[]): ScipFailureHistoryEntry[] {
  const byKey = new Map<string, ScipFailureHistoryEntry>();
  for (const entry of entries.filter(isScipFailureHistoryEntry)) {
    const key = `${entry.repo}\0${entry.pathPrefix}\0${entry.failureKind}`;
    const existing = byKey.get(key);
    if (!existing || existing.lastFailedAt < entry.lastFailedAt) {
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()]
    .sort((left, right) =>
      right.lastFailedAt.localeCompare(left.lastFailedAt) ||
      left.repo.localeCompare(right.repo) ||
      left.pathPrefix.localeCompare(right.pathPrefix) ||
      left.failureKind.localeCompare(right.failureKind)
    )
    .slice(0, maxFailureHistoryEntries);
}

function commonPathPrefix(paths: string[]): string {
  const normalized = paths.map((path) => path.replaceAll("\\", "/")).filter((path) => path.length > 0).sort();
  if (normalized.length === 0) {
    return ".";
  }
  const directories = normalized.map((path) => {
    const parts = path.split("/");
    return parts.length <= 1 ? path : parts.slice(0, -1).join("/");
  });
  let prefix = directories[0] ?? ".";
  for (const directory of directories.slice(1)) {
    while (prefix !== "." && directory !== prefix && !directory.startsWith(`${prefix}/`)) {
      const parts = prefix.split("/");
      parts.pop();
      prefix = parts.join("/") || ".";
    }
  }
  return prefix || ".";
}

function isScipFailureHistoryEntry(value: unknown): value is ScipFailureHistoryEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Partial<ScipFailureHistoryEntry>;
  return typeof entry.repo === "string" &&
    entry.repo.length > 0 &&
    typeof entry.pathPrefix === "string" &&
    entry.pathPrefix.length > 0 &&
    isFailureKind(entry.failureKind) &&
    typeof entry.lastFailedAt === "string" &&
    entry.lastFailedAt.length > 0;
}

function isFailureKind(value: unknown): value is ScipFailureKind {
  return value === "oom" ||
    value === "timeout" ||
    value === "oversized-output" ||
    value === "killed" ||
    value === "failed";
}

function scipFailureHistoryPath(indexPath: string): string {
  return join(indexPath, "scip", "failures.json");
}
