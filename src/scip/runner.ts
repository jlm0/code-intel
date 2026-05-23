import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import { truncateUtf8Bytes } from "../core/text.js";

export interface RunScipTypescriptInput {
  repoPath: string;
  outputPath: string;
  inferTsconfig: boolean;
  projectPaths?: string[];
  includedFiles?: string[];
  maxOldSpaceSizeMb?: number;
  disableGlobalCaches?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxScipBytes?: number;
  safeTsconfig?: boolean;
  projectReferencesEnabled?: boolean;
}

export interface RunScipTypescriptResult {
  ok: boolean;
  outputPath: string;
  outputBytes: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export async function runScipTypescript(
  input: RunScipTypescriptInput,
): Promise<RunScipTypescriptResult> {
  await mkdir(dirname(input.outputPath), { recursive: true });
  const preparedProject = await prepareScipProject(input);
  const scipArgs = [
    "index",
    "--cwd",
    input.repoPath,
    "--output",
    input.outputPath,
    "--no-progress-bar",
    ...((input.disableGlobalCaches ?? true) ? ["--no-global-caches"] : []),
    ...(preparedProject.project ? [preparedProject.project] : []),
  ];
  const args = [
    `--max-old-space-size=${input.maxOldSpaceSizeMb ?? 1024}`,
    resolveScipTypescriptBin(),
    ...scipArgs,
  ];

  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = performance.now();
    const timeoutMs = input.timeoutMs ?? 120_000;
    const maxOutputBytes = input.maxOutputBytes ?? 128_000;
    const maxScipBytes = input.maxScipBytes ?? 128_000_000;
    const child = spawn(process.execPath, args, {
      cwd: input.repoPath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let hardKillTimeout: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      hardKillTimeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5_000);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk, maxOutputBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk, maxOutputBytes);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (hardKillTimeout) clearTimeout(hardKillTimeout);
      cleanupPreparedScipProject(preparedProject).finally(() => rejectPromise(error));
    });
    child.on("close", async (exitCode, signal) => {
      clearTimeout(timeout);
      if (hardKillTimeout) clearTimeout(hardKillTimeout);
      const scipSize = await outputFileSize(input.outputPath);
      const durationMs = Math.round(performance.now() - startedAt);
      if (scipSize > maxScipBytes) {
        await rm(input.outputPath, { force: true });
        await cleanupPreparedScipProject(preparedProject);
        resolvePromise({
          ok: false,
          outputPath: input.outputPath,
          outputBytes: scipSize,
          durationMs,
          stdout,
          stderr: appendBounded(
            stderr,
            `\nscip-typescript output file exceeded ${maxScipBytes} bytes`,
            maxOutputBytes,
          ),
          exitCode,
          signal,
          timedOut,
        });
        return;
      }
      await cleanupPreparedScipProject(preparedProject);
      resolvePromise({
        ok: exitCode === 0 && !timedOut,
        outputPath: input.outputPath,
        outputBytes: scipSize,
        durationMs,
        stdout,
        stderr: timedOut ? appendBounded(stderr, `\nscip-typescript timed out after ${timeoutMs}ms`, maxOutputBytes) : stderr,
        exitCode,
        signal,
        timedOut,
      });
    });
  });
}

interface PreparedScipProject {
  project?: string;
  cleanup(): Promise<void>;
}

async function prepareScipProject(input: RunScipTypescriptInput): Promise<PreparedScipProject> {
  const projectPaths = [...new Set(input.projectPaths ?? [])].filter((projectPath) => projectPath.length > 0).sort();
  if (projectPaths.length > 1) {
    throw new Error("runScipTypescript executes one SCIP project shard; call it once per shard");
  }
  const repoConfigPath = await existingProjectConfigPath(input.repoPath);
  let scratchRoot: string | undefined;
  const ensureScratchRoot = async () => {
    scratchRoot ??= await mkdtemp(join(dirname(input.outputPath), "scip-infer-"));
    return scratchRoot;
  };

  if (projectPaths.length > 0) {
    return {
      project: await preparedProjectPath({
        projectPath: projectPaths[0]!,
        inferTsconfig: input.inferTsconfig,
        includedFiles: input.includedFiles,
        ensureScratchRoot,
        baseConfigPath: repoConfigPath,
        safeTsconfig: input.safeTsconfig,
        projectReferencesEnabled: input.projectReferencesEnabled,
      }),
      cleanup: () => scratchRoot ? rm(scratchRoot, { recursive: true, force: true }) : Promise.resolve(),
    };
  }

  if (input.includedFiles && input.includedFiles.length > 0) {
    const scratchDirectory = await ensureScratchRoot();
    const configPath = join(scratchDirectory, "tsconfig.json");
    const inferredConfig = await inferredTsconfig({
      repoPath: input.repoPath,
      baseConfigPath: repoConfigPath,
      includedFiles: input.includedFiles,
      safeTsconfig: input.safeTsconfig,
      projectReferencesEnabled: input.projectReferencesEnabled,
      tsBuildInfoFile: join(scratchDirectory, "code-intel.tsbuildinfo"),
    });
    await writeFile(configPath, `${JSON.stringify(inferredConfig, null, 2)}\n`);
    return {
      project: configPath,
      cleanup: () => scratchRoot ? rm(scratchRoot, { recursive: true, force: true }) : Promise.resolve(),
    };
  }

  if (repoConfigPath) {
    return { project: repoConfigPath, cleanup: async () => {} };
  }
  if (!input.inferTsconfig) {
    return { cleanup: async () => {} };
  }

  const scratchDirectory = await ensureScratchRoot();
  const inferredConfig = await inferredTsconfig({
    repoPath: input.repoPath,
    safeTsconfig: input.safeTsconfig,
    projectReferencesEnabled: input.projectReferencesEnabled,
    tsBuildInfoFile: join(scratchDirectory, "code-intel.tsbuildinfo"),
  });
  const configPath = join(scratchDirectory, "tsconfig.json");
  await writeFile(configPath, `${JSON.stringify(inferredConfig, null, 2)}\n`);
  return {
    project: configPath,
    cleanup: () => scratchRoot ? rm(scratchRoot, { recursive: true, force: true }) : Promise.resolve(),
  };
}

