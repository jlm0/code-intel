import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { copyFixtureWorkspace, mutateFixtureWorkspace } from "../helpers/incremental-fixture.js";

const cliPath = new URL("../../dist/cli/main.js", import.meta.url).pathname;

describe("code-intel process behavior", () => {
  it("prints help to stdout", async () => {
    const result = await execa("node", [cliPath, "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: code-intel");
    expect(result.stderr).toBe("");
  });

  it("returns JSON health checks", async () => {
    const result = await execa("node", [cliPath, "health", "--embedding-provider", "hash", "--json"]);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.schemaVersion).toBe("code-intel.v1");
    expect(payload.checks.map((check: { name: string }) => check.name)).toContain("node");
    expect(payload.status).toMatch(/^(ok|warn|fail)$/);
    expect(result.stderr).toBe("");
  });

  it("returns status before indexing", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-status-"));
    try {
      const result = await execa("node", [
        cliPath,
        "status",
        "--index-path",
        indexPath,
        "--json",
      ]);
      const payload = JSON.parse(result.stdout);

      expect(payload.indexed).toBe(false);
      expect(payload.indexPath).toBe(indexPath);
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });

  it("indexes and queries the fixture repo through the built CLI", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-cli-index-"));
    const fixturePath = new URL("../fixtures/js-ts-workspace", import.meta.url).pathname;
    try {
      const indexResult = await execa("node", [
        cliPath,
        "index",
        "--workspace",
        fixturePath,
        "--repo",
        fixturePath,
        "--index-path",
        indexPath,
        "--embedding-provider",
        "hash",
        "--json",
      ]);
      const indexPayload = JSON.parse(indexResult.stdout);
      expect(indexPayload.stats.chunks).toBeGreaterThan(0);

      const statusResult = await execa("node", [
        cliPath,
        "status",
        "--workspace",
        fixturePath,
        "--index-path",
        indexPath,
        "--json",
      ]);
      expect(JSON.parse(statusResult.stdout).indexed).toBe(true);

      const symbolResult = await execa("node", [
        cliPath,
        "find-symbol",
        "calculateGivingTotal",
        "--workspace",
        fixturePath,
        "--index-path",
        indexPath,
        "--json",
      ]);
      const symbolPayload = JSON.parse(symbolResult.stdout);
      expect(symbolPayload.results[0].file).toBe("packages/core/src/tithe.ts");

      const callersResult = await execa("node", [
        cliPath,
        "callers",
        "calculateGivingTotal",
        "--workspace",
        fixturePath,
        "--index-path",
        indexPath,
        "--json",
      ]);
      expect(JSON.parse(callersResult.stdout).results.map((item: { file?: string }) => item.file)).toContain(
        "packages/core/src/ledger.ts",
      );
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });

  it("updates a changed fixture repo incrementally through the built CLI", async () => {
    const workspaceRoot = await copyFixtureWorkspace();
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-cli-update-"));
    try {
      await execa("node", [
        cliPath,
        "index",
        "--workspace",
        workspaceRoot,
        "--repo",
        workspaceRoot,
        "--index-path",
        indexPath,
        "--embedding-provider",
        "hash",
        "--json",
      ]);

      await mutateFixtureWorkspace(workspaceRoot);

      const updateResult = await execa("node", [
        cliPath,
        "update",
        "--workspace",
        workspaceRoot,
        "--repo",
        workspaceRoot,
        "--index-path",
        indexPath,
        "--embedding-provider",
        "hash",
        "--json",
      ]);
      const updatePayload = JSON.parse(updateResult.stdout);
      expect(updatePayload.incremental).toMatchObject({
        mode: "incremental",
        files: {
          added: 1,
          changed: 1,
          deleted: 2,
          unchanged: 5,
        },
        chunks: {
          reused: 6,
          embedded: 3,
        },
      });

      const symbolResult = await execa("node", [
        cliPath,
        "find-symbol",
        "createBlessingNote",
        "--workspace",
        workspaceRoot,
        "--index-path",
        indexPath,
        "--json",
      ]);
      expect(JSON.parse(symbolResult.stdout).results[0].file).toBe("packages/core/src/blessing.ts");

      const deletedSymbolResult = await execa("node", [
        cliPath,
        "find-symbol",
        "PrimaryRenderer",
        "--workspace",
        workspaceRoot,
        "--index-path",
        indexPath,
        "--json",
      ]);
      expect(JSON.parse(deletedSymbolResult.stdout).results).toEqual([]);

      const referencesResult = await execa("node", [
        cliPath,
        "references",
        "calculateGivingTotal",
        "--workspace",
        workspaceRoot,
        "--index-path",
        indexPath,
        "--json",
      ]);
      expect(JSON.parse(referencesResult.stdout).results.map((item: { file?: string }) => item.file)).not.toContain(
        "packages/core/src/tithe.test.ts",
      );
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(indexPath, { recursive: true, force: true });
    }
  });

  it("serializes concurrent CLI reads against the same Ladybug index", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-cli-concurrent-"));
    const fixturePath = new URL("../fixtures/js-ts-workspace", import.meta.url).pathname;
    try {
      await execa("node", [
        cliPath,
        "index",
        "--workspace",
        fixturePath,
        "--repo",
        fixturePath,
        "--index-path",
        indexPath,
        "--embedding-provider",
        "hash",
        "--json",
      ]);

      const baseCommands = [
        ["find-symbol", "calculateGivingTotal"],
        ["semantic", "giving receipt summary"],
        ["callers", "calculateGivingTotal"],
        ["references", "calculateGivingTotal"],
        ["callees", "summarize"],
      ];
      const commands = Array.from({ length: 3 }, () => baseCommands).flat();
      const results = await Promise.all(
        commands.map((command) =>
          execa("node", [
            cliPath,
            ...command,
            "--workspace",
            fixturePath,
            "--index-path",
            indexPath,
            "--json",
          ]),
        ),
      );

      expect(results.every((result) => JSON.parse(result.stdout).results.length > 0)).toBe(true);
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });

  it("rejects invalid arguments with stderr and nonzero exit", async () => {
    const result = await execa("node", [cliPath, "find-symbol"], {
      reject: false,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("missing required argument");
  });

  it("rejects unbounded result limits", async () => {
    const result = await execa("node", [cliPath, "find-symbol", "value", "--limit", "999"], {
      reject: false,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Expected --limit to be at most 50");
  });
});
