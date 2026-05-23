import { join, relative } from "node:path";

import type { ScipPolicy } from "../core/index-policy.js";
import { resolveIndexPolicy } from "../core/index-policy.js";
import { normalizeRelativePath } from "../core/ids.js";
import type { DiscoveredFile, DiscoveredRepo } from "../workspace/discovery.js";
import type { FileFact } from "./fact-cache.js";
import type { ScipFailureHistoryEntry } from "./scip-failure-history.js";

export interface ScipShardPlan {
  id: string;
  kind: "package" | "repo";
  projectPath: string;
  outputPath: string;
  includedFiles?: string[];
  fileCosts?: ScipShardFileCost[];
  cost?: number;
  reason: string;
  lineage: string[];
}

export interface ScipShardFileCost {
  absolutePath: string;
  cost: number;
}

export interface PlanScipShardsOptions {
  policy?: ScipPolicy;
  fileFactsByRelativePath?: Map<string, FileFact>;
  failureHistory?: ScipFailureHistoryEntry[];
}

const defaultPolicy = resolveIndexPolicy().scip;

export function planScipShardsForRepo(
  repo: DiscoveredRepo,
  indexPath: string,
  options: PlanScipShardsOptions = {},
): ScipShardPlan[] {
  const policy = options.policy ?? defaultPolicy;
  const packagesBySpecificity = [...repo.packages].sort((left, right) => right.path.length - left.path.length);
  const filesByPackagePath = new Map(repo.packages.map((pkg) => [pkg.path, [] as DiscoveredFile[]]));
  const outsidePackageFiles: DiscoveredFile[] = [];
  for (const file of repo.files) {
    const owningPackage = packagesBySpecificity.find((pkg) => pathStartsWith(file.absolutePath, pkg.path));
    if (owningPackage) {
      filesByPackagePath.get(owningPackage.path)?.push(file);
    } else {
      outsidePackageFiles.push(file);
    }
  }

  const shards: ScipShardPlan[] = repo.packages.flatMap((pkg) => {
    const id = `package-${pkg.relativePath === "." ? pkg.name : pkg.relativePath}`;
    const includedFiles = filesByPackagePath.get(pkg.path)?.sort(compareDiscoveredFiles) ?? [];
    return packageScipShardPlans({
      id,
      repo,
      indexPath,
      packagePath: pkg.path,
      sourceRoots: pkg.sourceRoots,
      includedFiles,
      options,
      policy,
    });
  });

  if (outsidePackageFiles.length > 0) {
    const groups = policy.splitRepoRoot
      ? groupOutsidePackageFiles(repo, outsidePackageFiles)
      : [{ id: "repo-root", files: outsidePackageFiles.sort(compareDiscoveredFiles), reason: "repo-root" }];
    for (const group of groups) {
      shards.push(
        ...splitCostedGroup({
          id: group.id,
          kind: "repo",
          repo,
          projectPath: repo.path,
          indexPath,
          files: group.files,
          reason: group.reason,
          policy,
          options,
        }),
      );
    }
  }

  return shards.sort((left, right) => left.id.localeCompare(right.id));
}

function packageScipShardPlans(input: {
  id: string;
  repo: DiscoveredRepo;
  indexPath: string;
  packagePath: string;
  sourceRoots: string[];
  includedFiles: DiscoveredFile[];
  policy: ScipPolicy;
  options: PlanScipShardsOptions;
}): ScipShardPlan[] {
  if (input.includedFiles.length === 0) {
    return [];
  }
  const groups = groupFilesBySourceRoot(input.includedFiles, input.sourceRoots, input.packagePath);
  return groups.flatMap((group) =>
    splitCostedGroup({
      id: `${input.id}-${group.id}`,
      kind: "package",
      repo: input.repo,
      projectPath: input.packagePath,
      indexPath: input.indexPath,
      files: group.files,
      reason: "package-source-root",
      policy: input.policy,
      options: input.options,
    })
  );
}

