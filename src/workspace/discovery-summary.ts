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
    },
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

function fileOutsideSourceRoot(absolutePath: string, packages: DiscoveredPackage[]): boolean {
  const pkg = packages.find((candidate) => absolutePath.startsWith(`${candidate.path}/`));
  return !pkg || !pathUnderAnyRoot(absolutePath, pkg.sourceRoots);
}

function pathUnderAnyRoot(absolutePath: string, roots: string[]): boolean {
  return roots.some((root) => absolutePath === root || absolutePath.startsWith(`${root}/`));
}
