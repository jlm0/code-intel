import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ingestScipIndex } from "../../src/scip/ingest.js";
import { runScipTypescript } from "../../src/scip/runner.js";

const fixturePath = new URL("../fixtures/js-ts-workspace", import.meta.url).pathname;

describe("SCIP integration", () => {
  it("runs scip-typescript and ingests role-aware occurrence facts", async () => {
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
      expect(facts.definitions.map((definition) => definition.name)).toContain(
        "calculateVariableGivingTotal",
      );
      expect(facts.references.some((reference) => reference.symbolName === "calculateGivingTotal")).toBe(true);
      expect(facts.occurrences).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            symbolName: "calculateGivingTotal",
            relativePath: "packages/core/src/ledger.ts",
            roles: expect.arrayContaining(["ReadAccess"]),
          }),
          expect.objectContaining({
            symbolName: "GivingSummary",
            relativePath: "packages/ui/src/useGivingSummary.tsx",
            roles: expect.arrayContaining(["ReadAccess"]),
          }),
          expect.objectContaining({
            symbolName: "calculateGivingTotal",
            relativePath: "packages/core/src/tithe.test.ts",
            roles: expect.arrayContaining(["ReadAccess"]),
            isTest: true,
          }),
        ]),
      );
      expect(
        facts.occurrences
          .filter((occurrence) => occurrence.symbol.startsWith("local "))
          .every((occurrence) => occurrence.symbol.includes(occurrence.relativePath)),
      ).toBe(true);
      expect(facts.references).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            symbolName: "calculateGivingTotal",
            relativePath: "packages/core/src/ledger.ts",
            roles: expect.arrayContaining(["ReadAccess"]),
          }),
        ]),
      );
    } finally {
      await rm(tempPath, { recursive: true, force: true });
    }
  });
});
