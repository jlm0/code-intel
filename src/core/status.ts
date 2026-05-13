import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { CliOptions } from "../cli/program.js";
import { IndexManifestSchema, schemaVersion } from "../schema/schemas.js";
import { createRuntimeContext } from "./context.js";

export async function getStatus(options: CliOptions): Promise<unknown> {
  const context = createRuntimeContext(options);
  const manifestPath = join(context.indexPath, "manifest.json");

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
