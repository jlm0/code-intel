import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export interface RunScipTypescriptInput {
  repoPath: string;
  outputPath: string;
  inferTsconfig: boolean;
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
    const child = spawn(resolveScipTypescriptBin(), args, {
      cwd: input.repoPath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (exitCode) => {
      resolvePromise({
        ok: exitCode === 0,
        outputPath: input.outputPath,
        stdout,
        stderr,
        exitCode,
      });
    });
  });
}

function resolveScipTypescriptBin(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return join(currentDir, "..", "..", "node_modules", ".bin", "scip-typescript");
}
