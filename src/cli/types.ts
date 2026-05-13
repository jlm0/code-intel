import type { RuntimeOptions } from "../core/context.js";

export interface CliRuntime {
  stdout: Pick<NodeJS.WriteStream, "write" | "isTTY">;
  stderr: Pick<NodeJS.WriteStream, "write" | "isTTY">;
}

export interface CliOptions extends RuntimeOptions {
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  limit?: number;
  depth?: number;
  filterRepo?: string;
  filterPackage?: string;
  fileKind?: string;
  symbolKind?: string;
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
