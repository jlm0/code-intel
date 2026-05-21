import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";

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
  await writeJsonFile(tempPath, value);
  await rename(tempPath, path);
}

export async function writeJsonObjectWithArrayEntriesAtomically(
  path: string,
  objectPrefix: Record<string, unknown>,
  arrayKey: string,
  entries: AsyncIterable<unknown> | Iterable<unknown>,
): Promise<void> {
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeJsonObjectWithArrayEntriesFile(tempPath, objectPrefix, arrayKey, entries);
  await rename(tempPath, path);
}

export async function writeJsonFile(path: string, data: unknown): Promise<void> {
  const stream = createWriteStream(path, { encoding: "utf8" });
  try {
    await writeJsonValue(stream, data, 0);
    await writeChunk(stream, "\n");
    stream.end();
    await finished(stream);
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

async function writeJsonObjectWithArrayEntriesFile(
  path: string,
  objectPrefix: Record<string, unknown>,
  arrayKey: string,
  entries: AsyncIterable<unknown> | Iterable<unknown>,
): Promise<void> {
  const stream = createWriteStream(path, { encoding: "utf8" });
  try {
    await writeChunk(stream, "{\n");
    const prefixEntries = Object.entries(objectPrefix).filter(([, entry]) => shouldSerializeObjectEntry(entry));
    for (const [key, entry] of prefixEntries) {
      await writeChunk(stream, `${indent(1)}${JSON.stringify(key)}: `);
      await writeJsonValue(stream, entry, 1);
      await writeChunk(stream, ",\n");
    }
    await writeChunk(stream, `${indent(1)}${JSON.stringify(arrayKey)}: [`);
    let index = 0;
    for await (const entry of entries) {
      await writeChunk(stream, index === 0 ? "\n" : ",\n");
      await writeChunk(stream, indent(2));
      await writeJsonValue(stream, entry, 2);
      index += 1;
    }
    await writeChunk(stream, index === 0 ? "]\n" : `\n${indent(1)}]\n`);
    await writeChunk(stream, "}\n");
    stream.end();
    await finished(stream);
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

async function writeJsonValue(stream: Writable, data: unknown, depth: number): Promise<void> {
  if (data === null || typeof data !== "object") {
    await writeChunk(stream, JSON.stringify(serializablePrimitive(data)));
    return;
  }
  if (Array.isArray(data)) {
    await writeJsonArray(stream, data, depth);
    return;
  }
  await writeJsonObject(stream, data as Record<string, unknown>, depth);
}

async function writeJsonArray(stream: Writable, items: unknown[], depth: number): Promise<void> {
  if (items.length === 0) {
    await writeChunk(stream, "[]");
    return;
  }
  await writeChunk(stream, "[\n");
  for (let index = 0; index < items.length; index += 1) {
    await writeChunk(stream, `${indent(depth + 1)}`);
    await writeJsonValue(stream, items[index] === undefined ? null : items[index], depth + 1);
    await writeChunk(stream, index === items.length - 1 ? "\n" : ",\n");
  }
  await writeChunk(stream, `${indent(depth)}]`);
}

async function writeJsonObject(stream: Writable, data: Record<string, unknown>, depth: number): Promise<void> {
  const entries = Object.entries(data).filter(([, entry]) => shouldSerializeObjectEntry(entry));
  if (entries.length === 0) {
    await writeChunk(stream, "{}");
    return;
  }
  await writeChunk(stream, "{\n");
  for (let index = 0; index < entries.length; index += 1) {
    const [key, entry] = entries[index]!;
    await writeChunk(stream, `${indent(depth + 1)}${JSON.stringify(key)}: `);
    await writeJsonValue(stream, entry, depth + 1);
    await writeChunk(stream, index === entries.length - 1 ? "\n" : ",\n");
  }
  await writeChunk(stream, `${indent(depth)}}`);
}

function shouldSerializeObjectEntry(data: unknown): boolean {
  return data !== undefined && typeof data !== "function" && typeof data !== "symbol";
}

function serializablePrimitive(data: unknown): unknown {
  if (typeof data === "number" && !Number.isFinite(data)) {
    return null;
  }
  if (typeof data === "bigint") {
    throw new TypeError("Do not know how to serialize a BigInt");
  }
  if (typeof data === "undefined" || typeof data === "function" || typeof data === "symbol") {
    return null;
  }
  return data;
}

function indent(depth: number): string {
  return "  ".repeat(depth);
}

async function writeChunk(stream: Writable, chunk: string): Promise<void> {
  if (!stream.write(chunk)) {
    await once(stream, "drain");
  }
}
