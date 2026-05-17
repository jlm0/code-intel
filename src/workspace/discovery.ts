import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { normalizeRelativePath } from "../core/ids.js";
import { directoryIsIgnored } from "./ignore.js";

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

export interface DiscoverWorkspaceInput {
  workspaceRoot: string;
  repoPaths: string[];
  includeIgnored?: boolean;
  workspaceManifestPath?: string;
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
  includePatterns?: string[];
  excludePatterns: string[];
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
  const manifestRepoPaths = await readWorkspaceManifest(workspaceRoot, input.workspaceManifestPath);
  const repoPaths = input.repoPaths.length > 0
    ? input.repoPaths
    : manifestRepoPaths.length > 0
      ? manifestRepoPaths
      : [workspaceRoot];
  const repos = await Promise.all(
    repoPaths.map((repoPath) =>
      discoverRepo(workspaceRoot, resolve(workspaceRoot, repoPath), {
        includeIgnored: input.includeIgnored === true,
      }),
    ),
  );

  return { workspaceName, workspaceRoot, repos };
}

async function discoverRepo(
  workspaceRoot: string,
  repoPath: string,
  options: DiscoverOptions,
): Promise<DiscoveredRepo> {
  await ensureDirectory(repoPath, "Repository path");
  const repoPackage = await readPackageJson(repoPath);
  const packageManager = await detectPackageManager(repoPath);
  const packagePaths = await discoverPackagePaths(repoPath, repoPackage, options);
  const packages = await Promise.all(
    packagePaths.map((packagePath) => discoverPackage(workspaceRoot, packagePath)),
  );
  const files = await discoverSourceFiles(repoPath, packages, options);

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

async function discoverPackagePaths(
  repoPath: string,
  packageJson: PackageJson | undefined,
  options: DiscoverOptions,
): Promise<string[]> {
  const packagePaths = new Set<string>();
  const workspaces = normalizeWorkspacePatterns(packageJson?.workspaces);

  if (workspaces.length > 0) {
    let workspacePackageJsonFiles: string[] | undefined;
    for (const pattern of workspaces) {
      if (!pattern.endsWith("/*") || pattern.includes("**")) {
        workspacePackageJsonFiles ??= await findPackageJsonFiles(repoPath, options);
        for (const packageJsonPath of workspacePackageJsonFiles) {
          if (workspacePatternIncludesPackage(repoPath, pattern, dirname(packageJsonPath))) {
            packagePaths.add(dirname(packageJsonPath));
          }
        }
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
    if (packagePaths.size === 0) {
      packagePaths.add(repoPath);
    }
  } else {
    packagePaths.add(repoPath);
    for (const packageJsonPath of await findPackageJsonFiles(repoPath, options)) {
      packagePaths.add(dirname(packageJsonPath));
    }
  }

  return [...packagePaths].sort();
}

function workspacePatternIncludesPackage(repoPath: string, pattern: string, packagePath: string): boolean {
  const relativePackagePath = normalizeRelativePath(relative(repoPath, packagePath));
  const root = globRoot(pattern).replace(/\/$/, "");
  return relativePackagePath !== "." &&
    ((root !== "." && relativePackagePath.startsWith(`${root}/`)) ||
      matchesGlob(pattern, relativePackagePath) ||
      matchesGlob(pattern, `${relativePackagePath}/package.json`));
}

async function discoverPackage(
  workspaceRoot: string,
  packagePath: string,
): Promise<DiscoveredPackage> {
  const packageJson = await readPackageJson(packagePath);
  const projectConfig = await readProjectConfig(packagePath);
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
    sourceRoots: await inferSourceRoots(packagePath, projectConfig),
    includePatterns: projectConfig?.include,
    excludePatterns: projectConfig?.exclude ?? [],
  };
}

async function discoverSourceFiles(
  repoPath: string,
  packages: DiscoveredPackage[],
  options: DiscoverOptions,
): Promise<DiscoveredFile[]> {
  const packageByPath = [...packages].sort((left, right) => right.path.length - left.path.length);
  const files: DiscoveredFile[] = [];

  await walk(repoPath, options, async (absolutePath) => {
    const extension = getExtension(absolutePath);
    if (!sourceExtensions.has(extension)) {
      return;
    }
    const matchingPackage = packageByPath.find((pkg) => absolutePath.startsWith(`${pkg.path}/`));
    if (matchingPackage && !packageIncludesFile(matchingPackage, absolutePath)) {
      return;
    }
    files.push({
      absolutePath,
      relativePath: normalizeRelativePath(relative(repoPath, absolutePath)),
      packageName: matchingPackage?.name,
      language: languageForPath(absolutePath),
    });
  });

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function walk(root: string, options: DiscoverOptions, onFile: (path: string) => Promise<void>): Promise<void> {
  for (const entry of await safeReaddir(root)) {
    if (!options.includeIgnored && directoryIsIgnored(entry.name)) {
      continue;
    }
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(absolutePath, options, onFile);
    } else if (entry.isFile()) {
      await onFile(absolutePath);
    }
  }
}

async function findPackageJsonFiles(root: string, options: DiscoverOptions): Promise<string[]> {
  const files: string[] = [];
  await walk(root, options, async (absolutePath) => {
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
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid package.json at ${join(path, "package.json")}: ${error.message}`);
    }
    return undefined;
  }
}

async function readProjectConfig(path: string): Promise<ProjectConfig | undefined> {
  for (const filename of ["tsconfig.json", "jsconfig.json"]) {
    try {
      return parseJsonc(await readFile(join(path, filename), "utf8")) as ProjectConfig;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid ${filename} at ${join(path, filename)}: ${error.message}`);
      }
    }
  }
  return undefined;
}

