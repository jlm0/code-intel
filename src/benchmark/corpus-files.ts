import { readdir } from "node:fs/promises";
import { join } from "node:path";

export async function firstSourceFile(repoPaths: string[]): Promise<string> {
  const files = await sourceFiles(repoPaths);
  const file = files.find((candidate) => candidate.endsWith("tithe.ts")) ?? files[0];
  if (!file) {
    throw new Error("Benchmark corpus has no source files to mutate");
  }
  return file;
}

export async function firstDeletableSourceFile(repoPaths: string[], changedFile: string): Promise<string> {
  const file = (await sourceFiles(repoPaths)).find((candidate) => candidate !== changedFile);
  if (!file) {
    throw new Error("Benchmark corpus has no second source file to delete");
  }
  return file;
}

async function sourceFiles(paths: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const path of paths) {
    await collectSourceFiles(path, files);
  }
  return files.sort();
}

async function collectSourceFiles(path: string, files: string[]): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await collectSourceFiles(child, files);
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      files.push(child);
    }
  }
}
