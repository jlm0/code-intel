import type { IndexDiscoverySummary } from "../schema/schemas.js";
import type { DiscoveredPackage, DiscoveredRepo, DiscoveredWorkspace, DiscoveryFileDiagnostic } from "./discovery.js";

export function summarizeWorkspaceDiscovery(workspace: DiscoveredWorkspace): IndexDiscoverySummary {
  const repos = workspace.repos.map((repo) => summarizeRepoDiscovery(repo, workspace));
  return {
    totals: {
      repos: repos.length,
      packages: repos.reduce((sum, repo) => sum + repo.packages.length, 0),
      includedFiles: repos.reduce((sum, repo) => sum + repo.includedFiles, 0),
      unsupportedFiles: repos.reduce((sum, repo) => sum + repo.unsupportedFiles, 0),
      ignoredDirectories: repos.reduce((sum, repo) => sum + repo.ignoredDirectories, 0),
      tsconfigExcludedFiles: repos.reduce((sum, repo) => sum + repo.tsconfigExcludedFiles, 0),
      outsideSourceRootFiles: repos.reduce((sum, repo) => sum + repo.outsideSourceRootFiles, 0),
      generatedFiles: repos.reduce((sum, repo) => sum + repo.generatedFiles, 0),
      buildArtifactFiles: repos.reduce((sum, repo) => sum + repo.buildArtifactFiles, 0),
      generatedBytes: repos.reduce((sum, repo) => sum + repo.generatedBytes, 0),
      buildArtifactBytes: repos.reduce((sum, repo) => sum + repo.buildArtifactBytes, 0),
    },
    topExcludedContributors: topExcludedContributors(workspace.diagnostics.files),
    repos,
  };
}

function summarizeRepoDiscovery(
  repo: DiscoveredRepo,
  workspace: DiscoveredWorkspace,
): IndexDiscoverySummary["repos"][number] {
  const diagnostics = workspace.diagnostics.files.filter((file) => file.repo === repo.name);
  return {
    repo: repo.name,
    path: repo.path,
    packages: repo.packages.map((pkg) => summarizePackageDiscovery(repo, pkg, diagnostics)),
    includedFiles: diagnostics.filter((file) => file.status === "included").length,
    unsupportedFiles: diagnostics.filter((file) => file.reason === "unsupported-extension").length,
    ignoredDirectories: diagnostics.filter((file) => file.reason === "ignored-directory").length,
    tsconfigExcludedFiles: diagnostics.filter((file) => file.reason === "tsconfig-excluded").length,
    outsideSourceRootFiles: repo.files.filter((file) => fileOutsideSourceRoot(file.absolutePath, repo.packages)).length,
    generatedFiles: diagnostics.filter((file) => file.generated).length,
    buildArtifactFiles: diagnostics.filter((file) => file.buildArtifact || file.reason === "build-artifact").length,
    generatedBytes: sumSizes(diagnostics.filter((file) => file.generated)),
    buildArtifactBytes: sumSizes(diagnostics.filter((file) => file.buildArtifact || file.reason === "build-artifact")),
  };
}

function summarizePackageDiscovery(
  repo: DiscoveredRepo,
  pkg: DiscoveredPackage,
  diagnostics: DiscoveryFileDiagnostic[],
): IndexDiscoverySummary["repos"][number]["packages"][number] {
  const packageFiles = repo.files.filter((file) => file.packageName === pkg.name);
  return {
    name: pkg.name,
    path: pkg.path,
    sourceRoots: pkg.sourceRoots,
    includedFiles: packageFiles.length,
    tsconfigExcludedFiles: diagnostics.filter(
      (file) => file.packageName === pkg.name && file.reason === "tsconfig-excluded",
    ).length,
    outsideSourceRootFiles: packageFiles.filter((file) => !pathUnderAnyRoot(file.absolutePath, pkg.sourceRoots)).length,
  };
}

function sumSizes(diagnostics: DiscoveryFileDiagnostic[]): number {
  return diagnostics.reduce((sum, diagnostic) => sum + (diagnostic.size ?? 0), 0);
}

function topExcludedContributors(
  diagnostics: DiscoveryFileDiagnostic[],
): Array<{ path: string; reason: string; count: number; bytes: number }> {
  const groups = new Map<string, { path: string; reason: string; count: number; bytes: number }>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.status !== "excluded") {
      continue;
    }
    const path = diagnostic.kind === "directory"
      ? diagnostic.relativePath
      : diagnostic.relativePath.split("/").slice(0, -1).join("/") || ".";
    const key = `${diagnostic.reason}\0${path}`;
    const group = groups.get(key) ?? { path, reason: diagnostic.reason, count: 0, bytes: 0 };
    group.count += 1;
    group.bytes += diagnostic.size ?? 0;
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((left, right) => right.count - left.count || right.bytes - left.bytes || left.path.localeCompare(right.path))
    .slice(0, 10);
}

function fileOutsideSourceRoot(absolutePath: string, packages: DiscoveredPackage[]): boolean {
  const pkg = packages.find((candidate) => absolutePath.startsWith(`${candidate.path}/`));
  return !pkg || !pathUnderAnyRoot(absolutePath, pkg.sourceRoots);
}

function pathUnderAnyRoot(absolutePath: string, roots: string[]): boolean {
  return roots.some((root) => absolutePath === root || absolutePath.startsWith(`${root}/`));
}
