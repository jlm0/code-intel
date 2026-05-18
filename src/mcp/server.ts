import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createRuntimeContext, type RuntimeOptions } from "../core/context.js";
import { runHealth } from "../core/health.js";
import { getStatus } from "../core/status.js";
import { createQueryEngine, type QueryEngine } from "../query/query-engine.js";
import { searchText } from "../search/exact.js";
import {
  EdgeKindSchema,
  HealthResultSchema,
  McpToolPayloadSchema,
  QueryResultSchema,
  schemaVersion,
  StatusResultSchema,
} from "../schema/schemas.js";
import { guidanceForTool } from "./guidance.js";

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
      description: "Inspect whether a code-intel index exists, which generation is active, and which repositories are indexed before choosing search or graph tools.",
      inputSchema: {},
    },
    async () => toolPayload("workspace_overview", await getStatus(options), StatusResultSchema),
  );

  server.registerTool(
    "health",
    {
      description: "Run environment, embedding, Ladybug, manifest, and MCP health checks. Use before trusting results or after an index/update failure.",
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
      description: "Run bounded literal text search through ripgrep. Use when you know an exact string, identifier, route segment, env var, or error text.",
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
      description: "Run hybrid semantic code search over vectors, lexical signals, symbols, graph paths, tests, and app-flow ranking. Use when you know the concept but not the exact symbol.",
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
      description: "Find indexed symbols by exact stable ID, name, or qualified name. Use this before references/callers/callees when you know a symbol.",
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
      description: "Return the single best matching symbol for a stable ID, name, or qualified name when an agent needs one seed node.",
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
      description: "Return incoming REFERENCES edges for a symbol with evidence metadata. Use to find implementation use sites, imports, tests, and type uses.",
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
      description: "Return incoming CALLS edges for a symbol with evidence metadata. Use for impact analysis and caller discovery.",
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
      description: "Return outgoing CALLS edges from a symbol with evidence metadata. Use to understand what an implementation invokes.",
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
      description: "Walk bounded graph relationships around a node ID. Use after semantic_search or find_symbol to gather imports, exports, callers, callees, tests, and neighbors.",
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
      description: "Return bounded source excerpts for a node ID. Use only after selecting specific nodes from search or graph tools.",
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
      description: "Trace typed graph paths between two node IDs with edge kinds, direction, confidence, evidence, and fallback reasons. Use for app-flow proof.",
      inputSchema: {
        fromId: z.string().min(1),
        toId: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
        maxDepth: z.number().int().min(1).max(8).optional(),
        allowedEdgeKinds: z.array(EdgeKindSchema).min(1).optional(),
        direction: z.enum(["outgoing", "incoming", "either"]).optional(),
      },
    },
    async ({ fromId, toId, limit, maxDepth, allowedEdgeKinds, direction }) =>
      toolPayload("trace_path", await withQueryEngine((queryEngine) =>
        queryEngine.tracePath(fromId, toId, {
          limit: limit ?? 20,
          maxDepth,
          allowedEdgeKinds,
          direction,
        }),
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
      scheduleQueryEngineClose();
    }
  }

  function scheduleQueryEngineClose(): void {
    if (queryEngineCloseTimer) {
      clearTimeout(queryEngineCloseTimer);
    }
    queryEngineCloseTimer = setTimeout(() => {
      void closeQueryEngine();
    }, 1_000);
    queryEngineCloseTimer.unref?.();
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
    guidance: guidanceForTool(tool),
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
