import { execa } from "execa";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const cliPath = new URL("../../dist/cli/main.js", import.meta.url).pathname;
const fixturePath = new URL("../fixtures/js-ts-workspace", import.meta.url).pathname;

describe("fixture eval", () => {
  beforeAll(async () => {
    await execa("npm", ["run", "build"]);
  });

  it("passes the built-in fixture evaluation suite", async () => {
    const result = await execa("node", [cliPath, "eval", "--json"]);
    const payload = JSON.parse(result.stdout);

    expect(payload.status).toBe("pass");
    expect(payload.cases.map((testCase: { name: string }) => testCase.name)).toEqual(
      expect.arrayContaining([
        "exported function",
        "react hook",
        "caller relationship",
        "semantic concept",
      ]),
    );
  });

  it("runs index, status, query, context, and persisted re-query through the built CLI", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-e2e-"));
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
      expect(JSON.parse(indexResult.stdout).stats.chunks).toBeGreaterThan(0);

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

      const semanticResult = await execa("node", [
        cliPath,
        "semantic",
        "giving receipt summary",
        "--workspace",
        fixturePath,
        "--index-path",
        indexPath,
        "--json",
      ]);
      const semanticPayload = JSON.parse(semanticResult.stdout);
      expect(semanticPayload.results.some((item: { file?: string }) => item.file?.includes("tithe.ts"))).toBe(true);

      const contextResult = await execa("node", [
        cliPath,
        "get-context",
        semanticPayload.results[0].id,
        "--workspace",
        fixturePath,
        "--index-path",
        indexPath,
        "--json",
      ]);
      expect(JSON.parse(contextResult.stdout).results[0].excerpt).toMatch(/giving/i);

      const referencesResult = await execa("node", [
        cliPath,
        "references",
        "calculateGivingTotal",
        "--workspace",
        fixturePath,
        "--index-path",
        indexPath,
        "--json",
      ]);
      expect(JSON.parse(referencesResult.stdout).results.map((item: { file?: string }) => item.file)).toContain(
        "packages/core/src/tithe.test.ts",
      );
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });
});
