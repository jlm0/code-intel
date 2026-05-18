import { execa } from "execa";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const cliPath = new URL("../../dist/cli/main.js", import.meta.url).pathname;
const fixturePath = new URL("../fixtures/js-ts-workspace", import.meta.url).pathname;

describe("fixture eval", () => {
  it("passes the built-in fixture evaluation suite with the default Jina provider", async () => {
    const result = await execa("node", [cliPath, "eval", "--json"]);
    const payload = JSON.parse(result.stdout);

    expect(payload.status).toBe("pass");
    expect(payload.blockingStatus).toBe("pass");
    expect(payload.qualityStatus).toBe("pass");
    expect(payload.summary).toMatchObject({
      blockingStatus: "pass",
      qualityStatus: "pass",
      gateStatuses: {
        required: {
          blocking: true,
          resultStatus: "pass",
        },
      },
    });
    expect(payload.suite).toMatchObject({
      id: "js-ts-general",
      kind: "synthetic",
    });
    expect(payload.embedding).toMatchObject({
      provider: "jina",
      model: "jinaai/jina-embeddings-v2-base-code",
      dimension: 768,
    });
    expect(payload.cases.map((testCase: { id: string }) => testCase.id)).toEqual(
      expect.arrayContaining([
        "synthetic.exported-function",
        "synthetic.react-hook",
        "synthetic.caller-relationship",
        "synthetic.semantic-concept",
      ]),
    );
  }, 180_000);

  it("runs the synthetic eval pack by suite id with rank and false-positive evidence", async () => {
    const result = await execa("node", [
      cliPath,
      "eval",
      "--suite",
      "js-ts-general",
      "--embedding-provider",
      "hash",
      "--json",
    ]);
    const payload = JSON.parse(result.stdout);

    expect(payload.status).toBe("pass");
    expect(payload.summary.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "synthetic.false-positive-guards",
          gateStatus: "required",
          capability: "false-positive-guard",
          layer: "graph",
          blocking: true,
          resultStatus: "pass",
        }),
      ]),
    );
    expect(payload.suite).toMatchObject({
      id: "js-ts-general",
      name: "JS/TS General Synthetic Fixture",
      kind: "synthetic",
    });
    expect(payload.corpus).toMatchObject({
      type: "local",
    });
    expect(payload.cases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "synthetic.exported-function",
          mode: "find-symbol",
          query: "calculateGivingTotal",
          status: "pass",
          expected: expect.arrayContaining([
            expect.objectContaining({
              file: "packages/core/src/tithe.ts",
              found: true,
              rank: expect.any(Number),
            }),
          ]),
          latencyMs: expect.any(Number),
        }),
        expect.objectContaining({
          id: "synthetic.false-positive-guard",
          status: "pass",
          notExpected: expect.arrayContaining([
            expect.objectContaining({
              file: "packages/core/src/duplicateMethods.ts",
              found: false,
            }),
          ]),
        }),
      ]),
    );
  });

  it("includes diagnostics preflight in CLI eval JSON when requested", async () => {
    const result = await execa("node", [
      cliPath,
      "eval",
      "--suite",
      "js-ts-general",
      "--embedding-provider",
      "hash",
      "--diagnostics",
      "--json",
    ]);
    const payload = JSON.parse(result.stdout);

    expect(payload.diagnostics.summary).toMatchObject({
      expectedChecked: expect.any(Number),
      notExpectedChecked: expect.any(Number),
      missingFiles: 0,
    });
    expect(payload.diagnostics.preflight).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "packages/core/src/tithe.ts",
          fileExists: true,
          indexed: true,
          graphQueryable: true,
        }),
      ]),
    );
  }, 60_000);

  it("requires fetch or a cached checkout for the Rallly on-demand eval pack", async () => {
    const evalCachePath = await mkdtemp(join(tmpdir(), "code-intel-eval-cache-"));
    try {
      const result = await execa(
        "node",
        [
          cliPath,
          "eval",
          "--suite",
          "oss-rallly-app-flow",
          "--eval-cache-path",
          evalCachePath,
          "--embedding-provider",
          "hash",
          "--json",
        ],
        { reject: false },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("requires --fetch");
    } finally {
      await rm(evalCachePath, { recursive: true, force: true });
    }
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
        "--embedding-provider",
        "hash",
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
