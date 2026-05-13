import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execa } from "execa";
import { beforeAll, describe, expect, it } from "vitest";

const cliPath = new URL("../../dist/cli/main.js", import.meta.url).pathname;
const fixturePath = new URL("../fixtures/js-ts-workspace", import.meta.url).pathname;

describe("MCP stdio server", () => {
  beforeAll(async () => {
    await execa("npm", ["run", "build"]);
  });

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
      ],
      cwd: new URL("../..", import.meta.url).pathname,
      stderr: "pipe",
    });
    const client = new Client({ name: "code-intel-test", version: "0.1.0" });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["health", "find_symbol", "semantic_search", "get_context"]),
      );

      const health = await client.callTool({ name: "health", arguments: {} });
      expect(parseToolText(health).tool).toBe("health");

      const symbol = await client.callTool({
        name: "find_symbol",
        arguments: { name: "calculateGivingTotal", limit: 5 },
      });
      expect(parseToolText(symbol).result.results[0].file).toBe(
        "packages/core/src/tithe.ts",
      );
    } finally {
      await client.close();
      await rm(indexPath, { recursive: true, force: true });
    }
  });
});

function parseToolText(result: { content: Array<{ type: string; text?: string }> }) {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("Tool did not return text content");
  }
  return JSON.parse(text);
}
