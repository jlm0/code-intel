import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  IndexProgressResultSchema,
  IndexProgressSnapshotSchema,
  schemaVersion,
  type IndexProgressCounters,
  type IndexProgressOperation,
  type IndexProgressPhase,
  type IndexProgressResult,
  type IndexProgressSnapshot,
  type IndexProgressStatus,
} from "../schema/schemas.js";
import { createRuntimeContext, type RuntimeOptions } from "./context.js";
import { writeJsonAtomically } from "./index-artifacts.js";

export interface IndexProgressUpdate {
  status?: Exclude<IndexProgressStatus, "stale">;
  phase: IndexProgressPhase;
  message: string;
  counters?: IndexProgressCounters;
  error?: string;
}

export interface IndexProgressReporter {
  report(update: IndexProgressUpdate): Promise<void>;
}

interface CreateIndexProgressFileReporterInput {
  indexPath: string;
  operation: IndexProgressOperation;
  runId?: string;
  pid?: number;
  now?: () => Date;
}

interface ReadIndexProgressOptions {
  now?: Date;
  staleAfterMs?: number;
  isPidAlive?: (pid: number) => boolean;
}

const progressDirectoryName = "progress";
const progressCurrentFilename = "current.json";
const defaultStaleAfterMs = 5 * 60 * 1000;

export function progressCurrentPath(indexPath: string): string {
  return join(indexPath, progressDirectoryName, progressCurrentFilename);
}

export async function getIndexProgress(options: RuntimeOptions): Promise<IndexProgressResult> {
  const context = createRuntimeContext(options);
  return IndexProgressResultSchema.parse({
    schemaVersion,
    indexPath: context.indexPath,
    progress: await readIndexProgress(context.indexPath),
  });
}

export async function readIndexProgress(
  indexPath: string,
  options: ReadIndexProgressOptions = {},
): Promise<IndexProgressSnapshot | undefined> {
  let snapshot: IndexProgressSnapshot;
  try {
    snapshot = IndexProgressSnapshotSchema.parse(
      JSON.parse(await readFile(progressCurrentPath(indexPath), "utf8")),
    );
  } catch {
    return undefined;
  }

  if (snapshot.status !== "running") {
    return snapshot;
  }

  const isPidAlive = options.isPidAlive ?? processIsAlive;
  if (!isPidAlive(snapshot.pid)) {
    return {
      ...snapshot,
      status: "stale",
      staleReason: "process-exited",
    };
  }

  const updatedAt = Date.parse(snapshot.updatedAt);
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? defaultStaleAfterMs;
  if (Number.isFinite(updatedAt) && now.getTime() - updatedAt > staleAfterMs) {
    return {
      ...snapshot,
      status: "stale",
      staleReason: "heartbeat-timeout",
    };
  }

  return snapshot;
}

export async function writeIndexProgress(indexPath: string, snapshot: IndexProgressSnapshot): Promise<void> {
  const parsed = IndexProgressSnapshotSchema.parse(snapshot);
  await mkdir(join(indexPath, progressDirectoryName), { recursive: true });
  await writeJsonAtomically(progressCurrentPath(indexPath), parsed);
}

export function createIndexProgressFileReporter(
  input: CreateIndexProgressFileReporterInput,
): IndexProgressReporter {
  const startedAt = (input.now ?? (() => new Date()))().toISOString();
  const runId = input.runId ?? `${Date.now()}-${randomUUID()}`;
  const pid = input.pid ?? process.pid;
  const counters: IndexProgressCounters = {};

  return {
    report: async (update) => {
      Object.assign(counters, update.counters ?? {});
      const updatedAt = (input.now ?? (() => new Date()))().toISOString();
      await writeIndexProgress(input.indexPath, {
        schemaVersion,
        runId,
        operation: input.operation,
        status: update.status ?? "running",
        phase: update.phase,
        message: update.message,
        indexPath: input.indexPath,
        pid,
        startedAt,
        updatedAt,
        counters: { ...counters },
        error: update.error,
      });
    },
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    return false;
  }
}