async function readWorkspaceManifest(workspaceRoot: string, manifestPath: string | undefined): Promise<string[]> {
  if (!manifestPath) {
    return [];
  }
  const resolvedPath = resolve(workspaceRoot, manifestPath);
  const manifest = JSON.parse(await readFile(resolvedPath, "utf8")) as WorkspaceManifest;
  const repos = Array.isArray(manifest.repoPaths)
    ? manifest.repoPaths
    : Array.isArray(manifest.repos)
      ? manifest.repos
      : [];
  return repos
    .map((repo) => {
      if (typeof repo === "string") {
        return repo;
      }
      if (repo && typeof repo === "object" && typeof (repo as { path?: unknown }).path === "string") {
        return (repo as { path: string }).path;
      }
      return undefined;
    })
    .filter((repo): repo is string => typeof repo === "string" && repo.length > 0);
}

async function inferSourceRoots(packagePath: string, config: ProjectConfig | undefined): Promise<string[]> {
  const roots = new Set<string>();
  const compilerOptions = config?.compilerOptions;
  if (typeof compilerOptions?.rootDir === "string") {
    roots.add(resolve(packagePath, compilerOptions.rootDir));
  }
  if (Array.isArray(compilerOptions?.rootDirs)) {
    for (const rootDir of compilerOptions.rootDirs) {
      if (typeof rootDir === "string") {
        roots.add(resolve(packagePath, rootDir));
      }
    }
  }
  for (const include of config?.include ?? []) {
    const root = globRoot(include);
    if (root) {
      roots.add(resolve(packagePath, root));
    }
  }
  if (roots.size === 0) {
    const sourceRoot = join(packagePath, "src");
    roots.add(await directoryExists(sourceRoot) ? sourceRoot : packagePath);
  }
  return [...roots].sort();
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function packageIncludesFile(pkg: DiscoveredPackage, absolutePath: string): boolean {
  const relativePath = normalizeRelativePath(relative(pkg.path, absolutePath));
  if (relativePath.startsWith("..")) {
    return false;
  }
  if (pkg.includePatterns && !pkg.includePatterns.some((pattern) => matchesGlob(pattern, relativePath))) {
    return false;
  }
  if (isExplicitTestFile(relativePath)) {
    return true;
  }
  return !pkg.excludePatterns.some((pattern) => matchesGlob(pattern, relativePath));
}

function isExplicitTestFile(relativePath: string): boolean {
  return /(^|\/)(__tests__|tests?)\//.test(relativePath) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath);
}

function globRoot(pattern: string): string {
  const normalized = normalizeRelativePath(pattern).replace(/^\.\//, "");
  const firstGlob = normalized.search(/[*?{[]/);
  const prefix = firstGlob === -1 ? normalized : normalized.slice(0, firstGlob);
  const cleaned = prefix.replace(/\/?[^/]*$/, "");
  return cleaned || ".";
}

function matchesGlob(pattern: string, relativePath: string): boolean {
  let normalized = normalizeRelativePath(pattern).replace(/^\.\//, "");
  if (!/[*?{[]/.test(normalized) && !getExtension(normalized)) {
    normalized = `${normalized.replace(/\/$/, "")}/**`;
  }
  return globToRegExp(normalized).test(relativePath);
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      index += 2;
    } else if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function parseJsonc(text: string): unknown {
  return JSON.parse(removeTrailingCommas(stripJsonComments(text)));
}

function stripJsonComments(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function removeTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, "$1");
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

async function ensureDirectory(path: string, label: string): Promise<void> {
  try {
    const stats = await stat(path);
    if (!stats.isDirectory()) {
      throw new Error(`${label} is not a directory: ${path}`);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`${label} does not exist: ${path}`);
    }
    throw error;
  }
}

interface PackageJson {
  name?: string;
  workspaces?: unknown;
  exports?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface ProjectConfig {
  compilerOptions?: {
    rootDir?: unknown;
    rootDirs?: unknown;
  };
  include?: string[];
  exclude?: string[];
}

interface WorkspaceManifest {
  repoPaths?: unknown[];
  repos?: Array<string | { path?: unknown }>;
}

interface DiscoverOptions {
  includeIgnored: boolean;
}
