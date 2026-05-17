import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveActiveGenerationPath } from "../../src/core/index-artifacts.js";
import { runHealth } from "../../src/core/health.js";
import { LadybugGraphStore } from "../../src/graph/ladybug-store.js";
import { indexWorkspace } from "../../src/indexer/indexer.js";
import { createQueryEngine } from "../../src/query/query-engine.js";

const fixturePath = new URL("../fixtures/js-ts-workspace", import.meta.url).pathname;

describe("index and query integration", () => {
  it("indexes fixtures into a persistent Ladybug graph and answers relationships", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-index-"));
    try {
      const manifest = await indexWorkspace({
        workspaceRoot: fixturePath,
        repoPaths: [fixturePath],
        indexPath,
        embeddingProviderName: "hash",
      });

      expect(manifest.stats.nodes).toBeGreaterThan(0);
      expect(manifest.stats.edges).toBeGreaterThan(0);
      expect(manifest.stats.chunks).toBeGreaterThan(0);
      expect(manifest.embedding.provider).toBe("hash");

      const health = await runHealth({ indexPath, embeddingProvider: "hash" });
      expect((health as { checks: Array<{ name: string; status: string; message: string }> }).checks).toContainEqual(
        expect.objectContaining({
          name: "index-embedding-provider",
          status: "warn",
          message: expect.stringContaining("hash embeddings"),
        }),
      );

      const firstEngine = createQueryEngine({ indexPath });
      try {
        const symbol = await firstEngine.findSymbol("calculateGivingTotal", { limit: 5 });
        expect(symbol.results[0]).toMatchObject({
          kind: "Function",
          file: "packages/core/src/tithe.ts",
          metadata: {
            origin: "scip-typescript",
            scipSymbol: expect.any(String),
            astOrigin: "tree-sitter",
          },
        });
        const totalDefinitions = symbol.results.filter(
          (result) =>
            result.file === "packages/core/src/tithe.ts" &&
            result.symbol?.name === "calculateGivingTotal",
        );
        expect(totalDefinitions).toHaveLength(1);

        const callers = await firstEngine.getCallers("calculateGivingTotal", { limit: 10 });
        expect(callers.results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "packages/core/src/ledger.ts",
              metadata: expect.objectContaining({
                relationship: expect.objectContaining({
                  kind: "CALLS",
                  evidenceSources: expect.arrayContaining(["scip-typescript"]),
                }),
              }),
            }),
          ]),
        );

        const callees = await firstEngine.getCallees("summarize", { limit: 10 });
        expect(callees.results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "packages/core/src/tithe.ts",
              metadata: expect.objectContaining({
                relationship: expect.objectContaining({
                  kind: "CALLS",
                  evidenceSources: expect.arrayContaining(["scip-typescript"]),
                }),
              }),
            }),
          ]),
        );

        const typeReferences = await firstEngine.getReferences("GivingSummary", { limit: 20 });
        expect(typeReferences.results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "packages/ui/src/useGivingSummary.tsx",
              metadata: expect.objectContaining({
                relationship: expect.objectContaining({
                  kind: "REFERENCES",
                  roles: expect.arrayContaining(["Import"]),
                  evidenceSources: expect.arrayContaining(["scip-typescript"]),
                }),
              }),
            }),
          ]),
        );
      } finally {
        await firstEngine.close();
      }

      const generationPath = await resolveActiveGenerationPath(indexPath);
      expect(generationPath).toBeDefined();
      const scipFacts = JSON.parse(
        await readFile(join(generationPath!, "facts", "scip.json"), "utf8"),
      ) as {
        factsSchemaVersion: string;
        repos: Array<{
          name: string;
          definitions: Array<{ name: string; symbol: string }>;
          occurrences: Array<{ symbolName: string; relativePath: string; roles: string[] }>;
        }>;
      };
      expect(scipFacts).toMatchObject({
        factsSchemaVersion: "code-intel.scip-facts.v1",
        repos: [
          expect.objectContaining({
            name: "js-ts-workspace",
          }),
        ],
      });
      expect(scipFacts.repos[0]?.occurrences).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            symbolName: "calculateGivingTotal",
            relativePath: "packages/core/src/ledger.ts",
            roles: expect.arrayContaining(["ReadAccess"]),
          }),
        ]),
      );

      const store = new LadybugGraphStore(indexPath);
      try {
        const nodes = await store.getNodes();
        const edges = await store.getEdges();
        const nodeById = new Map(nodes.map((node) => [node.id, node]));
        const symbolId = nodes.find(
          (node) =>
            node.name === "calculateGivingTotal" &&
            node.file === "packages/core/src/tithe.ts" &&
            node.metadata.scipSymbol,
        )?.id;
        expect(symbolId).toBeDefined();
        const scipEdgesToTotal = edges.filter(
          (edge) =>
            edge.toId === symbolId &&
            Array.isArray(edge.metadata.evidenceSources) &&
            edge.metadata.evidenceSources.includes("scip-typescript"),
        );
        expect(scipEdgesToTotal).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "IMPORTS",
              fromId: expect.stringContaining("packages/core/src/ledger.ts"),
            }),
            expect.objectContaining({
              kind: "EXPORTS",
              fromId: expect.stringContaining("packages/core/src/index.ts"),
            }),
            expect.objectContaining({
              kind: "REFERENCES",
              fromId: expect.stringContaining("packages/core/src/tithe.test.ts"),
            }),
            expect.objectContaining({
              kind: "CALLS",
              fromId: expect.stringContaining("packages/core/src/ledger.ts"),
            }),
            expect.objectContaining({
              kind: "MENTIONS",
              fromId: expect.stringContaining("packages/core/src/ledger.ts"),
            }),
            expect.objectContaining({
              kind: "TESTS",
              fromId: expect.stringContaining("packages/core/src/tithe.test.ts"),
            }),
          ]),
        );
        expect(
          scipEdgesToTotal
            .filter((edge) => edge.kind === "CALLS")
            .flatMap((edge) => edge.metadata.evidenceSources as string[]),
        ).toContain("tree-sitter-call");
        expect(
          scipEdgesToTotal
            .filter((edge) => edge.kind === "TESTS")
            .map((edge) => nodeById.get(edge.fromId)?.file),
        ).toContain("packages/core/src/tithe.test.ts");
        const directTestEdge = scipEdgesToTotal.find(
          (edge) =>
            edge.kind === "TESTS" &&
            nodeById.get(edge.fromId)?.kind === "Test" &&
            nodeById.get(edge.fromId)?.file === "packages/core/src/tithe.test.ts",
        );
        expect(directTestEdge?.metadata).toMatchObject({
          testContext: true,
          testCaseName: "it calculates giving totals",
          testCaseTitle: "calculates giving totals",
          testOwnerFile: "packages/core/src/tithe.test.ts",
          evidenceSources: expect.arrayContaining(["tree-sitter-test"]),
          roles: expect.arrayContaining(["Test"]),
        });
        expect(directTestEdge?.metadata).toHaveProperty("testCaseRange");
        const indirectTargetId = nodes.find(
          (node) =>
            node.kind === "Function" &&
            node.name === "executeCoverageTarget" &&
            node.file === "packages/core/src/indirectCoverage.ts",
        )?.id;
        expect(indirectTargetId).toBeDefined();
        const indirectTestEdge = edges.find(
          (edge) =>
            edge.kind === "TESTS" &&
            edge.toId === indirectTargetId &&
            nodeById.get(edge.fromId)?.file === "packages/core/src/indirectCoverage.test.ts",
        );
        expect(indirectTestEdge?.metadata).toMatchObject({
          testContext: true,
          testLinkKind: "indirect",
          testCaseName: "it covers implementation through helper",
          confidence: "medium",
          evidenceSources: expect.arrayContaining(["test-linking-indirect", "tree-sitter-test"]),
          roles: expect.arrayContaining(["Test"]),
        });
        expect(indirectTestEdge?.metadata.traversalPath).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "CALLS",
            }),
          ]),
        );
        const orphanTestNodeId = nodes.find(
          (node) =>
            node.kind === "Test" &&
            node.file === "packages/core/src/orphanCoverage.test.ts",
        )?.id;
        const orphanSourceFileId = nodes.find(
          (node) =>
            node.kind === "File" &&
            node.file === "packages/core/src/orphanCoverage.ts",
        )?.id;
        expect(orphanTestNodeId).toBeDefined();
        expect(orphanSourceFileId).toBeDefined();
        expect(edges).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "TESTS",
              fromId: orphanTestNodeId,
              toId: orphanSourceFileId,
              metadata: expect.objectContaining({
                testContext: true,
                testLinkKind: "colocated-fallback",
                fallbackReason: "colocated-test-source-name",
                confidence: "fallback",
                evidenceSources: expect.arrayContaining(["colocated-test-name", "tree-sitter-test"]),
              }),
            }),
          ]),
        );
        expect(edges).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "TESTS",
              fromId: orphanTestNodeId,
              toId: expect.stringContaining("duplicateMethods.ts"),
            }),
          ]),
        );
        const nextLayout = nodes.find(
          (node) => node.kind === "File" && node.file === "packages/ui/src/app/poll/[id]/layout.tsx",
        );
        const nextLoader = nodes.find(
          (node) => node.kind === "File" && node.file === "packages/ui/src/app/poll/[id]/admin-page-loader.tsx",
        );
        expect(nextLayout).toBeDefined();
        expect(nextLoader).toBeDefined();
        expect(edges).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "REFERENCES",
              fromId: nextLoader!.id,
              toId: nextLayout!.id,
              metadata: expect.objectContaining({
                origin: "next-app-router",
                evidenceSources: expect.arrayContaining(["next-app-router", "file-convention"]),
              }),
            }),
          ]),
        );
      } finally {
        await store.close();
      }

      const secondEngine = createQueryEngine({ indexPath });
      try {
        const semantic = await secondEngine.semanticSearch("giving receipt summary", {
          limit: 5,
        });
        expect(semantic.results.length).toBeGreaterThan(0);
        expect(semantic.results.some((result) => result.file?.includes("tithe.ts"))).toBe(true);
        expect(semantic.results[0]?.metadata).not.toHaveProperty("content");
        expect(semantic.results[0]?.metadata.ranking).toMatchObject({
          intent: expect.any(String),
          score: expect.any(Number),
          reasons: expect.arrayContaining([
            expect.objectContaining({
              signal: expect.any(String),
              weight: expect.any(Number),
            }),
          ]),
        });

        const implementationIntent = await secondEngine.semanticSearch("calculate giving total implementation", {
          limit: 10,
        });
        expect(implementationIntent.results[0]).toMatchObject({
          file: "packages/core/src/tithe.ts",
          symbol: {
            name: "calculateGivingTotal",
          },
        });
        expect(implementationIntent.results[0]?.matchedSignals).toEqual(
          expect.arrayContaining(["intent_implementation", "symbol_exact", "graph_calls"]),
        );
        expect(implementationIntent.results[0]?.metadata.ranking).toMatchObject({
          intent: "implementation",
          demotions: expect.any(Array),
          fusion: expect.objectContaining({
            rank: expect.any(Number),
          }),
        });

        const testIntent = await secondEngine.semanticSearch("tests calculate giving totals", {
          limit: 10,
        });
        expect(testIntent.results[0]?.file).toBe("packages/core/src/tithe.test.ts");
        expect(testIntent.results[0]?.matchedSignals).toEqual(expect.arrayContaining(["intent_test"]));

        const packageFilteredSemantic = await secondEngine.semanticSearch("giving receipt summary", {
          limit: 5,
          packageName: "@fixture/ui",
        });
        expect(packageFilteredSemantic.results.length).toBeGreaterThan(0);
        expect(packageFilteredSemantic.results.every((result) => result.packageName === "@fixture/ui")).toBe(true);

        const testFilteredSemantic = await secondEngine.semanticSearch("calculates giving totals", {
          limit: 5,
          fileKind: "test",
        });
        expect(testFilteredSemantic.results.length).toBeGreaterThan(0);
        expect(testFilteredSemantic.results.every((result) => result.metadata.fileKind === "test")).toBe(true);

        const context = await secondEngine.getContext(semantic.results[0]!.id, { limit: 1 });
        expect(context.results[0]?.excerpt).toMatch(/giving/i);

        const expanded = await secondEngine.expandContext(semantic.results[0]!.id, {
          depth: 1,
          limit: 10,
        });
        expect(expanded.results.length).toBeGreaterThan(0);

        const summarize = await secondEngine.findSymbol("summarize", { limit: 1 });
        const calculate = await secondEngine.findSymbol("calculateGivingTotal", { limit: 1 });
        const path = await secondEngine.tracePath(
          summarize.results[0]!.id,
          calculate.results[0]!.id,
          { limit: 10 },
        );
        expect(path.results.map((result) => result.id)).toContain(calculate.results[0]!.id);
        expect(path.results.some((result) => Array.isArray(result.metadata.pathEdges))).toBe(true);

        const nextPage = await secondEngine.findSymbol("Page", { limit: 10 });
        const nextLayout = await secondEngine.findSymbol("PollLayout", { limit: 10 });
        const nextRoutePath = await secondEngine.tracePath(
          nextPage.results.find((result) => result.file === "packages/ui/src/app/poll/[id]/page.tsx")!.id,
          nextLayout.results.find((result) => result.file === "packages/ui/src/app/poll/[id]/layout.tsx")!.id,
          { limit: 10, allowedEdgeKinds: ["CALLS", "REFERENCES", "IMPORTS"], direction: "either" },
        );
        expect(nextRoutePath.results.map((result) => result.file)).toEqual(
          expect.arrayContaining([
            "packages/ui/src/app/poll/[id]/admin-page-loader.tsx",
            "packages/ui/src/app/poll/[id]/layout.tsx",
          ]),
        );

        const renderMethods = await secondEngine.findSymbol("render", { limit: 10 });
        const duplicateMethodResults = renderMethods.results.filter(
          (result) =>
            result.file === "packages/core/src/duplicateMethods.ts" &&
            result.kind === "Function" &&
            result.symbol?.name === "render",
        );
        expect(duplicateMethodResults).toHaveLength(2);
        expect(new Set(duplicateMethodResults.map((result) => result.id)).size).toBe(2);
      } finally {
        await secondEngine.close();
      }

      const mismatchedEngine = createQueryEngine({
        indexPath,
        embeddingProviderName: "jina",
      });
      try {
        await expect(
          mismatchedEngine.semanticSearch("giving receipt summary", { limit: 1 }),
        ).rejects.toThrow(/Embedding provider mismatch/);
      } finally {
        await mismatchedEngine.close();
      }
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });

  it("links excluded tests, ESM .js imports, helper references, and injected service member calls", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "code-intel-realworld-relationships-"));
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-realworld-index-"));
    try {
      await mkdir(join(repoPath, "src", "app"), { recursive: true });
      await mkdir(join(repoPath, "src", "__tests__"), { recursive: true });
      await writeFile(join(repoPath, "package.json"), JSON.stringify({ name: "@fixture/realworld" }));
      await writeFile(
        join(repoPath, "tsconfig.json"),
        JSON.stringify({ include: ["src/**/*.ts"], exclude: ["src/__tests__"] }),
      );
      await writeFile(
        join(repoPath, "src", "prisma.service.ts"),
        `export class PrismaService {
  account = {
    create(input: unknown) {
      return input;
    },
  };
}
`,
      );
      await writeFile(
        join(repoPath, "src", "account.service.ts"),
        `import { PrismaService } from "./prisma.service";

export class AccountService {
  constructor(private readonly prismaService: PrismaService) {}

  createAccount() {
    return this.prismaService.account.create({ id: "acct_1" });
  }
}
`,
      );
      await writeFile(
        join(repoPath, "src", "app", "useComposerState.ts"),
        `export function looksLikeDroppedPath(text: string): boolean {
  return text.startsWith("/") && text.includes(".");
}

export function useComposerState() {
  return looksLikeDroppedPath("/tmp/image.png");
}
`,
      );
      await writeFile(
        join(repoPath, "src", "__tests__", "useComposerState.test.ts"),
        `import { looksLikeDroppedPath } from "../app/useComposerState.js";

it("recognizes local paths", () => {
  expect(looksLikeDroppedPath("/tmp/image.png")).toBe(true);
});
`,
      );

      await indexWorkspace({
        workspaceRoot: repoPath,
        repoPaths: [repoPath],
        indexPath,
        embeddingProviderName: "hash",
      });

      const store = new LadybugGraphStore(indexPath);
      try {
        const nodes = await store.getNodes();
        const edges = await store.getEdges();
        const testFile = nodes.find((node) => node.kind === "File" && node.file === "src/__tests__/useComposerState.test.ts");
        const helper = nodes.find(
          (node) =>
            node.kind === "Function" &&
            node.file === "src/app/useComposerState.ts" &&
            node.name === "looksLikeDroppedPath",
        );
        const createAccount = nodes.find(
          (node) =>
            node.kind === "Function" &&
            node.file === "src/account.service.ts" &&
            node.metadata.qualifiedName === "AccountService.createAccount",
        );
        const prismaService = nodes.find(
          (node) =>
            node.kind === "Class" &&
            node.file === "src/prisma.service.ts" &&
            node.name === "PrismaService",
        );

        expect(testFile).toBeDefined();
        expect(helper).toBeDefined();
        expect(createAccount).toBeDefined();
        expect(prismaService).toBeDefined();
        expect(edges).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "TESTS",
              fromId: testFile!.id,
              toId: helper!.id,
              metadata: expect.objectContaining({
                evidenceSources: expect.arrayContaining(["module-resolution", "tree-sitter-test"]),
              }),
            }),
            expect.objectContaining({
              kind: "CALLS",
              fromId: createAccount!.id,
              toId: prismaService!.id,
              metadata: expect.objectContaining({
                relationship: "injected-member-call",
                evidenceSources: expect.arrayContaining(["tree-sitter-member-call", "type-use"]),
              }),
            }),
          ]),
        );
      } finally {
        await store.close();
      }

      const engine = createQueryEngine({ indexPath });
      try {
        const references = await engine.getReferences("looksLikeDroppedPath", { limit: 10 });
        expect(references.results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "src/app/useComposerState.ts",
              symbol: expect.objectContaining({
                name: "looksLikeDroppedPath",
              }),
            }),
            expect.objectContaining({
              file: "src/__tests__/useComposerState.test.ts",
            }),
          ]),
        );
      } finally {
        await engine.close();
      }
    } finally {
      await rm(indexPath, { recursive: true, force: true });
      await rm(repoPath, { recursive: true, force: true });
    }
  });
});
