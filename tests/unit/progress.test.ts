import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createIndexProgressFileReporter,
  progressCurrentPath,
  readIndexProgress,
  writeIndexProgress,
} from "../../src/core/progress.js";
import { IndexProgressSnapshotSchema, schemaVersion } from "../../src/schema/schemas.js";

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

  it("rejects invalid progress status and operation shapes", () => {
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
  });
});
