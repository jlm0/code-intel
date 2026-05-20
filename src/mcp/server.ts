import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createRuntimeContext, type RuntimeOptions } from "../core/context.js";
import { runHealth } from "../core/health.js";
import { getIndexProgress } from "../core/progress.js";
import { getStatus } from "../core/status.js";
import { diagnoseIndexedFile, diagnoseIndexedSymbol } from "../diagnostics/index-diagnostics.js";
import { DiagnoseFileResultSchema, DiagnoseSymbolResultSchema } from "../diagnostics/schemas.js";
import { createQueryEngine, type QueryEngine } from "../query/query-engine.js";
import { searchText } from "../search/exact.js";
import {
  EdgeKindSchema,
  HealthResultSchema,
  IndexProgressResultSchema,
  McpToolPayloadSchema,
  QueryResultSchema,
  mcpToolOutputSchema,
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
      outputSchema: mcpToolOutputSchema(StatusResultSchema),
    },
    async () => toolPayload("workspace_overview", await getStatus(options), StatusResultSchema),
  );

  server.registerTool(
    "health",
    {
      description: "Run environment, embedding, Ladybug, manifest, and MCP health checks. Use before trusting results or after an index/update failure.",
      inputSchema: {},
      outputSchema: mcpToolOutputSchema(HealthResultSchema),
    },
    async () => {
      await closeQueryEngine();
      return toolPayload("health", await runHealth(options), HealthResultSchema);
    },
  );

  server.registerTool(
    "index_progress",
    {
      description: "Inspect the current or latest code-intel index/update progress without opening the graph database.",
      inputSchema: {},
      outputSchema: mcpToolOutputSchema(IndexProgressResultSchema),
    },
    async () => toolPayload("index_progress", await getIndexProgress(options), IndexProgressResultSchema),
  );

  server.registerTool(
    "search_text",
    {
      description: "Run bounded literal text search through ripgrep. Use when you know an exact string, identifier, route segment, env var, or error text.",
      inputSchema: {
        pattern: z.string().min(1).describe("Exact literal text, identifier, route segment, env var, or error text to search for."),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum result count. Defaults to 20 and is capped at 50."),
      },
      outputSchema: mcpToolOutputSchema(QueryResultSchema),
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
        query: z.string().min(1).describe("Natural-language code concept or task-oriented search query."),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum result count. Defaults to 10 and is capped at 50."),
        repo: z.string().min(1).optional().describe("Optional indexed repository name filter."),
        packageName: z.string().min(1).optional().describe("Optional package name filter."),
        fileKind: z.string().min(1).optional().describe("Optional file kind filter, usually source or test."),
        symbolKind: z.string().min(1).optional().describe("Optional symbol kind filter such as Function, Class, TypeAlias, or Chunk."),
      },
      outputSchema: mcpToolOutputSchema(QueryResultSchema),
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
        name: z.string().min(1).describe("Symbol stable ID, local name, or qualified name."),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum result count. Defaults to 20 and is capped at 50."),
      },
      outputSchema: mcpToolOutputSchema(QueryResultSchema),
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
        idOrName: z.string().min(1).describe("Symbol stable ID, local name, or qualified name."),
      },
      outputSchema: mcpToolOutputSchema(QueryResultSchema),
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
        symbol: z.string().min(1).describe("Symbol stable ID, local name, or qualified name."),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum result count. Defaults to 20 and is capped at 50."),
      },
      outputSchema: mcpToolOutputSchema(QueryResultSchema),
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
        symbol: z.string().min(1).describe("Symbol stable ID, local name, or qualified name."),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum result count. Defaults to 20 and is capped at 50."),
      },
      outputSchema: mcpToolOutputSchema(QueryResultSchema),
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
        symbol: z.string().min(1).describe("Symbol stable ID, local name, or qualified name."),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum result count. Defaults to 20 and is capped at 50."),
      },
      outputSchema: mcpToolOutputSchema(QueryResultSchema),
    },
    async ({ symbol, limit }) =>
      toolPayload("get_callees", await withQueryEngine((queryEngine) =>
        queryEngine.getCallees(symbol, { limit: limit ?? 20 }),
      ), QueryResultSchema),
  );

  server.registerTool(
    "get_relationships",
    {
      description: "Browse typed graph relationships around a seed ID, symbol, or qualified name with direction, edge-kind, confidence, and evidence filters. Use when references/callers/callees are too narrow.",
      inputSchema: {
        seed: z.string().min(1).describe("Node stable ID, symbol name, or qualified name used as the relationship seed."),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum result count. Defaults to 20 and is capped at 50."),
        allowedEdgeKinds: z.array(EdgeKindSchema).min(1).optional().describe("Optional edge-kind allowlist such as CALLS, REFERENCES, TESTS, EXTENDS, or IMPLEMENTS."),
        direction: z.enum(["outgoing", "incoming", "either"]).optional().describe("Traversal direction from the seed. Defaults to either."),
      },
      outputSchema: mcpToolOutputSchema(QueryResultSchema),
    },
    async ({ seed, limit, allowedEdgeKinds, direction }) =>
      toolPayload("get_relationships", await withQueryEngine((queryEngine) =>
        queryEngine.getRelationships(seed, {
          limit: limit ?? 20,
          allowedEdgeKinds,
          direction,
        }),
      ), QueryResultSchema),
  );

  server.registerTool(
    "expand_context",
    {
      description: "Walk bounded graph relationships around a node ID. Use after semantic_search or find_symbol to gather imports, exports, callers, callees, tests, and neighbors.",
      inputSchema: {
        nodeId: z.string().min(1).describe("Stable node ID returned from search or graph tools."),
        depth: z.number().int().min(1).max(4).optional().describe("Relationship traversal depth. Defaults to 1 and is capped at 4."),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum result count. Defaults to 20 and is capped at 50."),
      },
      outputSchema: mcpToolOutputSchema(QueryResultSchema),
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
        nodeId: z.string().min(1).describe("Stable node ID returned from search or graph tools."),
        limit: z.number().int().min(1).max(20).optional().describe("Maximum source excerpt count. Defaults to 5 and is capped at 20."),
      },
      outputSchema: mcpToolOutputSchema(QueryResultSchema),
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
        fromId: z.string().min(1).describe("Stable source node ID."),
        toId: z.string().min(1).describe("Stable target node ID."),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum nodes returned from the path. Defaults to 20 and is capped at 50."),
        maxDepth: z.number().int().min(1).max(8).optional().describe("Maximum graph traversal depth. Defaults to limit and is capped at 8."),
        allowedEdgeKinds: z.array(EdgeKindSchema).min(1).optional().describe("Optional edge-kind allowlist for path traversal."),
        direction: z.enum(["outgoing", "incoming", "either"]).optional().describe("Traversal direction. Defaults to either."),
      },
      outputSchema: mcpToolOutputSchema(QueryResultSchema),
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

  server.registerTool(
    "diagnose_file",
    {
      description: "Explain whether a file was discovered, indexed, parsed, graphed, embedded, and queryable. Use when expected code is missing or stale.",
      inputSchema: {
        path: z.string().min(1).describe("Workspace-relative, repo-relative, or absolute file path to diagnose."),
      },
      outputSchema: mcpToolOutputSchema(DiagnoseFileResultSchema),
    },
    async ({ path }) =>
      toolPayload("diagnose_file", await diagnoseIndexedFile(context.indexPath, path), DiagnoseFileResultSchema),
  );

  server.registerTool(
    "diagnose_symbol",
    {
      description: "Explain whether a symbol is indexed and which file lifecycle makes it queryable. Use after find_symbol misses or stale symbol results.",
      inputSchema: {
        name: z.string().min(1).describe("Symbol local name or qualified name to diagnose."),
      },
      outputSchema: mcpToolOutputSchema(DiagnoseSymbolResultSchema),
    },
    async ({ name }) =>
      toolPayload("diagnose_symbol", await withQueryEngine(async (queryEngine) =>
        diagnoseIndexedSymbol({
          indexPath: context.indexPath,
          symbolQuery: name,
          nodes: await queryEngine.getRepository().getNodes(),
        }),
      ), DiagnoseSymbolResultSchema),
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
    structuredContent: payload,
  };
}
