import { Command } from "commander";

import { createDefaultActions } from "./actions.js";
import { renderResult } from "./presenter.js";
import type { CliAction, CliActions, CliOptions, CliRuntime } from "./types.js";

export interface CreateCliProgramOptions {
  actions?: Partial<CliActions>;
  stdout?: Pick<NodeJS.WriteStream, "write" | "isTTY">;
  stderr?: Pick<NodeJS.WriteStream, "write" | "isTTY">;
}

export function createCliProgram(options: CreateCliProgramOptions = {}): Command {
  const actions = { ...createDefaultActions(), ...options.actions };
  const runtime: CliRuntime = {
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
  };

  const program = new Command();
  program
    .name("code-intel")
    .description("Local-first JS/TS code intelligence graph CLI")
    .version("0.1.0")
    .showHelpAfterError();

  registerCommand(program, "index", "Index one or more JS/TS repositories.", actions.index, runtime);
  registerCommand(program, "update", "Refresh an existing index.", actions.update, runtime);
  registerCommand(program, "status", "Show index status.", actions.status, runtime);
  registerCommand(program, "health", "Run environment and index health checks.", actions.health, runtime);
  registerCommand(program, "search <pattern>", "Run exact text search.", actions.search, runtime);
  registerCommand(program, "semantic <query>", "Run semantic code search.", actions.semantic, runtime);
  registerCommand(program, "find-symbol <name>", "Find symbols by name.", actions.findSymbol, runtime);
  registerCommand(program, "references <symbol>", "Find references to a symbol.", actions.references, runtime);
  registerCommand(program, "callers <symbol>", "Find callers of a symbol.", actions.callers, runtime);
  registerCommand(program, "callees <symbol>", "Find callees of a symbol.", actions.callees, runtime);
  registerCommand(program, "expand-context <nodeId>", "Expand graph context around a node.", actions.expandContext, runtime);
  registerCommand(program, "get-context <nodeId>", "Return bounded source context for a node.", actions.getContext, runtime);
  registerCommand(program, "trace-path <fromId> <toId>", "Trace a graph path between two nodes.", actions.tracePath, runtime);
  registerCommand(program, "eval", "Run fixture and proof-of-concept evaluations.", actions.eval, runtime);
  registerCommand(program, "mcp", "Start the MCP stdio server.", actions.mcp, runtime, { suppressOutput: true });

  return program;
}

function registerCommand(
  program: Command,
  signature: string,
  description: string,
  action: CliAction,
  runtime: CliRuntime,
  config: { suppressOutput?: boolean } = {},
): void {
  const command = program.command(signature).description(description);
  addCommonOptions(command);
  command.action(async (...args: unknown[]) => {
    const positionalArgs = args.filter((arg): arg is string => typeof arg === "string");
    const options = normalizeOptions(command.opts());
    const result = await action(options, ...positionalArgs);
    if (!config.suppressOutput && result !== undefined && !options.quiet) {
      runtime.stdout.write(
        renderResult(result, {
          json: options.json,
          isTTY: Boolean(runtime.stdout.isTTY),
        }),
      );
    }
  });
}

function addCommonOptions(command: Command): void {
  command
    .option("--workspace <path>", "Workspace root path.")
    .option("--repo <path...>", "Repository path to index or query.")
    .option("--index-path <path>", "Index artifact path.")
    .option("--workspace-manifest <path>", "Optional code-intel workspace manifest with repository paths.")
    .option("--include-ignored", "Index or search normally ignored generated, build, log, and local-dev paths.", false)
    .option("--embedding-provider <provider>", "Embedding provider: hash or jina.")
    .option("--embedding-model <model>", "Embedding model identifier for provider-backed embeddings.")
    .option("--filter-repo <name>", "Restrict semantic search results to an indexed repo name.")
    .option("--filter-package <name>", "Restrict semantic search results to a package name.")
    .option("--file-kind <kind>", "Restrict semantic search results to source or test files.")
    .option("--symbol-kind <kind>", "Restrict semantic search results to a symbol kind.")
    .option("--json", "Render machine-readable JSON output.", false)
    .option("--quiet", "Suppress non-error output.", false)
    .option("--verbose", "Render diagnostic output.", false)
    .option("--limit <number>", "Limit result count. Maximum 50.", parseInteger)
    .option("--depth <number>", "Limit graph traversal depth. Maximum 4.", parseInteger);
}

function normalizeOptions(options: Record<string, unknown>): CliOptions {
  return {
    workspace: typeof options.workspace === "string" ? options.workspace : undefined,
    repo: Array.isArray(options.repo) ? options.repo.map(String) : undefined,
    indexPath: typeof options.indexPath === "string" ? options.indexPath : undefined,
    workspaceManifest: typeof options.workspaceManifest === "string" ? options.workspaceManifest : undefined,
    includeIgnored: options.includeIgnored === true,
    embeddingProvider: typeof options.embeddingProvider === "string" ? options.embeddingProvider : undefined,
    embeddingModel: typeof options.embeddingModel === "string" ? options.embeddingModel : undefined,
    filterRepo: typeof options.filterRepo === "string" ? options.filterRepo : undefined,
    filterPackage: typeof options.filterPackage === "string" ? options.filterPackage : undefined,
    fileKind: typeof options.fileKind === "string" ? options.fileKind : undefined,
    symbolKind: typeof options.symbolKind === "string" ? options.symbolKind : undefined,
    json: options.json === true,
    quiet: options.quiet === true,
    verbose: options.verbose === true,
    limit: boundedOption(options.limit, 50, "limit"),
    depth: boundedOption(options.depth, 4, "depth"),
  };
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }
  return parsed;
}

function boundedOption(value: unknown, max: number, name: string): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  if (value > max) {
    throw new Error(`Expected --${name} to be at most ${max}, received ${value}`);
  }
  return value;
}
