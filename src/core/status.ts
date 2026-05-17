import { readFile } from "node:fs/promises";

import { resolveActiveManifestPath } from "./index-artifacts.js";
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
