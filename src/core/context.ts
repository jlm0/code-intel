import { resolve } from "node:path";

import type { CliOptions } from "../cli/program.js";

export interface RuntimeContext {
  workspace: string;
  repos: string[];
  indexPath: string;
}

export function createRuntimeContext(options: CliOptions): RuntimeContext {
  const workspace = resolve(options.workspace ?? process.cwd());
  const repos = options.repo?.map((repo) => resolve(workspace, repo)) ?? [];
  const indexPath = resolve(workspace, options.indexPath ?? ".code-intel");

  return { workspace, repos, indexPath };
}
