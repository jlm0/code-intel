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
        const fixtureClientSymbol = nodes.find(
          (node) =>
            node.kind === "Symbol" &&
            node.name === "fixtureClient" &&
            node.file === "packages/core/src/client.ts",
        );
        const clientConsumerSymbol = nodes.find(
          (node) =>
            node.kind === "Function" &&
            node.name === "createReceiptViaClient" &&
            node.file === "packages/core/src/clientConsumer.ts",
        );
        const clientCreateSymbol = nodes.find(
          (node) =>
            node.kind === "Function" &&
            node.name === "create" &&
            node.file === "packages/core/src/client.ts" &&
            node.metadata.qualifiedName === "fixtureClient.receipt.create",
        );
        const defaultWriterSymbol = nodes.find(
          (node) =>
            node.kind === "Class" &&
            node.name === "DefaultReceiptWriter" &&
            node.file === "packages/core/src/types.ts",
        );
        const baseWriterSymbol = nodes.find(
          (node) =>
            node.kind === "Class" &&
            node.name === "BaseReceiptWriter" &&
            node.file === "packages/core/src/types.ts",
        );
        const receiptWriterSymbol = nodes.find(
          (node) =>
            node.kind === "Interface" &&
            node.name === "ReceiptWriter" &&
            node.file === "packages/core/src/types.ts",
        );
        const envelopeFactorySymbol = nodes.find(
          (node) =>
            node.kind === "Function" &&
            node.name === "createReceiptEnvelope" &&
            node.file === "packages/core/src/types.ts",
        );
        const envelopeTypeSymbol = nodes.find(
          (node) =>
            node.kind === "TypeAlias" &&
            node.name === "ReceiptEnvelope" &&
            node.file === "packages/core/src/types.ts",
        );
        const configReaderSymbol = nodes.find(
          (node) =>
            node.kind === "Function" &&
            node.name === "readWebhookSecret" &&
            node.file === "packages/core/src/config.ts",
        );
        const barrelSummarySymbol = nodes.find(
          (node) =>
            node.kind === "Function" &&
            node.name === "useBarrelSummary" &&
            node.file === "packages/ui/src/useBarrelSummary.tsx",
        );
        const calculateGivingTotalSymbol = nodes.find(
          (node) =>
            node.kind === "Function" &&
            node.name === "calculateGivingTotal" &&
            node.file === "packages/core/src/tithe.ts",
        );
        const pageSymbol = nodes.find(
          (node) =>
            node.kind === "Function" &&
            node.name === "Page" &&
            node.file === "packages/ui/src/app/poll/[id]/page.tsx",
        );
        const adminLoaderSymbol = nodes.find(
          (node) =>
            node.kind === "Function" &&
            node.name === "AdminPageLoader" &&
            node.file === "packages/ui/src/app/poll/[id]/admin-page-loader.tsx",
        );
        const routeFile = nodes.find(
          (node) => node.kind === "File" && node.file === "packages/core/src/httpRoute.ts",
        );
        const receiptRoutesSymbol = nodes.find(
          (node) =>
            node.kind === "Function" &&
            node.name === "receiptRoutes" &&
            node.file === "packages/core/src/httpRoute.ts",
        );
        const fetchReceiptSymbol = nodes.find(
          (node) =>
            node.kind === "Function" &&
            node.name === "fetchReceipt" &&
            node.file === "packages/core/src/apiClient.ts",
        );
        const fetchCallsite = nodes.find(
          (node) =>
            node.kind === "Callsite" &&
            node.name === "fetch" &&
            node.file === "packages/core/src/apiClient.ts" &&
            node.metadata.relationship === "api-client",
        );
        const webhookSecretSymbol = nodes.find(
          (node) =>
            node.kind === "Symbol" &&
            node.name === "WEBHOOK_SECRET" &&
            node.metadata.relationship === "config-env",
        );

        expect(uiFile).toBeDefined();
        expect(barrelFile).toBeDefined();
        expect(defaultSymbol).toBeDefined();
        expect(legacySymbol).toBeDefined();
        expect(fixtureClientSymbol).toBeDefined();
        expect(clientConsumerSymbol).toBeDefined();
        expect(clientCreateSymbol).toBeDefined();
        expect(defaultWriterSymbol).toBeDefined();
        expect(baseWriterSymbol).toBeDefined();
        expect(receiptWriterSymbol).toBeDefined();
        expect(envelopeFactorySymbol).toBeDefined();
        expect(envelopeTypeSymbol).toBeDefined();
        expect(configReaderSymbol).toBeDefined();
        expect(barrelSummarySymbol).toBeDefined();
        expect(calculateGivingTotalSymbol).toBeDefined();
        expect(pageSymbol).toBeDefined();
        expect(adminLoaderSymbol).toBeDefined();
        expect(routeFile).toBeDefined();
        expect(receiptRoutesSymbol).toBeDefined();
        expect(fetchReceiptSymbol).toBeDefined();
        expect(fetchCallsite).toBeDefined();
        expect(webhookSecretSymbol).toBeDefined();

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
        expect(
          edges.some(
            (edge) =>
              edge.kind === "CALLS" &&
              edge.fromId === clientConsumerSymbol!.id &&
              edge.toId === fixtureClientSymbol!.id &&
              edge.metadata.moduleSpecifier === "./client",
          ),
        ).toBe(true);
        expect(edges).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "CALLS",
              fromId: clientConsumerSymbol!.id,
              toId: clientCreateSymbol!.id,
              metadata: expect.objectContaining({
                relationship: "member-call",
                memberPath: "fixtureClient.receipt.create",
                evidenceSources: expect.arrayContaining(["module-resolution", "tree-sitter-member-call"]),
              }),
            }),
            expect.objectContaining({
              kind: "REFERENCES",
              fromId: clientConsumerSymbol!.id,
              toId: clientCreateSymbol!.id,
              metadata: expect.objectContaining({
                relationship: "property-access",
                memberPath: "fixtureClient.receipt.create",
                evidenceSources: expect.arrayContaining(["tree-sitter-member-access", "property-access"]),
              }),
            }),
            expect.objectContaining({
              kind: "CALLS",
              fromId: barrelSummarySymbol!.id,
              toId: calculateGivingTotalSymbol!.id,
              metadata: expect.objectContaining({
                relationshipTags: expect.arrayContaining(["package-boundary"]),
                evidenceSources: expect.arrayContaining(["module-resolution", "package-boundary"]),
              }),
            }),
            expect.objectContaining({
              kind: "CALLS",
              fromId: pageSymbol!.id,
              toId: adminLoaderSymbol!.id,
              metadata: expect.objectContaining({
                relationshipTags: expect.arrayContaining(["loader-action", "framework-convention"]),
                evidenceSources: expect.arrayContaining(["loader-action", "framework-convention"]),
              }),
            }),
            expect.objectContaining({
              kind: "DEFINES",
              fromId: routeFile!.id,
              toId: receiptRoutesSymbol!.id,
              metadata: expect.objectContaining({
                relationship: "route-handler",
                relationshipTags: expect.arrayContaining(["route-handler", "framework-convention"]),
                evidenceSources: expect.arrayContaining(["route-handler", "framework-convention"]),
              }),
            }),
            expect.objectContaining({
              kind: "CALLS",
              fromId: fetchReceiptSymbol!.id,
              toId: fetchCallsite!.id,
              metadata: expect.objectContaining({
                relationship: "api-client",
                unresolved: true,
                fallbackReason: "runtime-api-target-unresolved",
                evidenceSources: expect.arrayContaining(["tree-sitter-call", "api-client"]),
              }),
            }),
            expect.objectContaining({
              kind: "EXTENDS",
              fromId: defaultWriterSymbol!.id,
              toId: baseWriterSymbol!.id,
              metadata: expect.objectContaining({
                relationship: "extends",
                confidence: "high",
                evidenceSources: expect.arrayContaining(["scip-typescript"]),
              }),
            }),
            expect.objectContaining({
              kind: "IMPLEMENTS",
              fromId: defaultWriterSymbol!.id,
              toId: receiptWriterSymbol!.id,
              metadata: expect.objectContaining({
                relationship: "implements",
                confidence: "high",
                evidenceSources: expect.arrayContaining(["scip-typescript"]),
              }),
            }),
            expect.objectContaining({
              kind: "REFERENCES",
              fromId: envelopeFactorySymbol!.id,
              toId: envelopeTypeSymbol!.id,
              metadata: expect.objectContaining({
                relationship: "type-use",
                evidenceSources: expect.arrayContaining(["scip-typescript", "type-use"]),
              }),
            }),
            expect.objectContaining({
              kind: "REFERENCES",
              fromId: configReaderSymbol!.id,
              toId: webhookSecretSymbol!.id,
              metadata: expect.objectContaining({
                relationship: "config-env",
                envName: "WEBHOOK_SECRET",
                confidence: "medium",
                evidenceSources: expect.arrayContaining(["tree-sitter-member-access", "config-env"]),
              }),
            }),
          ]),
        );
      } finally {
        await store.close();
      }
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });
});
