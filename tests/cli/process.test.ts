import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { copyFixtureWorkspace, mutateFixtureWorkspace } from "../helpers/incremental-fixture.js";

const cliPath = new URL("../../dist/cli/main.js", import.meta.url).pathname;

describe("code-intel process behavior", () => {
  it("prints the package version", async () => {
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    const result = await execa("node", [cliPath, "--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(packageJson.version);
    expect(result.stderr).toBe("");
  });

  it("prints help to stdout", async () => {
    const result = await execa("node", [cliPath, "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: code-intel");
    expect(result.stdout).toContain("relationships");
    expect(result.stderr).toBe("");
  });

  it("prints relationship command help with graph filters", async () => {
    const result = await execa("node", [cliPath, "relationships", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: code-intel relationships");
    expect(result.stdout).toContain("--edge-kind");
    expect(result.stdout).toContain("--direction");
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
      expect(symbolResult.stdout).toMatch(/^\{\n  "query": "calculateGivingTotal",\n  "results": \[/);

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

      const relationshipsResult = await execa("node", [
        cliPath,
        "relationships",
        "calculateGivingTotal",
        "--workspace",
        fixturePath,
        "--index-path",
        indexPath,
        "--edge-kind",
        "CALLS",
        "REFERENCES",
        "--direction",
        "incoming",
        "--limit",
        "10",
        "--json",
      ]);
      const relationshipsPayload = JSON.parse(relationshipsResult.stdout);
      expect(relationshipsPayload.results.map((item: { file?: string }) => item.file)).toEqual(
        expect.arrayContaining(["packages/core/src/ledger.ts", "packages/core/src/tithe.test.ts"]),
      );
      expect(relationshipsPayload.results.every((item: { excerpt?: string }) => item.excerpt === undefined)).toBe(true);
      expect(relationshipsPayload.results.some((item: { metadata: { relationship?: { evidenceSources?: string[] } } }) =>
        item.metadata.relationship?.evidenceSources?.length,
      )).toBe(true);

      const fileDiagnosticResult = await execa("node", [
        cliPath,
        "diagnose",
        "file",
        "packages/core/src/tithe.ts",
        "--workspace",
        fixturePath,
        "--index-path",
        indexPath,
        "--json",
      ]);
      expect(JSON.parse(fileDiagnosticResult.stdout)).toMatchObject({
        matched: true,
        file: {
          status: "indexed",
          lifecycle: {
            graph: { status: "pass" },
            embeddings: { status: "pass" },
            symbolQueryability: { status: "pass" },
          },
        },
      });

      const symbolDiagnosticResult = await execa("node", [
        cliPath,
        "diagnose",
        "symbol",
        "calculateGivingTotal",
        "--workspace",
        fixturePath,
        "--index-path",
        indexPath,
        "--json",
      ]);
      expect(JSON.parse(symbolDiagnosticResult.stdout)).toEqual(expect.objectContaining({
        matched: true,
        symbols: expect.arrayContaining([
          expect.objectContaining({
            name: "calculateGivingTotal",
            file: "packages/core/src/tithe.ts",
          }),
        ]),
      }));

      const contextResult = await execa("node", [
        cliPath,
        "get-context",
        symbolPayload.results[0].id,
        "--workspace",
        fixturePath,
        "--index-path",
        indexPath,
        "--limit",
        "1",
        "--json",
      ]);
      const contextPayload = JSON.parse(contextResult.stdout);
      expect(contextPayload.results).toHaveLength(1);
      expect(contextPayload.results[0].excerpt).toMatch(/calculateGivingTotal/);
      expect(Buffer.byteLength(contextPayload.results[0].excerpt, "utf8")).toBeLessThanOrEqual(16_000);
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
          unchanged: 26,
        },
        chunks: {
          reused: 37,
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

  it("rejects invalid relationship directions", async () => {
    const result = await execa("node", [cliPath, "relationships", "value", "--direction", "sideways"], {
      reject: false,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Expected --direction to be outgoing, incoming, or either");
  });
});
