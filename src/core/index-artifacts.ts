import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { IndexManifestSchema, type IndexManifest } from "../schema/schemas.js";

export interface ActiveIndexSnapshot {
  generationId?: string;
  generationPath?: string;
  databasePath: string;
  manifestPath: string;
  manifest?: IndexManifest;
}

export async function resolveActiveGenerationPath(indexPath: string): Promise<string | undefined> {
  return (await resolveActiveIndexSnapshot(indexPath)).generationPath;
}

export async function resolveActiveManifestPath(indexPath: string): Promise<string> {
  return (await resolveActiveIndexSnapshot(indexPath)).manifestPath;
}

export async function readActiveManifest(indexPath: string): Promise<IndexManifest | undefined> {
  return (await resolveActiveIndexSnapshot(indexPath)).manifest;
}

export async function resolveActiveIndexSnapshot(indexPath: string): Promise<ActiveIndexSnapshot> {
  const pointer = await readActivePointer(indexPath);
  const databasePath = pointer?.databasePath
    ? resolve(indexPath, pointer.databasePath)
    : join(indexPath, "code-intel.lbug");
  const generationPath = pointer?.databasePath ? dirname(databasePath) : undefined;
  const manifestPath = generationPath ? join(generationPath, "manifest.json") : join(indexPath, "manifest.json");

  return {
    generationId: pointer?.generationId,
    generationPath,
    databasePath,
    manifestPath,
    manifest: await readManifestAtPath(manifestPath),
  };
}

async function readActivePointer(indexPath: string): Promise<{ generationId?: string; databasePath?: string } | undefined> {
  try {
    const pointer = JSON.parse(await readFile(join(indexPath, "current.json"), "utf8")) as {
      generationId?: unknown;
      databasePath?: unknown;
    };
    if (typeof pointer.databasePath === "string" && pointer.databasePath.length > 0) {
      return {
        generationId: typeof pointer.generationId === "string" ? pointer.generationId : undefined,
        databasePath: pointer.databasePath,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function readManifestAtPath(manifestPath: string): Promise<IndexManifest | undefined> {
  try {
    return IndexManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  } catch {
    return undefined;
  }
}

export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tempPath, path);
}
