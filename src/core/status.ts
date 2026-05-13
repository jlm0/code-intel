import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { IndexManifestSchema, schemaVersion } from "../schema/schemas.js";
import { createRuntimeContext, type RuntimeOptions } from "./context.js";

export async function getStatus(options: RuntimeOptions): Promise<unknown> {
  const context = createRuntimeContext(options);
  const manifestPath = await resolveActiveManifestPath(context.indexPath);

  try {
    const manifest = IndexManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
    return {
      schemaVersion,
      indexed: true,
      indexPath: context.indexPath,
      manifest,
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw error;
    }
    return {
      schemaVersion,
      indexed: false,
      indexPath: context.indexPath,
      manifestPath,
      repos: [],
    };
  }
}

async function resolveActiveManifestPath(indexPath: string): Promise<string> {
  try {
    const pointer = JSON.parse(await readFile(join(indexPath, "current.json"), "utf8")) as {
      databasePath?: unknown;
    };
    if (typeof pointer.databasePath === "string" && pointer.databasePath.length > 0) {
      return join(dirname(resolve(indexPath, pointer.databasePath)), "manifest.json");
    }
  } catch {
    return join(indexPath, "manifest.json");
  }
  return join(indexPath, "manifest.json");
}
