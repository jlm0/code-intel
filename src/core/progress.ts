import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  IndexProgressEventSchema,
  IndexProgressResultSchema,
  IndexProgressSnapshotSchema,
  IndexWriteLockStateSchema,
  schemaVersion,
  type IndexDiscoverySummary,
  type IndexProgressCounters,
  type IndexProgressErrorDetails,
  type IndexProgressEvent,
  type IndexProgressEventType,
  type IndexProgressOperation,
  type IndexProgressPhase,
  type IndexProgressResult,
  type IndexProgressScipQuality,
  type IndexProgressSnapshot,
  type IndexProgressStatus,
  type IndexProgressStep,
  type IndexWriteLockState,
} from "../schema/schemas.js";
import { createRuntimeContext, type RuntimeOptions } from "./context.js";
import { writeJsonAtomically } from "./index-artifacts.js";
import { truncateUtf8Bytes } from "./text.js";

export interface IndexProgressUpdate {
  status?: Exclude<IndexProgressStatus, "stale">;
  phase: IndexProgressPhase;
  event?: IndexProgressEventType;
  message: string;
  currentRepo?: string;
  currentStep?: IndexProgressStep;
  startedStepAt?: string;
  durationMs?: number;
  counters?: IndexProgressCounters;
  error?: unknown;
  warnings?: string[];
  scip?: IndexProgressScipQuality;
  discovery?: IndexDiscoverySummary;
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

interface GetIndexProgressOptions extends ReadIndexProgressOptions {
  includeEvents?: boolean;
  limit?: number;
}

interface ReadIndexWriteLockOptions {
  now?: Date;
  staleAfterMs?: number;
  isPidAlive?: (pid: number) => boolean;
}

const progressDirectoryName = "progress";
const progressCurrentFilename = "current.json";
const progressLogsDirectoryName = "logs";
const defaultStaleAfterMs = 5 * 60 * 1000;
const defaultWriteLockStaleAfterMs = 12 * 60 * 60 * 1000;
const maxErrorStackBytes = 4096;
const maxRecentEvents = 500;

export function progressCurrentPath(indexPath: string): string {
  return join(indexPath, progressDirectoryName, progressCurrentFilename);
}

export function progressLogPath(indexPath: string, runId: string): string {
  return join(indexPath, progressLogsDirectoryName, `index-${sanitizeRunId(runId)}.jsonl`);
}

export async function getIndexProgress(
  options: RuntimeOptions,
  progressOptions: GetIndexProgressOptions = {},
): Promise<IndexProgressResult> {
  const context = createRuntimeContext(options);
  const progress = await readIndexProgress(context.indexPath, progressOptions);
  const events = progressOptions.includeEvents && progress
    ? await readIndexProgressEvents(context.indexPath, progress.runId, { limit: progressOptions.limit })
    : undefined;
  return IndexProgressResultSchema.parse({
    schemaVersion,
    indexPath: context.indexPath,
    progress,
    events,
    writeLock: await readIndexWriteLockState(context.indexPath, progressOptions),
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
  if (Number.isFinite(updatedAt) && !snapshot.currentStep && now.getTime() - updatedAt > staleAfterMs) {
    return {
      ...snapshot,
      status: "stale",
      staleReason: "heartbeat-timeout",
    };
  }

  return {
    ...snapshot,
    staleReason: undefined,
  };
}

export async function writeIndexProgress(indexPath: string, snapshot: IndexProgressSnapshot): Promise<void> {
  const parsed = IndexProgressSnapshotSchema.parse(snapshot);
  await mkdir(join(indexPath, progressDirectoryName), { recursive: true });
  await writeJsonAtomically(progressCurrentPath(indexPath), parsed);
}

export async function readIndexProgressEvents(
  indexPath: string,
  runId: string,
  options: { limit?: number } = {},
): Promise<IndexProgressEvent[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), maxRecentEvents);
  let raw: string;
  try {
    raw = await readFile(progressLogPath(indexPath, runId), "utf8");
  } catch {
    return [];
  }
  const lines = raw.trim().length > 0 ? raw.trim().split("\n") : [];
  return lines
    .slice(-limit)
    .map((line) => {
      try {
        return IndexProgressEventSchema.safeParse(JSON.parse(line));
      } catch {
        return undefined;
      }
    })
    .filter((result): result is { success: true; data: IndexProgressEvent } => result?.success === true)
    .map((result) => result.data);
}

export async function readIndexWriteLockState(
  indexPath: string,
  options: ReadIndexWriteLockOptions = {},
): Promise<IndexWriteLockState> {
  const lockPath = join(indexPath, ".index-write.lock");
  try {
    await stat(lockPath);
  } catch {
    return IndexWriteLockStateSchema.parse({
      status: "unlocked",
      path: lockPath,
    });
  }

  let owner: { pid?: unknown; createdAt?: unknown } = {};
  try {
    owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as typeof owner;
  } catch {
    return IndexWriteLockStateSchema.parse({
      status: "stale",
      path: lockPath,
      alive: false,
    });
  }

  const pid = typeof owner.pid === "number" ? owner.pid : undefined;
  const createdAt = typeof owner.createdAt === "string" ? owner.createdAt : undefined;
  const alive = pid === undefined ? false : (options.isPidAlive ?? processIsAlive)(pid);
  const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? defaultWriteLockStaleAfterMs;
  const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, now.getTime() - createdAtMs) : undefined;
  const fresh = ageMs === undefined || ageMs <= staleAfterMs;
  return IndexWriteLockStateSchema.parse({
    status: alive && fresh ? "held" : "stale",
    path: lockPath,
    pid,
    createdAt,
    ageMs,
    alive,
  });
}

