import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LadybugGraphStore } from "../../src/graph/ladybug-store.js";
import { indexWorkspace } from "../../src/indexer/indexer.js";
import { createQueryEngine } from "../../src/query/query-engine.js";

describe("holdout generalization relationships", () => {
  it("promotes package tsconfig aliases, lib source files, injected member methods, and route-string tests", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "code-intel-holdout-generalization-repo-"));
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-holdout-generalization-index-"));
    try {
      await writeFixtureRepo(repoPath);

      await indexWorkspace({
        workspaceRoot: repoPath,
        repoPaths: [repoPath],
        indexPath,
        embeddingProviderName: "hash",
      });

      let linksRoutePostId = "";
      let createLinkId = "";
      const store = new LadybugGraphStore(indexPath);
      try {
        const nodes = await store.getNodes();
        const edges = await store.getEdges();
        const nodeById = new Map(nodes.map((node) => [node.id, node]));

        const linksRoutePost = findNode(nodes, "Function", "apps/web/app/api/links/route.ts", "POST");
        const createLink = findNode(nodes, "Function", "apps/web/lib/api/links/create-link.ts", "createLink");
        const prisma = findNode(nodes, "Symbol", "packages/db/src/index.ts", "prisma");
        const surveyPage = findNode(nodes, "Function", "apps/web/modules/survey/page.tsx", "SurveyPage");
        const getWorkspaceAuth = findNode(nodes, "Function", "apps/web/modules/workspaces/lib/utils.ts", "getWorkspaceAuth");
        const resolverMethod = findQualifiedNode(
          nodes,
          "Function",
          "packages/server/src/chart/resolver.ts",
          "ChartResolver.chart",
        );
        const serviceMethod = findQualifiedNode(
          nodes,
          "Function",
          "packages/server/src/chart/service.ts",
          "ChartService.getChart",
        );
        const queryMethod = findQualifiedNode(
          nodes,
          "Function",
          "packages/server/src/chart/query.ts",
          "ChartDataQueryService.executeGroupByQuery",
        );
        const chartService = findNode(nodes, "Class", "packages/server/src/chart/service.ts", "ChartService");
        const chartModule = findNode(nodes, "File", "packages/server/src/chart/module.ts");
        const routeTestFile = findNode(nodes, "File", "apps/web/tests/links/create-link.test.ts");
        const serviceTestFile = findNode(nodes, "File", "packages/server/src/chart/service.spec.ts");

        for (const node of [
          linksRoutePost,
          createLink,
          prisma,
          surveyPage,
          getWorkspaceAuth,
          resolverMethod,
          serviceMethod,
          queryMethod,
          chartService,
          chartModule,
          routeTestFile,
          serviceTestFile,
        ]) {
          expect(node).toBeDefined();
        }
        linksRoutePostId = linksRoutePost!.id;
        createLinkId = createLink!.id;

        expect(findEdge(edges, "CALLS", linksRoutePost!.id, createLink!.id)?.metadata.evidenceSources).toEqual(
          expect.arrayContaining(["module-resolution", "tree-sitter-call"]),
        );
        expect(findEdge(edges, "CALLS", createLink!.id, prisma!.id)?.metadata.evidenceSources).toEqual(
          expect.arrayContaining(["module-resolution", "tree-sitter-member-call"]),
        );
        expect(findEdge(edges, "CALLS", surveyPage!.id, getWorkspaceAuth!.id)?.metadata.evidenceSources).toEqual(
          expect.arrayContaining(["module-resolution", "tree-sitter-call"]),
        );
        expect(findEdge(edges, "REFERENCES", chartModule!.id, chartService!.id)?.metadata.evidenceSources).toEqual(
          expect.arrayContaining(["module-resolution"]),
        );
        const resolverToService = findEdge(edges, "CALLS", resolverMethod!.id, serviceMethod!.id);
        expect(resolverToService?.metadata.relationship).toBe("injected-member-call");
        expect(resolverToService?.metadata.evidenceSources).toEqual(
          expect.arrayContaining(["tree-sitter-member-call", "type-use"]),
        );
        const serviceToQuery = findEdge(edges, "CALLS", serviceMethod!.id, queryMethod!.id);
        expect(serviceToQuery?.metadata.relationship).toBe("injected-member-call");
        expect(serviceToQuery?.metadata.evidenceSources).toEqual(
          expect.arrayContaining(["tree-sitter-member-call", "type-use"]),
        );
        const routeTestToPost = findEdgeWithEvidence(edges, "TESTS", routeTestFile!.id, linksRoutePost!.id, "http-harness-route");
        expect(routeTestToPost?.metadata.testLinkKind).toBe("http-route");
        expect(routeTestToPost?.metadata.evidenceSources).toEqual(
          expect.arrayContaining(["http-harness-route", "tree-sitter-test"]),
        );
        expect(findEdge(edges, "TESTS", serviceTestFile!.id, chartService!.id)?.metadata.evidenceSources).toEqual(
          expect.arrayContaining(["module-resolution", "tree-sitter-test"]),
        );

        expect(
          edges.some(
            (edge) =>
              edge.kind === "TESTS" &&
              edge.fromId === routeTestFile!.id &&
              nodeById.get(edge.toId)?.file === "packages/server/src/chart/service.ts",
          ),
        ).toBe(false);
      } finally {
        await store.close();
      }

      const engine = createQueryEngine({ indexPath });
      try {
        const routeToCreateLinkPath = await engine.tracePath(linksRoutePostId, createLinkId, {
          allowedEdgeKinds: ["CALLS", "REFERENCES", "IMPORTS", "EXPORTS", "TESTS"],
          direction: "outgoing",
          limit: 10,
          maxDepth: 5,
        });
        expect(routeToCreateLinkPath.results.map((result) => result.id)).toContain(createLinkId);
        expect(
          routeToCreateLinkPath.results
            .flatMap((result) => result.metadata.pathEdges as Array<{ evidenceSources?: string[] }> | undefined ?? [])
            .flatMap((edge) => edge.evidenceSources ?? []),
        ).toEqual(expect.arrayContaining(["module-resolution", "tree-sitter-call"]));

        const createLinkReferences = await engine.getReferences("createLink", { limit: 20 });
        expect(createLinkReferences.results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "apps/web/app/api/links/route.ts",
            }),
          ]),
        );

        const serviceReferences = await engine.getReferences("ChartService", { limit: 20 });
        expect(serviceReferences.results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "packages/server/src/chart/resolver.ts",
            }),
            expect.objectContaining({
              file: "packages/server/src/chart/module.ts",
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

function findNode(nodes: Awaited<ReturnType<LadybugGraphStore["getNodes"]>>, kind: string, file: string, name?: string) {
  return nodes.find((node) =>
    node.kind === kind &&
    node.file === file &&
    (name === undefined || node.name === name)
  );
}

function findQualifiedNode(
  nodes: Awaited<ReturnType<LadybugGraphStore["getNodes"]>>,
  kind: string,
  file: string,
  qualifiedName: string,
) {
  return nodes.find((node) =>
    node.kind === kind &&
    node.file === file &&
    node.metadata.qualifiedName === qualifiedName
  );
}

function findEdge(
  edges: Awaited<ReturnType<LadybugGraphStore["getEdges"]>>,
  kind: string,
  fromId: string,
  toId: string,
) {
  return edges.find((edge) => edge.kind === kind && edge.fromId === fromId && edge.toId === toId);
}

function findEdgeWithEvidence(
  edges: Awaited<ReturnType<LadybugGraphStore["getEdges"]>>,
  kind: string,
  fromId: string,
  toId: string,
  evidenceSource: string,
) {
  return edges.find((edge) =>
    edge.kind === kind &&
    edge.fromId === fromId &&
    edge.toId === toId &&
    Array.isArray(edge.metadata.evidenceSources) &&
    edge.metadata.evidenceSources.includes(evidenceSource)
  );
}

async function writeFixtureRepo(repoPath: string): Promise<void> {
  await mkdir(join(repoPath, "apps", "web", "app", "api", "links"), { recursive: true });
  await mkdir(join(repoPath, "apps", "web", "lib", "api", "links"), { recursive: true });
  await mkdir(join(repoPath, "apps", "web", "modules", "survey"), { recursive: true });
  await mkdir(join(repoPath, "apps", "web", "modules", "workspaces", "lib"), { recursive: true });
  await mkdir(join(repoPath, "apps", "web", "tests", "links"), { recursive: true });
  await mkdir(join(repoPath, "packages", "db", "src"), { recursive: true });
  await mkdir(join(repoPath, "packages", "server", "src", "chart"), { recursive: true });

  await writeFile(
    join(repoPath, "package.json"),
    JSON.stringify({
      name: "holdout-generalization",
      workspaces: ["apps/*", "packages/*"],
    }),
  );
  await writeFile(join(repoPath, "tsconfig.json"), JSON.stringify({}));

  await writeFile(
    join(repoPath, "apps", "web", "package.json"),
    JSON.stringify({
      name: "@fixture/web",
      dependencies: {
        "@fixture/db": "workspace:*",
      },
    }),
  );
  await writeFile(
    join(repoPath, "apps", "web", "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@/*": ["./*"],
        },
      },
      include: ["**/*.ts", "**/*.tsx"],
    }),
  );
  await writeFile(
    join(repoPath, "apps", "web", "app", "api", "links", "route.ts"),
    `import { createLink } from "@/lib/api/links";

function withWorkspace(handler: () => unknown) {
  return handler;
}

export const POST = withWorkspace(async () => {
  return createLink({ url: "https://example.com" });
});
`,
  );
  await writeFile(
    join(repoPath, "apps", "web", "lib", "api", "links", "index.ts"),
    `export * from "./create-link";
`,
  );
  await writeFile(
    join(repoPath, "apps", "web", "lib", "api", "links", "create-link.ts"),
    `import { prisma } from "@fixture/db";

export async function createLink(input: unknown) {
  return prisma.link.create({ data: input });
}
`,
  );
  await writeFile(
    join(repoPath, "apps", "web", "modules", "survey", "page.tsx"),
    `import { getWorkspaceAuth } from "@/modules/workspaces/lib/utils";

export async function SurveyPage() {
  return getWorkspaceAuth("workspace_1");
}
`,
  );
  await writeFile(
    join(repoPath, "apps", "web", "modules", "workspaces", "lib", "utils.ts"),
    `export async function getWorkspaceAuth(workspaceId: string) {
  return { workspaceId };
}
`,
  );
  await writeFile(
    join(repoPath, "apps", "web", "tests", "links", "create-link.test.ts"),
    `import { describe, expect, test } from "vitest";

const http = {
  post(input: { path: string }) {
    return input;
  },
};

describe("POST /links", () => {
  test("creates a link through the HTTP harness", async () => {
    const result = await http.post({ path: "/links" });
    expect(result.path).toBe("/links");
  });
});
`,
  );

  await writeFile(
    join(repoPath, "packages", "db", "package.json"),
    JSON.stringify({
      name: "@fixture/db",
      exports: {
        ".": "./src/index.ts",
      },
    }),
  );
  await writeFile(
    join(repoPath, "packages", "db", "src", "index.ts"),
    `export const prisma = {
  link: {
    create(input: unknown) {
      return input;
    },
  },
};
`,
  );

  await writeFile(join(repoPath, "packages", "server", "package.json"), JSON.stringify({ name: "@fixture/server" }));
  await writeFile(
    join(repoPath, "packages", "server", "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "src/*": ["./src/*"],
        },
      },
      include: ["src/**/*.ts"],
    }),
  );
  await writeFile(
    join(repoPath, "packages", "server", "src", "chart", "query.ts"),
    `export class ChartDataQueryService {
  executeGroupByQuery() {
    return [];
  }
}
`,
  );
  await writeFile(
    join(repoPath, "packages", "server", "src", "chart", "service.ts"),
    `import { ChartDataQueryService } from "src/chart/query";

export class ChartService {
  constructor(private readonly chartDataQueryService: ChartDataQueryService) {}

  getChart() {
    return this.chartDataQueryService.executeGroupByQuery();
  }
}
`,
  );
  await writeFile(
    join(repoPath, "packages", "server", "src", "chart", "resolver.ts"),
    `import { ChartService } from "src/chart/service";

export class ChartResolver {
  constructor(private readonly chartService: ChartService) {}

  chart() {
    return this.chartService.getChart();
  }
}
`,
  );
  await writeFile(
    join(repoPath, "packages", "server", "src", "chart", "module.ts"),
    `import { ChartResolver } from "src/chart/resolver";
import { ChartService } from "src/chart/service";
import { ChartDataQueryService } from "src/chart/query";

export class ChartModule {
  providers = [ChartDataQueryService, ChartService, ChartResolver];
}
`,
  );
  await writeFile(
    join(repoPath, "packages", "server", "src", "chart", "service.spec.ts"),
    `import { describe, expect, test } from "vitest";
import { ChartService } from "src/chart/service";

describe("ChartService", () => {
  test("uses chart service", () => {
    expect(ChartService).toBeDefined();
  });
});
`,
  );
}