async function preparedProjectPath(input: {
  projectPath: string;
  inferTsconfig: boolean;
  includedFiles: string[] | undefined;
  ensureScratchRoot: () => Promise<string>;
  baseConfigPath: string | undefined;
  safeTsconfig?: boolean;
  projectReferencesEnabled?: boolean;
}): Promise<string> {
  if (input.includedFiles && input.includedFiles.length > 0) {
    const projectRoot = await projectRootPath(input.projectPath);
    const scratchRoot = await input.ensureScratchRoot();
    const configPath = join(scratchRoot, safeProjectConfigName(projectRoot));
    const projectConfigPath = await existingProjectConfigPath(input.projectPath);
    const inferredConfig = await inferredTsconfig({
      repoPath: projectRoot,
      baseConfigPath: projectConfigPath ?? input.baseConfigPath,
      includedFiles: input.includedFiles,
      safeTsconfig: input.safeTsconfig,
      projectReferencesEnabled: input.projectReferencesEnabled,
      tsBuildInfoFile: join(scratchRoot, "code-intel.tsbuildinfo"),
    });
    await writeFile(configPath, `${JSON.stringify(inferredConfig, null, 2)}\n`);
    return configPath;
  }

  const projectPath = input.projectPath;
  const existingConfig = await existingProjectConfigPath(projectPath);
  if (existingConfig) {
    return existingConfig;
  }
  if (!input.inferTsconfig) {
    return projectPath;
  }
  const projectRoot = await projectRootPath(projectPath);
  const scratchRoot = await input.ensureScratchRoot();
  const configPath = join(scratchRoot, safeProjectConfigName(projectRoot));
  const inferredConfig = await inferredTsconfig({
    repoPath: projectRoot,
    baseConfigPath: input.baseConfigPath,
    safeTsconfig: input.safeTsconfig,
    projectReferencesEnabled: input.projectReferencesEnabled,
    tsBuildInfoFile: join(scratchRoot, "code-intel.tsbuildinfo"),
  });
  await writeFile(configPath, `${JSON.stringify(inferredConfig, null, 2)}\n`);
  return configPath;
}

async function existingProjectConfigPath(projectPath: string): Promise<string | undefined> {
  const projectStats = await pathStat(projectPath);
  if (projectStats?.isFile()) {
    return projectPath;
  }
  if (!projectStats?.isDirectory()) {
    return undefined;
  }
  for (const configName of ["tsconfig.json", "jsconfig.json"]) {
    const configPath = join(projectPath, configName);
    if (await pathExists(configPath)) {
      return configPath;
    }
  }
  return undefined;
}

async function projectRootPath(projectPath: string): Promise<string> {
  const projectStats = await pathStat(projectPath);
  return projectStats?.isFile() ? dirname(projectPath) : projectPath;
}

function safeProjectConfigName(projectRoot: string): string {
  return `${projectRoot.replace(/[^A-Za-z0-9_.-]/g, "_")}.tsconfig.json`;
}