export function createIndexProgressFileReporter(
  input: CreateIndexProgressFileReporterInput,
): IndexProgressReporter {
  const startedAt = (input.now ?? (() => new Date()))().toISOString();
  const runId = input.runId ?? `${Date.now()}-${randomUUID()}`;
  const pid = input.pid ?? process.pid;
  const counters: IndexProgressCounters = {};
  let currentRepo: string | undefined;
  let currentStep: IndexProgressStep | undefined;
  let startedStepAt: string | undefined;

  return {
    report: async (update) => {
      Object.assign(counters, update.counters ?? {});
      const updatedAt = (input.now ?? (() => new Date()))().toISOString();
      const event = update.event ?? eventForUpdate(update);
      if (update.currentStep) {
        currentRepo = update.currentRepo ?? currentRepo;
        if (event === "step_started" || update.currentStep !== currentStep) {
          startedStepAt = update.startedStepAt ?? updatedAt;
        }
        currentStep = update.currentStep;
      } else {
        currentRepo = undefined;
        currentStep = undefined;
        startedStepAt = undefined;
      }
      const errorDetails = normalizeErrorDetails(update.error);
      const warnings = update.warnings ?? [];
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
        currentRepo,
        currentStep,
        startedStepAt,
        counters: { ...counters },
        error: errorDetails?.message,
        errorDetails,
        warnings,
      });
      const progressEvent = IndexProgressEventSchema.parse({
        schemaVersion,
        runId,
        operation: input.operation,
        event,
        phase: update.phase,
        status: update.status,
        message: update.message,
        indexPath: input.indexPath,
        pid,
        timestamp: updatedAt,
        currentRepo,
        currentStep,
        startedStepAt,
        durationMs: update.durationMs,
        counters: { ...counters },
        memory: currentMemoryUsage(),
        error: errorDetails,
        warnings,
        scip: update.scip,
        discovery: update.discovery,
      });
      await appendIndexProgressEvent(input.indexPath, progressEvent);
    },
  };
}

async function appendIndexProgressEvent(indexPath: string, event: IndexProgressEvent): Promise<void> {
  const parsed = IndexProgressEventSchema.parse(event);
  await mkdir(join(indexPath, progressLogsDirectoryName), { recursive: true });
  await appendFile(progressLogPath(indexPath, parsed.runId), `${JSON.stringify(parsed)}\n`);
}

function eventForUpdate(update: IndexProgressUpdate): IndexProgressEventType {
  if (update.status === "succeeded") {
    return "run_succeeded";
  }
  if (update.status === "failed") {
    return "run_failed";
  }
  if (update.currentStep) {
    return "step_started";
  }
  return "phase_started";
}

function normalizeErrorDetails(error: unknown): IndexProgressErrorDetails | undefined {
  if (error === undefined) {
    return undefined;
  }
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message,
      code: typeof (error as NodeJS.ErrnoException).code === "string"
        ? (error as NodeJS.ErrnoException).code
        : undefined,
      stack: error.stack ? truncateUtf8Bytes(error.stack, maxErrorStackBytes) : undefined,
    };
  }
  return {
    name: "Error",
    message: String(error),
  };
}

function currentMemoryUsage(): { rssMb: number; heapUsedMb: number } {
  const memory = process.memoryUsage();
  return {
    rssMb: bytesToMegabytes(memory.rss),
    heapUsedMb: bytesToMegabytes(memory.heapUsed),
  };
}

function bytesToMegabytes(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function sanitizeRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9_.-]/g, "_");
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
