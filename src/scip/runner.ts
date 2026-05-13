import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

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
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export async function runScipTypescript(
  input: RunScipTypescriptInput,
): Promise<RunScipTypescriptResult> {
  await mkdir(dirname(input.outputPath), { recursive: true });
  const args = [
    "index",
    "--cwd",
    input.repoPath,
    "--output",
    input.outputPath,
    "--no-progress-bar",
  ];
  if (input.inferTsconfig) {
    args.push("--infer-tsconfig");
  }

  return new Promise((resolvePromise, rejectPromise) => {
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
      rejectPromise(error);
    });
    child.on("close", async (exitCode) => {
      clearTimeout(timeout);
      if (hardKillTimeout) clearTimeout(hardKillTimeout);
      const scipSize = await outputFileSize(input.outputPath);
      if (scipSize > maxScipBytes) {
        await rm(input.outputPath, { force: true });
        resolvePromise({
          ok: false,
          outputPath: input.outputPath,
          stdout,
          stderr: appendBounded(
            stderr,
            `\nscip-typescript output file exceeded ${maxScipBytes} bytes`,
            maxOutputBytes,
          ),
          exitCode,
        });
        return;
      }
      resolvePromise({
        ok: exitCode === 0 && !timedOut,
        outputPath: input.outputPath,
        stdout,
        stderr: timedOut ? appendBounded(stderr, `\nscip-typescript timed out after ${timeoutMs}ms`, maxOutputBytes) : stderr,
        exitCode,
      });
    });
  });
}

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
