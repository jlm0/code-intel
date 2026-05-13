import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";
import { beforeAll, describe, expect, it } from "vitest";

const cliPath = new URL("../../dist/cli/main.js", import.meta.url).pathname;

describe("code-intel process behavior", () => {
  beforeAll(async () => {
    await execa("npm", ["run", "build"]);
  });

  it("prints help to stdout", async () => {
    const result = await execa("node", [cliPath, "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: code-intel");
    expect(result.stderr).toBe("");
  });

  it("returns JSON health checks", async () => {
    const result = await execa("node", [cliPath, "health", "--json"]);
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
