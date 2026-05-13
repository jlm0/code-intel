import { Command } from "commander";

import { createDefaultActions } from "../core/actions.js";
import { renderResult } from "./presenter.js";

export interface CliRuntime {
  stdout: Pick<NodeJS.WriteStream, "write" | "isTTY">;
  stderr: Pick<NodeJS.WriteStream, "write" | "isTTY">;
}

export interface CliOptions {
  workspace?: string;
  repo?: string[];
  indexPath?: string;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  limit?: number;
  depth?: number;
}

export type CliAction = (options: CliOptions, ...args: string[]) => Promise<unknown>;

export interface CliActions {
  index: CliAction;
  update: CliAction;
  status: CliAction;
  health: CliAction;
  search: CliAction;
  semantic: CliAction;
  findSymbol: CliAction;
  references: CliAction;
  callers: CliAction;
  callees: CliAction;
  expandContext: CliAction;
  getContext: CliAction;
  tracePath: CliAction;
  eval: CliAction;
  mcp: CliAction;
}

export interface CreateCliProgramOptions {
  actions?: Partial<CliActions>;
  stdout?: Pick<NodeJS.WriteStream, "write" | "isTTY">;
  stderr?: Pick<NodeJS.WriteStream, "write" | "isTTY">;
}

const notImplemented: CliAction = async () => ({
  status: "not_implemented",
});

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
    .option("--json", "Render machine-readable JSON output.", false)
    .option("--quiet", "Suppress non-error output.", false)
    .option("--verbose", "Render diagnostic output.", false)
    .option("--limit <number>", "Limit result count.", parseInteger)
    .option("--depth <number>", "Limit graph traversal depth.", parseInteger);
}

function normalizeOptions(options: Record<string, unknown>): CliOptions {
  return {
    workspace: typeof options.workspace === "string" ? options.workspace : undefined,
    repo: Array.isArray(options.repo) ? options.repo.map(String) : undefined,
    indexPath: typeof options.indexPath === "string" ? options.indexPath : undefined,
    json: options.json === true,
    quiet: options.quiet === true,
    verbose: options.verbose === true,
    limit: typeof options.limit === "number" ? options.limit : undefined,
    depth: typeof options.depth === "number" ? options.depth : undefined,
  };
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }
  return parsed;
}
