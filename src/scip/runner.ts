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
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxScipBytes?: number;
}

export interface RunScipTypescriptResult {
  ok: boolean;
  outputPath: string;
  outputBytes: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export async function runScipTypescript(
  input: RunScipTypescriptInput,
): Promise<RunScipTypescriptResult> {
  await mkdir(dirname(input.outputPath), { recursive: true });
  const preparedProject = await prepareScipProject(input);
  const args = [
    "index",
    "--cwd",
    input.repoPath,
    "--output",
    input.outputPath,
    "--no-progress-bar",
    ...preparedProject.projects,
  ];

  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = performance.now();
    const timeoutMs = input.timeoutMs ?? 120_000;
    const maxOutputBytes = input.maxOutputBytes ?? 128_000;
    const maxScipBytes = input.maxScipBytes ?? 128_000_000;
    const child = spawn(resolveScipTypescriptBin(), args, {
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
    child.on("close", async (exitCode) => {
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
        timedOut,
      });
    });
  });
}

interface PreparedScipProject {
  projects: string[];
  cleanup(): Promise<void>;
}

async function prepareScipProject(input: RunScipTypescriptInput): Promise<PreparedScipProject> {
  if (!input.inferTsconfig || await pathExists(join(input.repoPath, "tsconfig.json"))) {
    return { projects: [], cleanup: async () => {} };
  }

  const scratchRoot = await mkdtemp(join(dirname(input.outputPath), "scip-infer-"));
  const configPath = join(scratchRoot, "tsconfig.json");
  const inferredConfig = await inferredTsconfig(input.repoPath);
  await writeFile(configPath, `${JSON.stringify(inferredConfig, null, 2)}\n`);
  return {
    projects: [configPath],
    cleanup: () => rm(scratchRoot, { recursive: true, force: true }),
  };
}

async function inferredTsconfig(repoPath: string): Promise<Record<string, unknown>> {
  const allowJs = await shouldAllowJs(repoPath);
  const include = [
    ...absoluteGlobs(repoPath, ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"]),
    ...(allowJs ? absoluteGlobs(repoPath, ["**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"]) : []),
  ];
  const compilerOptions: Record<string, unknown> = allowJs ? { allowJs: true, checkJs: false } : {};
  return {
    compilerOptions,
    include,
    exclude: absoluteGlobs(repoPath, [
      "node_modules/**",
      "bower_components/**",
      "jspm_packages/**",
      ".git/**",
      "dist/**",
      "out/**",
      "build/**",
      "coverage/**",
    ]),
  };
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