async function inferredTsconfig(input: {
  repoPath: string;
  baseConfigPath?: string;
  includedFiles?: string[];
  safeTsconfig?: boolean;
  projectReferencesEnabled?: boolean;
  tsBuildInfoFile?: string;
}): Promise<Record<string, unknown>> {
  const allowJs = await shouldAllowJs(input.repoPath);
  const uniqueIncludedFiles = [...new Set(input.includedFiles ?? [])].sort();
  const include = uniqueIncludedFiles.length > 0
    ? undefined
    : [
      ...absoluteGlobs(input.repoPath, ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"]),
      ...(allowJs ? absoluteGlobs(input.repoPath, ["**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"]) : []),
    ];
  const safeConfig = createSafeScipTsconfig({
    repoPath: input.repoPath,
    baseConfigPath: input.baseConfigPath,
    includedFiles: uniqueIncludedFiles,
    allowJs,
    projectReferencesEnabled: input.projectReferencesEnabled === true,
    tsBuildInfoFile: input.tsBuildInfoFile,
  });
  if (input.safeTsconfig === false) {
    return {
      ...(input.baseConfigPath ? { extends: input.baseConfigPath } : {}),
      compilerOptions: allowJs ? { allowJs: true, checkJs: false } : {},
      ...(uniqueIncludedFiles.length > 0 ? { files: uniqueIncludedFiles } : { include }),
      exclude: defaultScipExcludeGlobs(input.repoPath),
    };
  }
  return {
    ...safeConfig,
    ...(uniqueIncludedFiles.length > 0 ? { files: uniqueIncludedFiles } : { include }),
  };
}

export function createSafeScipTsconfig(input: {
  repoPath: string;
  baseConfigPath?: string;
  includedFiles?: string[];
  allowJs: boolean;
  projectReferencesEnabled: boolean;
  references?: Array<Record<string, unknown>>;
  tsBuildInfoFile?: string;
}): Record<string, unknown> {
  const uniqueIncludedFiles = [...new Set(input.includedFiles ?? [])].sort();
  return {
    ...(input.baseConfigPath ? { extends: input.baseConfigPath } : {}),
    compilerOptions: {
      ...(input.allowJs ? { allowJs: true, checkJs: false } : {}),
      noEmit: true,
      declaration: false,
      composite: false,
      incremental: false,
      emitDeclarationOnly: false,
      skipLibCheck: true,
      ...(input.tsBuildInfoFile ? { tsBuildInfoFile: input.tsBuildInfoFile } : {}),
    },
    ...(uniqueIncludedFiles.length > 0 ? { files: uniqueIncludedFiles } : {}),
    references: input.projectReferencesEnabled ? input.references ?? [] : [],
    exclude: defaultScipExcludeGlobs(input.repoPath),
  };
}

function defaultScipExcludeGlobs(repoPath: string): string[] {
  return absoluteGlobs(repoPath, [
    "node_modules/**",
    "bower_components/**",
    "jspm_packages/**",
    ".git/**",
    ".next/**",
    ".turbo/**",
    ".yarn/**",
    "__generated__/**",
    "dist/**",
    "generated/**",
    "out/**",
    "build/**",
    "coverage/**",
  ]);
}

async function shouldAllowJs(repoPath: string): Promise<boolean> {
  const state = {
    hasTypeScriptFile: false,
    hasJavaScriptFile: false,
    visitedFiles: 0,
  };
  await visitSourceTree(repoPath, state);
  return !state.hasTypeScriptFile && state.hasJavaScriptFile;
}

async function visitSourceTree(
  directory: string,
  state: { hasTypeScriptFile: boolean; hasJavaScriptFile: boolean; visitedFiles: number },
): Promise<void> {
  if (state.hasTypeScriptFile || state.visitedFiles > 1_000) {
    return;
  }
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (state.hasTypeScriptFile || state.visitedFiles > 1_000) {
      return;
    }
    const childPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredInferenceDirectories.has(entry.name)) {
        await visitSourceTree(childPath, state);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    state.visitedFiles += 1;
    const lowerName = entry.name.toLowerCase();
    if (typescriptInferenceExtensions.some((extension) => lowerName.endsWith(extension))) {
      state.hasTypeScriptFile = true;
      return;
    }
    if (javascriptInferenceExtensions.some((extension) => lowerName.endsWith(extension))) {
      state.hasJavaScriptFile = true;
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function pathStat(path: string) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

async function cleanupPreparedScipProject(project: PreparedScipProject): Promise<void> {
  try {
    await project.cleanup();
  } catch {
    // Scratch cleanup should not hide the SCIP result.
  }
}

function absoluteGlobs(root: string, patterns: string[]): string[] {
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "");
  return patterns.map((pattern) => `${normalizedRoot}/${pattern}`);
}

const ignoredInferenceDirectories = new Set([
  ".git",
  "node_modules",
  "bower_components",
  "jspm_packages",
  "dist",
  "out",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".yarn",
  "__generated__",
  "generated",
]);

const typescriptInferenceExtensions = [".ts", ".tsx", ".mts", ".cts"];
const javascriptInferenceExtensions = [".js", ".jsx", ".mjs", ".cjs"];

async function outputFileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function appendBounded(current: string, chunk: string, maxBytes: number): string {
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf8") <= maxBytes) {
    return next;
  }
  return truncateUtf8Bytes(next, maxBytes);
}

function resolveScipTypescriptBin(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return join(currentDir, "..", "..", "node_modules", ".bin", "scip-typescript");
}
