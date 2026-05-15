import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveActiveGenerationPath } from "../../src/core/index-artifacts.js";
import { LadybugGraphStore } from "../../src/graph/ladybug-store.js";
import { indexWorkspace } from "../../src/indexer/indexer.js";

const fixturePath = new URL("../fixtures/js-ts-workspace", import.meta.url).pathname;

describe("fusion module resolution", () => {
  it("persists resolved import/export facts and emits resolver-backed graph edges", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-fusion-resolution-"));
    try {
      await indexWorkspace({
        workspaceRoot: fixturePath,
        repoPaths: [fixturePath],
        indexPath,
        embeddingProviderName: "hash",
      });

      const generationPath = await resolveActiveGenerationPath(indexPath);
      expect(generationPath).toBeDefined();
      const resolutionFacts = JSON.parse(
        await readFile(join(generationPath!, "facts", "resolution.json"), "utf8"),
      ) as {
        factsSchemaVersion: string;
        repos: Array<{
          imports: Array<Record<string, unknown>>;
          exports: Array<Record<string, unknown>>;
          packageExports: Array<Record<string, unknown>>;
        }>;
      };
      const repoFacts = resolutionFacts.repos[0]!;

      expect(resolutionFacts.factsSchemaVersion).toBe("code-intel.resolved-facts.v1");
      expect(repoFacts.imports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            importerFile: "packages/ui/src/useBarrelSummary.tsx",
            moduleSpecifier: "@fixture/core/barrel",
            status: "resolved",
            targetFile: "packages/core/src/barrel.ts",
            targetPackage: "@fixture/core",
            importedName: "calculateTotalAlias",
            localName: "calculateTotalAlias",
          }),
          expect.objectContaining({
            importerFile: "packages/ui/src/useBarrelSummary.tsx",
            moduleSpecifier: "@fixture/core/default-tool",
            status: "resolved",
            targetFile: "packages/core/src/internal/defaultTool.ts",
            targetSymbolName: "buildDefaultReceipt",
            importedName: "default",
            localName: "buildDefaultReceipt",
          }),
          expect.objectContaining({
            importerFile: "packages/core/src/aliasConsumer.ts",
            moduleSpecifier: "@fixture/alias/tithe",
            status: "resolved",
            targetFile: "packages/core/src/tithe.ts",
            resolutionSource: "typescript-paths",
          }),
          expect.objectContaining({
            importerFile: "packages/core/src/commonjsConsumer.ts",
            moduleSpecifier: "@fixture/legacy",
            status: "resolved",
            targetFile: "packages/legacy/src/legacy.js",
            importKind: "commonjs",
            importedName: "createContributionSchedule",
          }),
          expect.objectContaining({
            importerFile: "packages/core/src/dynamicLoader.ts",
            moduleSpecifier: "@fixture/core/default-tool",
            status: "resolved",
            targetFile: "packages/core/src/internal/defaultTool.ts",
            importKind: "dynamic",
          }),
          expect.objectContaining({
            importerFile: "packages/core/src/unresolvedImport.ts",
            moduleSpecifier: "missing-package",
            status: "unresolved",
            fallbackReason: "unresolved-module",
          }),
        ]),
      );
      expect(repoFacts.packageExports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            packageName: "@fixture/core",
            exportName: "./barrel",
            status: "resolved",
            targetFile: "packages/core/src/barrel.ts",
          }),
          expect.objectContaining({
            packageName: "@fixture/core",
            exportName: "./default-tool",
            status: "resolved",
            targetFile: "packages/core/src/internal/defaultTool.ts",
          }),
        ]),
      );

      const store = new LadybugGraphStore(indexPath);
      try {
        const nodes = await store.getNodes();
        const edges = await store.getEdges();
        const nodeById = new Map(nodes.map((node) => [node.id, node]));
        const uiFile = nodes.find((node) => node.kind === "File" && node.file === "packages/ui/src/useBarrelSummary.tsx");
        const barrelFile = nodes.find((node) => node.kind === "File" && node.file === "packages/core/src/barrel.ts");
        const defaultSymbol = nodes.find(
          (node) =>
            node.kind === "Function" &&
            node.name === "buildDefaultReceipt" &&
            node.file === "packages/core/src/internal/defaultTool.ts",
        );
        const legacySymbol = nodes.find(
          (node) =>
            node.kind === "Function" &&
            node.name === "createContributionSchedule" &&
            node.file === "packages/legacy/src/legacy.js",
        );

        expect(uiFile).toBeDefined();
        expect(barrelFile).toBeDefined();
        expect(defaultSymbol).toBeDefined();
        expect(legacySymbol).toBeDefined();

        expect(edges).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "IMPORTS",
              fromId: uiFile!.id,
              toId: barrelFile!.id,
              metadata: expect.objectContaining({
                moduleSpecifier: "@fixture/core/barrel",
                resolutionSource: expect.any(String),
                evidenceSources: expect.arrayContaining(["tree-sitter-import", "module-resolution"]),
              }),
            }),
            expect.objectContaining({
              kind: "CALLS",
              fromId: uiFile!.id,
              toId: defaultSymbol!.id,
              metadata: expect.objectContaining({
                moduleSpecifier: "@fixture/core/default-tool",
                localName: "buildDefaultReceipt",
                confidence: expect.stringMatching(/high|medium|fallback/),
              }),
            }),
            expect.objectContaining({
              kind: "EXPORTS",
              toId: barrelFile!.id,
              metadata: expect.objectContaining({
                packageName: "@fixture/core",
                exportName: "./barrel",
                origin: "module-resolution",
              }),
            }),
          ]),
        );
        expect(
          edges.some(
            (edge) =>
              edge.kind === "CALLS" &&
              nodeById.get(edge.fromId)?.file === "packages/core/src/commonjsConsumer.ts" &&
              edge.toId === legacySymbol!.id &&
              edge.metadata.importKind === "commonjs",
          ),
        ).toBe(true);
      } finally {
        await store.close();
      }
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });
});
