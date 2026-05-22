import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

import { copyFixtureWorkspace, mutateFixtureWorkspace } from "../helpers/incremental-fixture.js";

const cliPath = new URL("../../dist/cli/main.js", import.meta.url).pathname;
const fixturePath = new URL("../fixtures/js-ts-workspace", import.meta.url).pathname;
const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
};

describe("MCP stdio server", () => {
  it("lists and calls code intelligence tools without stdout pollution", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-mcp-"));
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
    const externalCliRead = await execa("node", [
      cliPath,
      "find-symbol",
      "calculateGivingTotal",
      "--workspace",
      fixturePath,
      "--index-path",
      indexPath,
      "--json",
    ]);
    expect(JSON.parse(externalCliRead.stdout).results[0].file).toBe("packages/core/src/tithe.ts");

    const transport = new StdioClientTransport({
      command: "node",
      args: [
        cliPath,
        "mcp",
        "--workspace",
        fixturePath,
        "--index-path",
        indexPath,
        "--embedding-provider",
        "hash",
      ],
      cwd: new URL("../..", import.meta.url).pathname,
      stderr: "pipe",
    });
    const client = new Client({ name: "code-intel-test", version: "0.1.0" });

    try {
      await client.connect(transport);
      expect(client.getServerVersion()).toEqual({
        name: "code-intel",
        version: packageJson.version,
      });

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "workspace_overview",
          "health",
          "index_progress",
          "search_text",
          "semantic_search",
          "find_symbol",
          "get_symbol",
          "get_references",
          "get_callers",
          "get_callees",
          "get_relationships",
          "expand_context",
          "get_context",
          "trace_path",
          "diagnose_file",
          "diagnose_symbol",
        ]),
      );
      expect(tools.tools.find((tool) => tool.name === "semantic_search")?.description).toContain(
        "hybrid semantic code search",
      );
      expect(tools.tools.find((tool) => tool.name === "trace_path")?.description).toContain(
        "evidence",
      );
      for (const tool of tools.tools.filter((tool) => tool.name !== undefined)) {
        expect(tool.outputSchema, `${tool.name} should advertise structured output`).toBeDefined();
      }

      const health = await client.callTool({ name: "health", arguments: {} });
      const healthPayload = parseStructuredTool(health);
      expect(healthPayload).toMatchObject({
        tool: "health",
        guidance: {
          nextTools: expect.arrayContaining(["workspace_overview", "semantic_search"]),
        },
      });

      const symbol = await client.callTool({
        name: "find_symbol",
        arguments: { name: "calculateGivingTotal", limit: 5 },
      });
      const symbolPayload = parseStructuredTool(symbol);
      expect(symbolPayload.result.results[0].file).toBe(
        "packages/core/src/tithe.ts",
      );

      const symbolId = symbolPayload.result.results[0].id;
      const overview = await client.callTool({ name: "workspace_overview", arguments: {} });
      const overviewPayload = parseStructuredTool(overview);
      expect(overviewPayload.result.indexed).toBe(true);
      expect(overviewPayload.result.writeLock).toMatchObject({
        status: "unlocked",
      });
      expect(overviewPayload.result.progress).toMatchObject({
        operation: "index",
        status: "succeeded",
        phase: "succeeded",
      });

      const progress = await client.callTool({
        name: "index_progress",
        arguments: { includeEvents: true, limit: 50 },
      });
      expect(parseStructuredTool(progress)).toMatchObject({
        tool: "index_progress",
        result: {
          writeLock: {
            status: "unlocked",
          },
          progress: {
            operation: "index",
            status: "succeeded",
            phase: "succeeded",
          },
          events: expect.arrayContaining([
            expect.objectContaining({
              event: "run_succeeded",
            }),
            expect.objectContaining({
              event: "scip_quality",
              scip: expect.objectContaining({
                outputBytes: expect.any(Number),
              }),
            }),
          ]),
        },
      });

      const text = await client.callTool({
        name: "search_text",
        arguments: { pattern: "calculateGivingTotal(", limit: 5 },
      });
      expect(parseStructuredTool(text).result.results.map((item: { file?: string }) => item.file)).toContain(
        "packages/core/src/tithe.ts",
      );

      const semantic = await client.callTool({
        name: "semantic_search",
        arguments: { query: "giving receipt summary", limit: 5, packageName: "@fixture/core" },
      });
      const semanticPayload = parseStructuredTool(semantic);
      expect(semanticPayload.result.results.length).toBeGreaterThan(0);
      expect(semanticPayload.result.results[0].metadata).not.toHaveProperty("content");
      expect(semanticPayload.result.results[0]).not.toHaveProperty("excerpt");
      expect(semanticPayload.result.results[0].metadata.ranking.reasons.length).toBeGreaterThan(0);
      expect(semanticPayload.guidance).toMatchObject({
        purpose: expect.stringContaining("conceptually relevant code"),
        evidenceFields: expect.arrayContaining(["metadata.ranking.reasons"]),
        nextTools: expect.arrayContaining(["expand_context", "get_context"]),
      });

      const context = await client.callTool({
        name: "get_context",
        arguments: { nodeId: semanticPayload.result.results[0].id, limit: 1 },
      });
      expect(parseStructuredTool(context).result.results[0].excerpt).toMatch(/giving/i);

      const references = await client.callTool({
        name: "get_references",
        arguments: { symbol: "calculateGivingTotal", limit: 10 },
      });
      const referencesPayload = parseStructuredTool(references);
      expect(referencesPayload.result.results.map((item: { file?: string }) => item.file)).toContain(
        "packages/core/src/tithe.test.ts",
      );
      expect(referencesPayload.result.results.some((item: { metadata: { relationship?: { evidenceSources?: string[] } } }) =>
        item.metadata.relationship?.evidenceSources?.length,
      )).toBe(true);

      const relationships = await client.callTool({
        name: "get_relationships",
        arguments: {
          seed: "calculateGivingTotal",
          direction: "incoming",
          allowedEdgeKinds: ["CALLS", "REFERENCES"],
          limit: 10,
        },
      });
      const relationshipsPayload = parseStructuredTool(relationships);
      expect(relationshipsPayload.guidance.nextTools).toEqual(
        expect.arrayContaining(["trace_path", "get_context"]),
      );
      expect(relationshipsPayload.result.results.map((item: { file?: string }) => item.file)).toContain(
        "packages/core/src/tithe.test.ts",
      );
      expect(relationshipsPayload.result.results.every((item: { excerpt?: string }) => item.excerpt === undefined)).toBe(
        true,
      );

      const [parallelSymbol, parallelSemantic, parallelCallers] = await Promise.all([
        client.callTool({
          name: "find_symbol",
          arguments: { name: "calculateGivingTotal", limit: 5 },
        }),
        client.callTool({
          name: "semantic_search",
          arguments: { query: "giving receipt summary", limit: 5 },
        }),
        client.callTool({
          name: "get_callers",
          arguments: { symbol: "calculateGivingTotal", limit: 10 },
        }),
      ]);
      expect(parseStructuredTool(parallelSymbol).result.results[0].file).toBe("packages/core/src/tithe.ts");
      expect(parseStructuredTool(parallelSemantic).result.results.length).toBeGreaterThan(0);
      expect(parseStructuredTool(parallelCallers).result.results.map((item: { file?: string }) => item.file)).toContain(
        "packages/core/src/ledger.ts",
      );

      const callers = await client.callTool({
        name: "get_callers",
        arguments: { symbol: "calculateGivingTotal", limit: 10 },
      });
      expect(parseStructuredTool(callers).result.results.map((item: { file?: string }) => item.file)).toContain(
        "packages/core/src/ledger.ts",
      );

      const callees = await client.callTool({
        name: "get_callees",
        arguments: { symbol: "summarize", limit: 10 },
      });
      expect(parseStructuredTool(callees).result.results.map((item: { file?: string }) => item.file)).toContain(
        "packages/core/src/tithe.ts",
      );

      const expanded = await client.callTool({
        name: "expand_context",
        arguments: { nodeId: semanticPayload.result.results[0].id, depth: 1, limit: 10 },
      });
      expect(parseStructuredTool(expanded).result.results.length).toBeGreaterThan(0);

      const getSymbol = await client.callTool({
        name: "get_symbol",
        arguments: { idOrName: symbolId },
      });
      expect(parseStructuredTool(getSymbol).result.results[0].id).toBe(symbolId);

      const summarize = await client.callTool({
        name: "find_symbol",
        arguments: { name: "summarize", limit: 1 },
      });
      const trace = await client.callTool({
        name: "trace_path",
        arguments: {
          fromId: parseStructuredTool(summarize).result.results[0].id,
          toId: symbolId,
          limit: 10,
          maxDepth: 4,
          allowedEdgeKinds: ["CALLS", "REFERENCES"],
          direction: "outgoing",
        },
      });
      const tracePayload = parseStructuredTool(trace);
      expect(tracePayload.result.results.map((item: { id: string }) => item.id)).toContain(symbolId);
      expect(tracePayload.result.results.some((item: { metadata: Record<string, unknown> }) =>
        Array.isArray(item.metadata.pathEdges),
      )).toBe(true);

      const diagnoseFile = await client.callTool({
        name: "diagnose_file",
        arguments: { path: "packages/core/src/tithe.ts" },
      });
      expect(parseStructuredTool(diagnoseFile)).toMatchObject({
        tool: "diagnose_file",
        result: {
          matched: true,
          file: {
            relativePath: "packages/core/src/tithe.ts",
            queryability: {
              semantic: true,
            },
          },
        },
      });

      const diagnoseSymbol = await client.callTool({
        name: "diagnose_symbol",
        arguments: { name: "calculateGivingTotal" },
      });
      expect(parseStructuredTool(diagnoseSymbol)).toMatchObject({
        tool: "diagnose_symbol",
        result: {
          matched: true,
          symbols: expect.arrayContaining([
            expect.objectContaining({
              name: "calculateGivingTotal",
              file: "packages/core/src/tithe.ts",
            }),
          ]),
        },
      });

      const invalid = await client.callTool({
        name: "find_symbol",
        arguments: { name: "", limit: 5 },
      });
      expect(invalid.isError).toBe(true);

      const healthAfterQuery = await client.callTool({ name: "health", arguments: {} });
      expect(parseStructuredTool(healthAfterQuery).tool).toBe("health");
    } finally {
      await client.close();
      await rm(indexPath, { recursive: true, force: true });
    }
  }, 60_000);

  it("serves the active generation after an incremental update", async () => {
    const workspaceRoot = await copyFixtureWorkspace();
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-mcp-update-"));
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
    await execa("node", [
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

    const transport = new StdioClientTransport({
      command: "node",
      args: [
        cliPath,
        "mcp",
        "--workspace",
        workspaceRoot,
        "--index-path",
        indexPath,
        "--embedding-provider",
        "hash",
      ],
      cwd: new URL("../..", import.meta.url).pathname,
      stderr: "pipe",
    });
    const client = new Client({ name: "code-intel-update-test", version: "0.1.0" });

    try {
      await client.connect(transport);
      const symbol = await client.callTool({
        name: "find_symbol",
        arguments: { name: "createBlessingNote", limit: 5 },
      });
      expect(parseStructuredTool(symbol).result.results[0].file).toBe("packages/core/src/blessing.ts");

      const deletedSymbol = await client.callTool({
        name: "find_symbol",
        arguments: { name: "PrimaryRenderer", limit: 5 },
      });
      expect(parseStructuredTool(deletedSymbol).result.results).toEqual([]);

      const references = await client.callTool({
        name: "get_references",
        arguments: { symbol: "calculateGivingTotal", limit: 20 },
      });
      expect(parseStructuredTool(references).result.results.map((item: { file?: string }) => item.file)).not.toContain(
        "packages/core/src/tithe.test.ts",
      );

      const semantic = await client.callTool({
        name: "semantic_search",
        arguments: { query: "primary renderer", limit: 5, fileKind: "source" },
      });
      expect(parseStructuredTool(semantic).result.results.map((item: { file?: string }) => item.file)).not.toContain(
        "packages/core/src/duplicateMethods.ts",
      );
    } finally {
      await client.close();
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(indexPath, { recursive: true, force: true });
    }
  }, 60_000);

  it("exits promptly when the SDK stdio transport closes after a progress-only session", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-mcp-close-"));
    const transport = new StdioClientTransport({
      command: "node",
      args: [
        cliPath,
        "mcp",
        "--workspace",
        fixturePath,
        "--index-path",
        indexPath,
        "--embedding-provider",
        "hash",
      ],
      cwd: new URL("../..", import.meta.url).pathname,
      stderr: "pipe",
    });
    const client = new Client({ name: "code-intel-close-test", version: "0.1.0" });

    try {
      await client.connect(transport);
      const pid = transport.pid;
      expect(pid).toEqual(expect.any(Number));
      const progress = await client.callTool({
        name: "index_progress",
        arguments: { includeEvents: true, limit: 5 },
      });
      expect(parseStructuredTool(progress).tool).toBe("index_progress");

      const closeStart = performance.now();
      await client.close();
      const closeMs = performance.now() - closeStart;
      expect(closeMs).toBeLessThan(1_800);
      await expect(waitForProcessExit(pid!, 1_000)).resolves.toBeUndefined();
    } finally {
      await client.close().catch(() => undefined);
      await rm(indexPath, { recursive: true, force: true });
    }
  }, 20_000);
});

function parseStructuredTool(result: {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}) {
  expect(result.structuredContent).toBeDefined();
  const textPayload = parseToolText(result);
  expect(result.structuredContent).toEqual(textPayload);
  return result.structuredContent as {
    tool: string;
    guidance: { nextTools: string[] };
    result: {
      indexed?: boolean;
      matched?: boolean;
      file?: unknown;
      symbols?: unknown[];
      results: Array<{
        id: string;
        file?: string;
        excerpt?: string;
        metadata: {
          ranking?: { reasons: unknown[] };
          relationship?: { evidenceSources?: string[] };
          pathEdges?: unknown[];
        };
      }>;
    };
  };
}

function parseToolText(result: { content: Array<{ type: string; text?: string }> }) {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("Tool did not return text content");
  }
  return JSON.parse(text);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (!processIsAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${pid} did not exit within ${timeoutMs}ms`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
