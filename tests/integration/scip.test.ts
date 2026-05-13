import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ingestScipIndex } from "../../src/scip/ingest.js";
import { runScipTypescript } from "../../src/scip/runner.js";

const fixturePath = new URL("../fixtures/js-ts-workspace", import.meta.url).pathname;

describe("SCIP integration", () => {
  it("runs scip-typescript and ingests definitions and references", async () => {
    const tempPath = await mkdtemp(join(tmpdir(), "code-intel-scip-"));
    try {
      const outputPath = join(tempPath, "fixture.scip");
      const run = await runScipTypescript({
        repoPath: fixturePath,
        outputPath,
        inferTsconfig: true,
      });
      expect(run.ok).toBe(true);
      expect(run.outputPath).toBe(outputPath);

      const facts = await ingestScipIndex(outputPath);
      expect(facts.definitions.map((definition) => definition.name)).toContain(
        "calculateGivingTotal",
      );
      expect(facts.references.some((reference) => reference.symbolName === "calculateGivingTotal")).toBe(true);
    } finally {
      await rm(tempPath, { recursive: true, force: true });
    }
  });
});
