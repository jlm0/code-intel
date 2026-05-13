import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { normalizeRelativePath } from "../core/ids.js";

const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
]);

const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

export interface DiscoverWorkspaceInput {
  workspaceRoot: string;
  repoPaths: string[];
}

export interface DiscoveredWorkspace {
  workspaceName: string;
  workspaceRoot: string;
  repos: DiscoveredRepo[];
}

export interface DiscoveredRepo {
  name: string;
  path: string;
  relativePath: string;
  commit: string;
  packageManager: string;
  packages: DiscoveredPackage[];
  files: DiscoveredFile[];
}

export interface DiscoveredPackage {
  name: string;
  path: string;
  relativePath: string;
  exports: unknown;
  dependencies: Record<string, string>;
  sourceRoots: string[];
}

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  packageName?: string;
  language: "typescript" | "tsx" | "javascript" | "jsx";
}

export async function discoverWorkspace(
  input: DiscoverWorkspaceInput,
): Promise<DiscoveredWorkspace> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const rootPackage = await readPackageJson(workspaceRoot);
  const workspaceName = rootPackage?.name ?? basename(workspaceRoot);
  const repos = await Promise.all(
    input.repoPaths.map((repoPath) => discoverRepo(workspaceRoot, resolve(workspaceRoot, repoPath))),
  );

  return { workspaceName, workspaceRoot, repos };
}

async function discoverRepo(workspaceRoot: string, repoPath: string): Promise<DiscoveredRepo> {
  const repoPackage = await readPackageJson(repoPath);
  const packageManager = await detectPackageManager(repoPath);
  const packagePaths = await discoverPackagePaths(repoPath, repoPackage);
  const packages = await Promise.all(
    packagePaths.map((packagePath) => discoverPackage(workspaceRoot, packagePath)),
  );
  const files = await discoverSourceFiles(repoPath, packages);

  return {
    name: basename(repoPath),
    path: repoPath,
    relativePath: normalizeRelativePath(relative(workspaceRoot, repoPath) || "."),
    commit: detectCommit(repoPath),
    packageManager,
    packages,
    files,
  };
}

async function discoverPackagePaths(repoPath: string, packageJson: PackageJson | undefined): Promise<string[]> {
  const packagePaths = new Set<string>();
  packagePaths.add(repoPath);

  const workspaces = normalizeWorkspacePatterns(packageJson?.workspaces);
  for (const pattern of workspaces) {
    if (!pattern.endsWith("/*")) {
      continue;
    }
    const parent = join(repoPath, pattern.slice(0, -2));
    for (const entry of await safeReaddir(parent)) {
      const candidate = join(parent, entry.name);
      if (entry.isDirectory() && (await readPackageJson(candidate))) {
        packagePaths.add(candidate);
      }
    }
  }

  if (packagePaths.size === 1) {
    for (const packageJsonPath of await findPackageJsonFiles(repoPath)) {
      packagePaths.add(dirname(packageJsonPath));
    }
  }

  return [...packagePaths].filter((packagePath) => packagePath !== repoPath || packagePaths.size === 1);
}

async function discoverPackage(
  workspaceRoot: string,
  packagePath: string,
): Promise<DiscoveredPackage> {
  const packageJson = await readPackageJson(packagePath);
  return {
    name: packageJson?.name ?? basename(packagePath),
    path: packagePath,
    relativePath: normalizeRelativePath(relative(workspaceRoot, packagePath) || "."),
    exports: packageJson?.exports,
    dependencies: {
      ...(packageJson?.dependencies ?? {}),
      ...(packageJson?.devDependencies ?? {}),
      ...(packageJson?.peerDependencies ?? {}),
    },
    sourceRoots: [join(packagePath, "src")],
  };
}

async function discoverSourceFiles(
  repoPath: string,
  packages: DiscoveredPackage[],
): Promise<DiscoveredFile[]> {
  const packageByPath = [...packages].sort((left, right) => right.path.length - left.path.length);
  const files: DiscoveredFile[] = [];

  await walk(repoPath, async (absolutePath) => {
    const extension = getExtension(absolutePath);
    if (!sourceExtensions.has(extension)) {
      return;
    }
    const matchingPackage = packageByPath.find((pkg) => absolutePath.startsWith(`${pkg.path}/`));
    files.push({
      absolutePath,
      relativePath: normalizeRelativePath(relative(repoPath, absolutePath)),
      packageName: matchingPackage?.name,
      language: languageForPath(absolutePath),
    });
  });

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function walk(root: string, onFile: (path: string) => Promise<void>): Promise<void> {
  for (const entry of await safeReaddir(root)) {
    if (ignoredDirectories.has(entry.name)) {
      continue;
    }
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(absolutePath, onFile);
    } else if (entry.isFile()) {
      await onFile(absolutePath);
    }
  }
}

async function findPackageJsonFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, async (absolutePath) => {
    if (basename(absolutePath) === "package.json") {
      files.push(absolutePath);
    }
  });
  return files;
}

async function detectPackageManager(repoPath: string): Promise<string> {
  const entries = new Set((await safeReaddir(repoPath)).map((entry) => entry.name));
  if (entries.has("pnpm-lock.yaml")) return "pnpm";
  if (entries.has("yarn.lock")) return "yarn";
  if (entries.has("package-lock.json")) return "npm";
  return "unknown";
}

function detectCommit(repoPath: string): string {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repoPath,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "no-git";
}

async function readPackageJson(path: string): Promise<PackageJson | undefined> {
  try {
    return JSON.parse(await readFile(join(path, "package.json"), "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
}

async function safeReaddir(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function normalizeWorkspacePatterns(workspaces: unknown): string[] {
  if (Array.isArray(workspaces)) {
    return workspaces.filter((pattern): pattern is string => typeof pattern === "string");
  }
  if (
    workspaces &&
    typeof workspaces === "object" &&
    Array.isArray((workspaces as { packages?: unknown }).packages)
  ) {
    return (workspaces as { packages: unknown[] }).packages.filter(
      (pattern): pattern is string => typeof pattern === "string",
    );
  }
  return [];
}

function getExtension(path: string): string {
  const match = path.match(/(\.[^.]+)$/);
  return match?.[1] ?? "";
}

function languageForPath(path: string): DiscoveredFile["language"] {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".jsx")) return "jsx";
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) return "typescript";
  return "javascript";
}

interface PackageJson {
  name?: string;
  workspaces?: unknown;
  exports?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}
