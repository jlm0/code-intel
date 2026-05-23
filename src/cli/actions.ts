import { createRuntimeContext } from "../core/context.js";
import { runBenchmarkSuite } from "../benchmark/benchmark.js";
import { runHealth } from "../core/health.js";
import {
  createIndexProgressFileReporter,
  getIndexProgress,
  type IndexProgressReporter,
  type IndexProgressUpdate,
} from "../core/progress.js";
import { getStatus } from "../core/status.js";
import { diagnoseIndexedFile, diagnoseIndexedSymbol } from "../diagnostics/index-diagnostics.js";
import { runEvalSuite } from "../eval/evaluator.js";
import { indexWorkspace, updateWorkspace } from "../indexer/indexer.js";
import { startMcpServer } from "../mcp/server.js";
import { createQueryEngine, type QueryEngine } from "../query/query-engine.js";
import { searchText } from "../search/exact.js";
import type { CliActions, CliOptions, CliRuntime } from "./types.js";

export function createDefaultActions(): CliActions {
  return {
    index: async (options, runtime) => {
      const context = createRuntimeContext(options);
      return indexWorkspace({
        workspaceRoot: context.workspace,
        repoPaths: context.repos,
        indexPath: context.indexPath,
        indexProfile: context.indexProfile,
        embeddingProviderName: context.embeddingProvider,
        embeddingModel: context.embeddingModel,
        includeIgnored: context.includeIgnored,
        workspaceManifestPath: context.workspaceManifest,
        progress: createCliProgressReporter(context.indexPath, "index", options, runtime),
        handleProcessSignals: true,
      });
    },
    update: async (options, runtime) => {
      const context = createRuntimeContext(options);
      return updateWorkspace({
        workspaceRoot: context.workspace,
        repoPaths: context.repos,
        indexPath: context.indexPath,
        indexProfile: context.indexProfile,
        embeddingProviderName: context.embeddingProvider,
        embeddingModel: context.embeddingModel,
        includeIgnored: context.includeIgnored,
        workspaceManifestPath: context.workspaceManifest,
        progress: createCliProgressReporter(context.indexPath, "update", options, runtime),
        handleProcessSignals: true,
      });
    },
    progress: async (options) => getIndexProgress(options, {
      includeEvents: options.events === true,
      limit: options.limit ?? 20,
    }),
    status: getStatus,
    health: runHealth,
    search: async (options, _runtime, pattern) => {
      const context = createRuntimeContext(options);
      return searchText({
        pattern,
        repoPaths: context.repos.length > 0 ? context.repos : [context.workspace],
        limit: options.limit ?? 20,
        includeIgnored: context.includeIgnored,
      });
    },
    semantic: async (options, _runtime, query) => {
      const context = createRuntimeContext(options);
      return withQueryEngine(context, (engine) =>
        engine.semanticSearch(query, {
          limit: options.limit ?? 10,
          repo: options.filterRepo,
          packageName: options.filterPackage,
          fileKind: options.fileKind,
          symbolKind: options.symbolKind,
        }),
      );
    },
    findSymbol: async (options, _runtime, name) => {
      const context = createRuntimeContext(options);
      return withQueryEngine(context, (engine) =>
        engine.findSymbol(name, {
          limit: options.limit ?? 20,
        }),
      );
    },
    references: async (options, _runtime, symbol) => {
      const context = createRuntimeContext(options);
      return withQueryEngine(context, (engine) =>
        engine.getReferences(symbol, {
          limit: options.limit ?? 20,
        }),
      );
    },
    relationships: async (options, _runtime, seed) => {
      const context = createRuntimeContext(options);
      return withQueryEngine(context, (engine) =>
        engine.getRelationships(seed, {
          limit: options.limit ?? 20,
          allowedEdgeKinds: options.edgeKind,
          direction: options.direction,
        }),
      );
    },
    callers: async (options, _runtime, symbol) => {
      const context = createRuntimeContext(options);
      return withQueryEngine(context, (engine) =>
        engine.getCallers(symbol, {
          limit: options.limit ?? 20,
        }),
      );
    },
    callees: async (options, _runtime, symbol) => {
      const context = createRuntimeContext(options);
      return withQueryEngine(context, (engine) =>
        engine.getCallees(symbol, {
          limit: options.limit ?? 20,
        }),
      );
    },
    expandContext: async (options, _runtime, nodeId) => {
      const context = createRuntimeContext(options);
      return withQueryEngine(context, (engine) =>
        engine.expandContext(nodeId, {
          limit: options.limit ?? 20,
          depth: options.depth ?? 1,
        }),
      );
    },
    getContext: async (options, _runtime, nodeId) => {
      const context = createRuntimeContext(options);
      return withQueryEngine(context, (engine) =>
        engine.getContext(nodeId, {
          limit: options.limit ?? 5,
        }),
      );
    },
    tracePath: async (options, _runtime, fromId, toId) => {
      const context = createRuntimeContext(options);
      return withQueryEngine(context, (engine) =>
        engine.tracePath(fromId, toId, {
          limit: options.limit ?? 20,
          maxDepth: options.depth,
          allowedEdgeKinds: options.edgeKind,
          direction: options.direction,
        }),
      );
    },
    diagnoseFile: async (options, _runtime, filePath) => {
      const context = createRuntimeContext(options);
      return diagnoseIndexedFile(context.indexPath, filePath);
    },
    diagnoseSymbol: async (options, _runtime, symbolName) => {
      const context = createRuntimeContext(options);
      return withQueryEngine(context, async (engine) =>
        diagnoseIndexedSymbol({
          indexPath: context.indexPath,
          symbolQuery: symbolName,
          nodes: await engine.getRepository().getNodes(),
        }),
      );
    },
    benchmark: async (options) =>
      runBenchmarkSuite({
        workspace: options.workspace,
        suite: options.suite,
        evalPack: options.evalPack,
        evalCachePath: options.evalCachePath,
        fetch: options.fetch,
        embeddingProvider: options.embeddingProvider,
        embeddingModel: options.embeddingModel,
        includeMcpLatency: options.includeMcpLatency,
      }),
    eval: runEvalSuite,
    mcp: startMcpServer,
  };
}

function createCliProgressReporter(
  indexPath: string,
  operation: "index" | "update",
  options: CliOptions,
  runtime: CliRuntime,
): IndexProgressReporter {
  const fileReporter = createIndexProgressFileReporter({ indexPath, operation });
  return {
    report: async (update) => {
      await fileReporter.report(update);
      if (!options.quiet) {
        runtime.stderr.write(renderProgressLine(operation, update));
      }
    },
  };
}

function renderProgressLine(operation: "index" | "update", update: IndexProgressUpdate): string {
  const step = update.currentStep ? ` ${update.currentStep}` : "";
  return `${operation} ${update.status ?? "running"} ${update.phase}${step}: ${update.message}\n`;
}

async function withQueryEngine<T>(
  context: ReturnType<typeof createRuntimeContext>,
  callback: (engine: QueryEngine) => Promise<T>,
): Promise<T> {
  const engine = createQueryEngine({
    indexPath: context.indexPath,
    embeddingProviderName: context.embeddingProvider,
    embeddingModel: context.embeddingModel,
  });
  try {
    return await callback(engine);
  } finally {
    await engine.close();
  }
}