function splitCostedGroup(input: {
  id: string;
  kind: "package" | "repo";
  repo: DiscoveredRepo;
  projectPath: string;
  indexPath: string;
  files: DiscoveredFile[];
  reason: string;
  policy: ScipPolicy;
  options: PlanScipShardsOptions;
}): ScipShardPlan[] {
  const sorted = input.files.sort(compareDiscoveredFiles);
  const historyMatched = sorted.some((file) => failureHistoryMatches(input.repo.name, file.relativePath, input.options.failureHistory));
  const maxFiles = historyMatched
    ? Math.max(1, Math.floor(input.policy.legacyMaxFiles / Math.max(1, input.policy.historyPenalty * 100)))
    : input.policy.legacyMaxFiles;
  const targetCost = historyMatched
    ? Math.max(1, Math.floor(input.policy.targetShardCost / Math.max(1, input.policy.historyPenalty * 10)))
    : input.policy.targetShardCost;

  const chunks: DiscoveredFile[][] = [];
  let current: DiscoveredFile[] = [];
  let currentCost = 0;
  for (const file of sorted) {
    const fileCost = scipFileCost(file, input.options.fileFactsByRelativePath?.get(file.relativePath), historyMatched);
    const wouldExceed = current.length > 0 && (current.length >= maxFiles || currentCost + fileCost > targetCost);
    if (wouldExceed) {
      chunks.push(current);
      current = [];
      currentCost = 0;
    }
    current.push(file);
    currentCost += fileCost;
  }
  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks.map((files, index) => {
    const shardId = chunks.length === 1 ? input.id : `${input.id}-${index + 1}`;
    const fileCosts = files.map((file) => ({
      absolutePath: file.absolutePath,
      cost: scipFileCost(file, input.options.fileFactsByRelativePath?.get(file.relativePath), historyMatched),
    })).sort((left, right) => left.absolutePath.localeCompare(right.absolutePath));
    return {
      id: safePathSegment(shardId),
      kind: input.kind,
      projectPath: input.projectPath,
      outputPath: scipShardOutputPath(input.indexPath, input.repo.name, shardId),
      includedFiles: files.map((file) => file.absolutePath).sort(),
      fileCosts,
      cost: fileCosts.reduce((sum, file) => sum + file.cost, 0),
      reason: historyMatched ? `${input.reason}:history` : input.reason,
      lineage: [safePathSegment(shardId)],
    };
  });
}

function groupFilesBySourceRoot(
  includedFiles: DiscoveredFile[],
  sourceRoots: string[],
  packagePath: string,
): Array<{ id: string; files: DiscoveredFile[] }> {
  const roots = sourceRoots.length > 0 ? sourceRoots : [packagePath];
  const groups = new Map<string, DiscoveredFile[]>();
  for (const file of includedFiles) {
    const root = roots.find((sourceRoot) => pathStartsWith(file.absolutePath, sourceRoot)) ?? packagePath;
    const id = safePathSegment(root === packagePath ? "package" : root.slice(packagePath.length + 1) || "package");
    const files = groups.get(id) ?? [];
    files.push(file);
    groups.set(id, files);
  }
  return [...groups.entries()]
    .map(([id, files]) => ({ id, files: files.sort(compareDiscoveredFiles) }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function groupOutsidePackageFiles(
  repo: DiscoveredRepo,
  files: DiscoveredFile[],
): Array<{ id: string; files: DiscoveredFile[]; reason: string }> {
  const groups = new Map<string, DiscoveredFile[]>();
  for (const file of files) {
    const group = file.outsidePackageGroup ?? topLevelGroup(file.relativePath);
    const current = groups.get(group) ?? [];
    current.push(file);
    groups.set(group, current);
  }
  return [...groups.entries()]
    .map(([group, groupFiles]) => ({
      id: `repo-root-${safePathSegment(group)}`,
      files: groupFiles.sort(compareDiscoveredFiles),
      reason: `repo-root:${repo.name}:${group}`,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function scipFileCost(file: DiscoveredFile, fact: FileFact | undefined, historyMatched: boolean): number {
  const sourceKb = fact ? Math.ceil(fact.fingerprint.size / 1024) : 1;
  const generatedPenalty = file.generated ? 30 : 0;
  const declarationCost = (fact?.declarations.length ?? 0) * 2;
  const importCost = (fact?.imports.length ?? 0) * 2;
  const typeCost = Math.ceil((fact?.typeReferences.length ?? 0) / 2);
  const base = 1 + sourceKb + declarationCost + importCost + typeCost + generatedPenalty;
  return historyMatched ? base * 4 : base;
}

function failureHistoryMatches(
  repo: string,
  relativePath: string,
  history: ScipFailureHistoryEntry[] | undefined,
): boolean {
  return (history ?? []).some((entry) =>
    entry.repo === repo &&
    entry.failureKind === "oom" &&
    (relativePath === entry.pathPrefix || relativePath.startsWith(`${entry.pathPrefix.replace(/\/$/, "")}/`))
  );
}

function topLevelGroup(relativePath: string): string {
  return normalizeRelativePath(relativePath).split("/")[0] || "root";
}

function compareDiscoveredFiles(left: DiscoveredFile, right: DiscoveredFile): number {
  return left.relativePath.localeCompare(right.relativePath);
}

function pathStartsWith(filePath: string, directoryPath: string): boolean {
  const normalizedDirectory = directoryPath.replace(/\/$/, "");
  return filePath === normalizedDirectory || filePath.startsWith(`${normalizedDirectory}/`);
}

function scipShardOutputPath(indexPath: string, repoName: string, shardId: string): string {
  return join(indexPath, "scip", safePathSegment(repoName), `${safePathSegment(shardId)}.scip`);
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}
