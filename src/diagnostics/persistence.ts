import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveActiveGenerationPath, writeJsonAtomically } from "../core/index-artifacts.js";
import { IndexDiagnosticsSchema } from "./schema.js";
import type { IndexDiagnostics } from "./types.js";

export async function writeIndexDiagnostics(generationPath: string, diagnostics: IndexDiagnostics): Promise<void> {
  const factsPath = join(generationPath, "facts");
  await mkdir(factsPath, { recursive: true });
  await writeJsonAtomically(join(factsPath, "diagnostics.json"), IndexDiagnosticsSchema.parse(diagnostics));
}

export async function readActiveIndexDiagnostics(indexPath: string): Promise<IndexDiagnostics | undefined> {
  const generationPath = await resolveActiveGenerationPath(indexPath);
  if (!generationPath) {
    return undefined;
  }
  try {
    return IndexDiagnosticsSchema.parse(
      JSON.parse(await readFile(join(generationPath, "facts", "diagnostics.json"), "utf8")),
    );
  } catch {
    return undefined;
  }
}
