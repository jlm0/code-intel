import { resolve } from "node:path";

export interface RuntimeOptions {
  workspace?: string;
  repo?: string[];
  indexPath?: string;
  embeddingProvider?: string;
  embeddingModel?: string;
  includeIgnored?: boolean;
  workspaceManifest?: string;
}

export interface RuntimeContext {
  workspace: string;
  repos: string[];
  indexPath: string;
  embeddingProvider?: string;
  embeddingModel?: string;
  includeIgnored: boolean;
  workspaceManifest?: string;
}

export function createRuntimeContext(options: RuntimeOptions): RuntimeContext {
  const workspace = resolve(options.workspace ?? process.cwd());
  const repos = options.repo?.map((repo) => resolve(workspace, repo)) ?? [];
  const indexPath = resolve(workspace, options.indexPath ?? ".code-intel");

  return {
    workspace,
    repos,
    indexPath,
    embeddingProvider: options.embeddingProvider,
    embeddingModel: options.embeddingModel,
    includeIgnored: options.includeIgnored === true,
    workspaceManifest: options.workspaceManifest,
  };
}
