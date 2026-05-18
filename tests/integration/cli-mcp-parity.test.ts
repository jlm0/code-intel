import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const cliPath = new URL("../../dist/cli/main.js", import.meta.url).pathname;
const fixturePath = new URL("../fixtures/js-ts-workspace", import.meta.url).pathname;

interface QueryResultLike {
  results: QueryResultItemLike[];
}

interface QueryResultItemLike {
  id: string;
  kind: string;
  file?: string;
  symbol?: { name?: string };
  matchedSignals?: string[];
  excerpt?: string;
  metadata?: {
    ranking?: { reasons?: unknown[] };
    relationship?: {
      kind?: string;
      traversalDirection?: string;
      evidenceSources?: string[];
    };
    pathEdges?: Array<{ kind?: string; evidenceSources?: string[] }>;
  };
}

interface ToolCallResultLike {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

describe("CLI and MCP agent-surface parity", () => {
  it("returns equivalent JSON results and evidence across CLI commands and MCP tools", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-cli-mcp-parity-"));
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
    const client = new Client({ name: "code-intel-cli-mcp-parity-test", version: "0.1.0" });

    try {
      await client.connect(transport);

      const semanticCli = await cliJson([
        "semantic",
        "giving receipt summary",
        "--filter-package",
        "@fixture/core",
        "--limit",
        "5",
      ], indexPath);
      const semanticMcp = (await mcpPayload(client, "semantic_search", {
        query: "giving receipt summary",
        packageName: "@fixture/core",
        limit: 5,
      })).result as QueryResultLike;
      expect(normalizeResults(semanticMcp).slice(0, 3)).toEqual(normalizeResults(semanticCli).slice(0, 3));
      expect(semanticCli.results.some((item) => item.metadata?.ranking?.reasons?.length)).toBe(true);

      const relationshipsCli = await cliJson([
        "relationships",
        "calculateGivingTotal",
        "--direction",
        "incoming",
        "--edge-kind",
        "CALLS",
        "REFERENCES",
        "--limit",
        "10",
      ], indexPath);
      const relationshipsMcp = (await mcpPayload(client, "get_relationships", {
        seed: "calculateGivingTotal",
        direction: "incoming",
        allowedEdgeKinds: ["CALLS", "REFERENCES"],
        limit: 10,
      })).result as QueryResultLike;
      expect(normalizeResults(relationshipsCli)).toEqual(normalizeResults(relationshipsMcp));
      expect(relationshipsCli.results.map((item) => item.file)).toEqual(
        expect.arrayContaining(["packages/core/src/ledger.ts", "packages/core/src/tithe.test.ts"]),
      );
      expect(relationshipsCli.results.every((item) => item.excerpt === undefined)).toBe(true);
      expect(relationshipsCli.results.some((item) => item.metadata?.relationship?.evidenceSources?.length)).toBe(true);

      const target = await cliJson(["find-symbol", "calculateGivingTotal", "--limit", "1"], indexPath);
      const source = await cliJson(["find-symbol", "summarize", "--limit", "1"], indexPath);
      const traceCli = await cliJson([
        "trace-path",
        source.results[0].id,
        target.results[0].id,
        "--direction",
        "outgoing",
        "--edge-kind",
        "CALLS",
        "REFERENCES",
        "--depth",
        "4",
        "--limit",
        "10",
      ], indexPath);
      const traceMcp = (await mcpPayload(client, "trace_path", {
        fromId: source.results[0].id,
        toId: target.results[0].id,
        direction: "outgoing",
        allowedEdgeKinds: ["CALLS", "REFERENCES"],
        maxDepth: 4,
        limit: 10,
      })).result as QueryResultLike;
      expect(traceCli.results.map((item) => item.id)).toEqual(traceMcp.results.map((item) => item.id));
      expect(traceCli.results.some((item) => item.metadata?.pathEdges?.length)).toBe(true);

      const contextCli = await cliJson(["get-context", semanticCli.results[0].id, "--limit", "1"], indexPath);
      const contextMcp = (await mcpPayload(client, "get_context", {
        nodeId: semanticCli.results[0].id,
        limit: 1,
      })).result as QueryResultLike;
      expect(normalizeResults(contextCli)).toEqual(normalizeResults(contextMcp));
      expect(Buffer.byteLength(contextCli.results[0].excerpt ?? "", "utf8")).toBeLessThanOrEqual(16_000);

      const fileDiagnosticCli = await cliJson(["diagnose", "file", "packages/core/src/tithe.ts"], indexPath);
      const fileDiagnosticMcp = (await mcpPayload(client, "diagnose_file", {
        path: "packages/core/src/tithe.ts",
      })).result as { matched?: boolean; file?: { relativePath?: string } };
      expect(fileDiagnosticCli.matched).toBe(fileDiagnosticMcp.matched);
      expect(fileDiagnosticCli.file.relativePath).toBe(fileDiagnosticMcp.file?.relativePath);

      const symbolDiagnosticCli = await cliJson(["diagnose", "symbol", "calculateGivingTotal"], indexPath);
      const symbolDiagnosticMcp = (await mcpPayload(client, "diagnose_symbol", {
        name: "calculateGivingTotal",
      })).result as { matched?: boolean; symbols?: Array<{ name?: string; file?: string }> };
      expect(symbolDiagnosticCli.matched).toBe(symbolDiagnosticMcp.matched);
      expect(symbolDiagnosticCli.symbols.map((item: { name?: string; file?: string }) => [item.name, item.file])).toEqual(
        symbolDiagnosticMcp.symbols?.map((item) => [item.name, item.file]),
      );
    } finally {
      await client.close();
      await rm(indexPath, { recursive: true, force: true });
    }
  }, 60_000);
});

async function cliJson(args: string[], indexPath: string): Promise<QueryResultLike & Record<string, unknown>> {
  const result = await execa("node", [
    cliPath,
    ...args,
    "--workspace",
    fixturePath,
    "--index-path",
    indexPath,
    "--json",
  ]);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

function parseMcpPayload(result: ToolCallResultLike): { result: unknown } {
  expect(result.structuredContent).toBeDefined();
  const text = result.content?.find((item) => item.type === "text")?.text;
  expect(text).toBeDefined();
  expect(result.structuredContent).toEqual(JSON.parse(text ?? "{}"));
  return result.structuredContent as { result: unknown };
}

async function mcpPayload(client: Client, name: string, args: Record<string, unknown>): Promise<{ result: unknown }> {
  const payload = parseMcpPayload(await client.callTool({ name, arguments: args }) as ToolCallResultLike);
  await client.callTool({ name: "health", arguments: {} });
  return payload;
}

function normalizeResults(result: QueryResultLike) {
  return result.results.map((item) => ({
    id: item.id,
    kind: item.kind,
    file: item.file,
    symbol: item.symbol?.name,
    matchedSignals: item.matchedSignals ?? [],
    excerpt: item.excerpt,
    rankingReasonCount: item.metadata?.ranking?.reasons?.length ?? 0,
    relationship: item.metadata?.relationship
      ? {
          kind: item.metadata.relationship.kind,
          traversalDirection: item.metadata.relationship.traversalDirection,
          evidenceSources: item.metadata.relationship.evidenceSources ?? [],
        }
      : undefined,
    pathEdges: item.metadata?.pathEdges?.map((edge) => ({
      kind: edge.kind,
      evidenceSources: edge.evidenceSources ?? [],
    })),
  }));
}
