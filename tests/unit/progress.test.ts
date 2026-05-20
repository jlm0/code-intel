import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createIndexProgressFileReporter,
  getIndexProgress,
  progressLogPath,
  progressCurrentPath,
  readIndexProgress,
  writeIndexProgress,
} from "../../src/core/progress.js";
import { IndexProgressEventSchema, IndexProgressSnapshotSchema, schemaVersion } from "../../src/schema/schemas.js";

describe("index progress persistence", () => {
  it("writes atomic progress snapshots under the index progress directory", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-progress-"));
    try {
      await writeIndexProgress(indexPath, {
        schemaVersion,
        runId: "run-1",
        operation: "index",
        status: "running",
        phase: "embeddings",
        message: "Embedding chunks",
        indexPath,
        pid: process.pid,
        startedAt: "2026-05-20T12:00:00.000Z",
        updatedAt: "2026-05-20T12:00:01.000Z",
        counters: {
          filesDiscovered: 3,
          filesParsed: 3,
          chunksTotal: 5,
          chunksEmbedded: 2,
          chunksReused: 1,
        },
      });

      const raw = JSON.parse(await readFile(progressCurrentPath(indexPath), "utf8"));
      expect(raw).toMatchObject({
        schemaVersion,
        operation: "index",
        status: "running",
        phase: "embeddings",
        counters: {
          chunksEmbedded: 2,
        },
      });
      await expect(readIndexProgress(indexPath, {
        isPidAlive: () => true,
        now: new Date("2026-05-20T12:00:02.000Z"),
      })).resolves.toMatchObject({
        status: "running",
        phase: "embeddings",
      });
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });

  it("derives stale running snapshots at read time", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-progress-stale-"));
    try {
      await writeIndexProgress(indexPath, {
        schemaVersion,
        runId: "run-2",
        operation: "update",
        status: "running",
        phase: "graph",
        message: "Writing graph",
        indexPath,
        pid: 999_999,
        startedAt: "2026-05-20T12:00:00.000Z",
        updatedAt: "2026-05-20T12:00:00.000Z",
        counters: {},
      });

      await expect(readIndexProgress(indexPath, {
        isPidAlive: () => false,
        now: new Date("2026-05-20T12:10:00.000Z"),
      })).resolves.toMatchObject({
        status: "stale",
        phase: "graph",
        staleReason: "process-exited",
      });
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });

  it("derives heartbeat-timeout stale snapshots when a writer stops updating", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-progress-heartbeat-"));
    try {
      await writeIndexProgress(indexPath, {
        schemaVersion,
        runId: "run-heartbeat",
        operation: "index",
        status: "running",
        phase: "embeddings",
        message: "Embedding chunks",
        indexPath,
        pid: process.pid,
        startedAt: "2026-05-20T12:00:00.000Z",
        updatedAt: "2026-05-20T12:00:00.000Z",
        counters: {},
      });

      await expect(readIndexProgress(indexPath, {
        isPidAlive: () => true,
        now: new Date("2026-05-20T12:10:00.000Z"),
        staleAfterMs: 60_000,
      })).resolves.toMatchObject({
        status: "stale",
        staleReason: "heartbeat-timeout",
      });
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });

  it("creates a file reporter that keeps the current snapshot queryable", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-progress-reporter-"));
    try {
      const reporter = createIndexProgressFileReporter({
        indexPath,
        operation: "index",
        runId: "run-3",
        now: () => new Date("2026-05-20T12:00:00.000Z"),
      });

      await reporter.report({
        status: "running",
        phase: "discovering",
        message: "Discovering source files",
        counters: { filesDiscovered: 4 },
      });

      expect(await readIndexProgress(indexPath, {
        isPidAlive: () => true,
        now: new Date("2026-05-20T12:00:01.000Z"),
      })).toMatchObject({
        runId: "run-3",
        operation: "index",
        status: "running",
        phase: "discovering",
        counters: { filesDiscovered: 4 },
      });
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });

  it("appends JSONL events and returns recent events through the progress query", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-progress-events-"));
    let now = new Date("2026-05-20T12:00:00.000Z");
    try {
      const reporter = createIndexProgressFileReporter({
        indexPath,
        operation: "index",
        runId: "run-events",
        now: () => now,
      });

      await reporter.report({
        phase: "graph",
        event: "step_started",
        currentRepo: "fixture",
        currentStep: "relationship-graph",
        message: "Building relationship graph",
      });
      now = new Date("2026-05-20T12:00:01.000Z");
      await reporter.report({
        phase: "graph",
        event: "step_succeeded",
        currentRepo: "fixture",
        currentStep: "relationship-graph",
        message: "Built relationship graph",
        durationMs: 1000,
        counters: { edgesWritten: 2 },
      });

      const events = (await readFile(progressLogPath(indexPath, "run-events"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events).toMatchObject([
        {
          event: "step_started",
          phase: "graph",
          currentRepo: "fixture",
          currentStep: "relationship-graph",
          memory: {
            rssMb: expect.any(Number),
            heapUsedMb: expect.any(Number),
          },
        },
        {
          event: "step_succeeded",
          durationMs: 1000,
          counters: { edgesWritten: 2 },
        },
      ]);
      await expect(readIndexProgress(indexPath, {
        isPidAlive: () => true,
        now: new Date("2026-05-20T12:00:02.000Z"),
      })).resolves.toMatchObject({
        phase: "graph",
        currentRepo: "fixture",
        currentStep: "relationship-graph",
        startedStepAt: "2026-05-20T12:00:00.000Z",
      });

      await expect(getIndexProgress(
        { workspace: indexPath, indexPath: "." },
        { includeEvents: true, limit: 1, now: new Date("2026-05-20T12:00:02.000Z") },
      )).resolves.toMatchObject({
        events: [
          {
            event: "step_succeeded",
            currentStep: "relationship-graph",
          },
        ],
        writeLock: {
          status: "unlocked",
        },
      });
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });

  it("records rich failure details in progress events", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-progress-error-"));
    try {
      const reporter = createIndexProgressFileReporter({
        indexPath,
        operation: "update",
        runId: "run-error",
        now: () => new Date("2026-05-20T12:00:00.000Z"),
      });
      const error = Object.assign(new TypeError("index exploded"), { code: "ERR_INDEX_EXPLODED" });
      error.stack = `TypeError: index exploded\n${"x".repeat(10_000)}`;

      await reporter.report({
        status: "failed",
        phase: "failed",
        event: "run_failed",
        message: "Index update failed",
        error,
      });

      const [event] = (await readFile(progressLogPath(indexPath, "run-error"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(event.error).toMatchObject({
        name: "TypeError",
        code: "ERR_INDEX_EXPLODED",
        message: "index exploded",
        stack: expect.stringContaining("TypeError: index exploded"),
      });
      expect(Buffer.byteLength(event.error.stack, "utf8")).toBeLessThanOrEqual(4096);
      await expect(readIndexProgress(indexPath)).resolves.toMatchObject({
        status: "failed",
        error: "index exploded",
        errorDetails: {
          name: "TypeError",
          code: "ERR_INDEX_EXPLODED",
        },
      });
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });

  it("reports index write lock ownership and age", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-progress-lock-"));
    const lockPath = join(indexPath, ".index-write.lock");
    try {
      await mkdir(lockPath);
      await writeFile(
        join(lockPath, "owner.json"),
        JSON.stringify({ pid: process.pid, createdAt: "2026-05-20T12:00:00.000Z" }),
      );

      await expect(getIndexProgress(
        { workspace: indexPath, indexPath: "." },
        { now: new Date("2026-05-20T12:00:03.000Z") },
      )).resolves.toMatchObject({
        writeLock: {
          status: "held",
          path: lockPath,
          pid: process.pid,
          createdAt: "2026-05-20T12:00:00.000Z",
          ageMs: 3000,
          alive: true,
        },
      });
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });

  it("rejects invalid progress status, operation, and step shapes", () => {
    expect(() =>
      IndexProgressSnapshotSchema.parse({
        schemaVersion,
        runId: "bad",
        operation: "scan",
        status: "moving",
        phase: "discovering",
        message: "Bad snapshot",
        indexPath: "/tmp/index",
        pid: process.pid,
        startedAt: "2026-05-20T12:00:00.000Z",
        updatedAt: "2026-05-20T12:00:00.000Z",
        counters: {},
      }),
    ).toThrow();
    expect(() =>
      IndexProgressSnapshotSchema.parse({
        schemaVersion,
        runId: "bad-step",
        operation: "index",
        status: "running",
        phase: "graph",
        currentStep: "almost-relationship-graph",
        message: "Bad snapshot",
        indexPath: "/tmp/index",
        pid: process.pid,
        startedAt: "2026-05-20T12:00:00.000Z",
        updatedAt: "2026-05-20T12:00:00.000Z",
        counters: {},
      }),
    ).toThrow();
  });

  it("requires event-specific payload fields", () => {
    const baseEvent = {
      schemaVersion,
      runId: "run-event",
      operation: "index",
      phase: "scip",
      message: "Recorded SCIP quality",
      indexPath: "/tmp/index",
      pid: process.pid,
      timestamp: "2026-05-20T12:00:00.000Z",
      counters: {},
      memory: { rssMb: 1, heapUsedMb: 1 },
    };

    expect(() =>
      IndexProgressEventSchema.parse({
        ...baseEvent,
        event: "scip_quality",
        currentStep: "scip-quality",
      }),
    ).toThrow();
    expect(() =>
      IndexProgressEventSchema.parse({
        ...baseEvent,
        event: "step_started",
        currentStep: "not-a-real-step",
      }),
    ).toThrow();
    expect(() =>
      IndexProgressEventSchema.parse({
        ...baseEvent,
        event: "phase_started",
        status: "stale",
      }),
    ).toThrow();
  });
});
