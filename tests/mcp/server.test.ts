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
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "workspace_overview",
          "health",
          "search_text",
          "semantic_search",
          "find_symbol",
          "get_symbol",
          "get_references",
          "get_callers",
          "get_callees",
          "expand_context",
          "get_context",
          "trace_path",
        ]),
      );

      const health = await client.callTool({ name: "health", arguments: {} });
      expect(parseToolText(health).tool).toBe("health");

      const symbol = await client.callTool({
        name: "find_symbol",
        arguments: { name: "calculateGivingTotal", limit: 5 },
      });
      const symbolPayload = parseToolText(symbol);
      expect(symbolPayload.result.results[0].file).toBe(
        "packages/core/src/tithe.ts",
      );

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

      const symbolId = symbolPayload.result.results[0].id;
      const overview = await client.callTool({ name: "workspace_overview", arguments: {} });
      expect(parseToolText(overview).result.indexed).toBe(true);

      const text = await client.callTool({
        name: "search_text",
        arguments: { pattern: "calculateGivingTotal(", limit: 5 },
      });
      expect(parseToolText(text).result.results.map((item: { file?: string }) => item.file)).toContain(
        "packages/core/src/tithe.ts",
      );

      const semantic = await client.callTool({
        name: "semantic_search",
        arguments: { query: "giving receipt summary", limit: 5, packageName: "@fixture/core" },
      });
      const semanticPayload = parseToolText(semantic);
      expect(semanticPayload.result.results.length).toBeGreaterThan(0);
      expect(semanticPayload.result.results[0].metadata).not.toHaveProperty("content");

      const context = await client.callTool({
        name: "get_context",
        arguments: { nodeId: semanticPayload.result.results[0].id, limit: 1 },
      });
      expect(parseToolText(context).result.results[0].excerpt).toMatch(/giving/i);

      const references = await client.callTool({
        name: "get_references",
        arguments: { symbol: "calculateGivingTotal", limit: 10 },
      });
      expect(parseToolText(references).result.results.map((item: { file?: string }) => item.file)).toContain(
        "packages/core/src/tithe.test.ts",
      );

      const callers = await client.callTool({
        name: "get_callers",
        arguments: { symbol: "calculateGivingTotal", limit: 10 },
      });
      expect(parseToolText(callers).result.results.map((item: { file?: string }) => item.file)).toContain(
        "packages/core/src/ledger.ts",
      );

      const callees = await client.callTool({
        name: "get_callees",
        arguments: { symbol: "summarize", limit: 10 },
      });
      expect(parseToolText(callees).result.results.map((item: { file?: string }) => item.file)).toContain(
        "packages/core/src/tithe.ts",
      );

      const expanded = await client.callTool({
        name: "expand_context",
        arguments: { nodeId: semanticPayload.result.results[0].id, depth: 1, limit: 10 },
      });
      expect(parseToolText(expanded).result.results.length).toBeGreaterThan(0);

      const getSymbol = await client.callTool({
        name: "get_symbol",
        arguments: { idOrName: symbolId },
      });
      expect(parseToolText(getSymbol).result.results[0].id).toBe(symbolId);

      const summarize = await client.callTool({
        name: "find_symbol",
        arguments: { name: "summarize", limit: 1 },
      });
      const trace = await client.callTool({
        name: "trace_path",
        arguments: {
          fromId: parseToolText(summarize).result.results[0].id,
          toId: symbolId,
          limit: 10,
        },
      });
      expect(parseToolText(trace).result.results.map((item: { id: string }) => item.id)).toContain(symbolId);

      const invalid = await client.callTool({
        name: "find_symbol",
        arguments: { name: "", limit: 5 },
      });
      expect(invalid.isError).toBe(true);

      const healthAfterQuery = await client.callTool({ name: "health", arguments: {} });
      expect(parseToolText(healthAfterQuery).tool).toBe("health");
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
      expect(parseToolText(symbol).result.results[0].file).toBe("packages/core/src/blessing.ts");

      const deletedSymbol = await client.callTool({
        name: "find_symbol",
        arguments: { name: "PrimaryRenderer", limit: 5 },
      });
      expect(parseToolText(deletedSymbol).result.results).toEqual([]);

      const references = await client.callTool({
        name: "get_references",
        arguments: { symbol: "calculateGivingTotal", limit: 20 },
      });
      expect(parseToolText(references).result.results.map((item: { file?: string }) => item.file)).not.toContain(
        "packages/core/src/tithe.test.ts",
      );

      const semantic = await client.callTool({
        name: "semantic_search",
        arguments: { query: "primary renderer", limit: 5, fileKind: "source" },
      });
      expect(parseToolText(semantic).result.results.map((item: { file?: string }) => item.file)).not.toContain(
        "packages/core/src/duplicateMethods.ts",
      );
    } finally {
      await client.close();
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(indexPath, { recursive: true, force: true });
    }
  }, 60_000);
});

function parseToolText(result: { content: Array<{ type: string; text?: string }> }) {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("Tool did not return text content");
  }
  return JSON.parse(text);
}
