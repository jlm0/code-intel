import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createRuntimeContext, type RuntimeOptions } from "../core/context.js";
import { runHealth } from "../core/health.js";
import { getStatus } from "../core/status.js";
import { createQueryEngine, type QueryEngine } from "../query/query-engine.js";
import { searchText } from "../search/exact.js";
import {
  HealthResultSchema,
  McpToolPayloadSchema,
  QueryResultSchema,
  schemaVersion,
  StatusResultSchema,
} from "../schema/schemas.js";

export async function startMcpServer(options: RuntimeOptions): Promise<void> {
  const context = createRuntimeContext(options);
  const repoPaths = context.repos.length > 0 ? context.repos : [context.workspace];
  let queryEngine: QueryEngine | undefined;
  let queryEngineCloseTimer: NodeJS.Timeout | undefined;
  const server = new McpServer({
    name: "code-intel",
    version: "0.1.0",
  });

  server.registerTool(
    "workspace_overview",
    {
      description: "Return current code intelligence index status and indexed repositories.",
      inputSchema: {},
    },
    async () => toolPayload("workspace_overview", await getStatus(options), StatusResultSchema),
  );

  server.registerTool(
    "health",
    {
      description: "Run code intelligence environment and index health checks.",
      inputSchema: {},
    },
    async () => {
      await closeQueryEngine();
      return toolPayload("health", await runHealth(options), HealthResultSchema);
    },
  );

  server.registerTool(
    "search_text",
    {
      description: "Run bounded exact text search through ripgrep and return file pointers.",
      inputSchema: {
        pattern: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ pattern, limit }) =>
      toolPayload(
        "search_text",
        await searchText({ pattern, repoPaths, limit: limit ?? 20, includeIgnored: context.includeIgnored }),
        QueryResultSchema,
      ),
  );

  server.registerTool(
    "semantic_search",
    {
      description: "Run semantic code search and return ranked chunk pointers.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
        repo: z.string().min(1).optional(),
        packageName: z.string().min(1).optional(),
        fileKind: z.string().min(1).optional(),
        symbolKind: z.string().min(1).optional(),
      },
    },
    async ({ query, limit, repo, packageName, fileKind, symbolKind }) =>
      toolPayload("semantic_search", await withQueryEngine((queryEngine) =>
        queryEngine.semanticSearch(query, {
          limit: limit ?? 10,
          repo,
          packageName,
          fileKind,
          symbolKind,
        }),
      ), QueryResultSchema),
  );

  server.registerTool(
    "find_symbol",
    {
      description: "Find indexed symbols by name or stable ID.",
      inputSchema: {
        name: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ name, limit }) =>
      toolPayload("find_symbol", await withQueryEngine((queryEngine) =>
        queryEngine.findSymbol(name, { limit: limit ?? 20 }),
      ), QueryResultSchema),
  );

  server.registerTool(
    "get_symbol",
    {
      description: "Return the best matching symbol for a stable ID or symbol name.",
      inputSchema: {
        idOrName: z.string().min(1),
      },
    },
    async ({ idOrName }) =>
      toolPayload("get_symbol", await withQueryEngine((queryEngine) =>
        queryEngine.findSymbol(idOrName, { limit: 1 }),
      ), QueryResultSchema),
  );

  server.registerTool(
    "get_references",
    {
      description: "Return graph references to a symbol.",
      inputSchema: {
        symbol: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ symbol, limit }) =>
      toolPayload("get_references", await withQueryEngine((queryEngine) =>
        queryEngine.getReferences(symbol, { limit: limit ?? 20 }),
      ), QueryResultSchema),
  );

  server.registerTool(
    "get_callers",
    {
      description: "Return graph callers of a symbol.",
      inputSchema: {
        symbol: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ symbol, limit }) =>
      toolPayload("get_callers", await withQueryEngine((queryEngine) =>
        queryEngine.getCallers(symbol, { limit: limit ?? 20 }),
      ), QueryResultSchema),
  );

  server.registerTool(
    "get_callees",
    {
      description: "Return graph callees from a symbol.",
      inputSchema: {
        symbol: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ symbol, limit }) =>
      toolPayload("get_callees", await withQueryEngine((queryEngine) =>
        queryEngine.getCallees(symbol, { limit: limit ?? 20 }),
      ), QueryResultSchema),
  );

  server.registerTool(
    "expand_context",
    {
      description: "Walk bounded graph relationships around a node ID.",
      inputSchema: {
        nodeId: z.string().min(1),
        depth: z.number().int().min(1).max(4).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ nodeId, depth, limit }) =>
      toolPayload("expand_context", await withQueryEngine((queryEngine) =>
        queryEngine.expandContext(nodeId, {
          depth: depth ?? 1,
          limit: limit ?? 20,
        }),
      ), QueryResultSchema),
  );

  server.registerTool(
    "get_context",
    {
      description: "Return bounded source context for a node ID.",
      inputSchema: {
        nodeId: z.string().min(1),
        limit: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ nodeId, limit }) =>
      toolPayload("get_context", await withQueryEngine((queryEngine) =>
        queryEngine.getContext(nodeId, { limit: limit ?? 5 }),
      ), QueryResultSchema),
  );

  server.registerTool(
    "trace_path",
    {
      description: "Trace a graph path between two node IDs when one exists.",
      inputSchema: {
        fromId: z.string().min(1),
        toId: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ fromId, toId, limit }) =>
      toolPayload("trace_path", await withQueryEngine((queryEngine) =>
        queryEngine.tracePath(fromId, toId, { limit: limit ?? 20 }),
      ), QueryResultSchema),
  );

  await server.connect(new StdioServerTransport());

  async function withQueryEngine<T>(callback: (engine: QueryEngine) => Promise<T>): Promise<T> {
    if (queryEngineCloseTimer) {
      clearTimeout(queryEngineCloseTimer);
      queryEngineCloseTimer = undefined;
    }
    queryEngine ??= createQueryEngine({
        indexPath: context.indexPath,
        embeddingProviderName: context.embeddingProvider,
        embeddingModel: context.embeddingModel,
      });
    try {
      return await callback(queryEngine);
    } finally {
      await closeQueryEngine();
    }
  }

  async function closeQueryEngine(): Promise<void> {
    if (queryEngineCloseTimer) {
      clearTimeout(queryEngineCloseTimer);
      queryEngineCloseTimer = undefined;
    }
    if (queryEngine) {
      const engine = queryEngine;
      queryEngine = undefined;
      await engine.close();
    }
  }
}

function toolPayload<T>(tool: string, result: T, resultSchema: z.ZodType<T>) {
  const parsedResult = resultSchema.parse(result);
  const payload = McpToolPayloadSchema.parse({
    schemaVersion,
    tool,
    result: parsedResult,
  });
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload),
      },
    ],
  };
}
