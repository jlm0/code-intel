import type { CliActions } from "../cli/program.js";
import { indexWorkspace } from "../indexer/indexer.js";
import { createQueryEngine } from "../query/query-engine.js";
import { searchText } from "../search/exact.js";
import { createRuntimeContext } from "./context.js";
import { runHealth } from "./health.js";
import { getStatus } from "./status.js";

const notImplemented = async () => ({
  status: "not_implemented",
});

export function createDefaultActions(): CliActions {
  return {
    index: async (options) => {
      const context = createRuntimeContext(options);
      return indexWorkspace({
        workspaceRoot: context.workspace,
        repoPaths: context.repos.length > 0 ? context.repos : [context.workspace],
        indexPath: context.indexPath,
      });
    },
    update: async (options) => {
      const context = createRuntimeContext(options);
      return indexWorkspace({
        workspaceRoot: context.workspace,
        repoPaths: context.repos.length > 0 ? context.repos : [context.workspace],
        indexPath: context.indexPath,
      });
    },
    status: getStatus,
    health: runHealth,
    search: async (options, pattern) => {
      const context = createRuntimeContext(options);
      return searchText({
        pattern,
        repoPaths: context.repos.length > 0 ? context.repos : [context.workspace],
        limit: options.limit ?? 20,
      });
    },
    semantic: async (options, query) => {
      const context = createRuntimeContext(options);
      return createQueryEngine({ indexPath: context.indexPath }).semanticSearch(query, {
        limit: options.limit ?? 10,
      });
    },
    findSymbol: async (options, name) => {
      const context = createRuntimeContext(options);
      return createQueryEngine({ indexPath: context.indexPath }).findSymbol(name, {
        limit: options.limit ?? 20,
      });
    },
    references: async (options, symbol) => {
      const context = createRuntimeContext(options);
      return createQueryEngine({ indexPath: context.indexPath }).getReferences(symbol, {
        limit: options.limit ?? 20,
      });
    },
    callers: async (options, symbol) => {
      const context = createRuntimeContext(options);
      return createQueryEngine({ indexPath: context.indexPath }).getCallers(symbol, {
        limit: options.limit ?? 20,
      });
    },
    callees: async (options, symbol) => {
      const context = createRuntimeContext(options);
      return createQueryEngine({ indexPath: context.indexPath }).getCallees(symbol, {
        limit: options.limit ?? 20,
      });
    },
    expandContext: async (options, nodeId) => {
      const context = createRuntimeContext(options);
      return createQueryEngine({ indexPath: context.indexPath }).expandContext(nodeId, {
        limit: options.limit ?? 20,
        depth: options.depth ?? 1,
      });
    },
    getContext: async (options, nodeId) => {
      const context = createRuntimeContext(options);
      return createQueryEngine({ indexPath: context.indexPath }).getContext(nodeId, {
        limit: options.limit ?? 5,
      });
    },
    tracePath: async (options, fromId, toId) => {
      const context = createRuntimeContext(options);
      return createQueryEngine({ indexPath: context.indexPath }).tracePath(fromId, toId, {
        limit: options.limit ?? 20,
      });
    },
    eval: notImplemented,
    mcp: notImplemented,
  };
}
