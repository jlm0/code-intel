import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { indexWorkspace } from "../../src/indexer/indexer.js";
import { createQueryEngine } from "../../src/query/query-engine.js";

describe("path-level semantic ranking", () => {
  it("promotes representative route, service, database, UI, auth, and test nodes from coherent app-flow paths", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "code-intel-path-ranking-repo-"));
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-path-ranking-index-"));
    try {
      await writePathRankingFixture(repoPath);
      await indexWorkspace({
        workspaceRoot: repoPath,
        repoPaths: [repoPath],
        indexPath,
        embeddingProviderName: "hash",
      });

      const engine = createQueryEngine({ indexPath });
      try {
        const webhook = await engine.semanticSearch("dub webhook lead sale payment signature handler", {
          limit: 10,
        });
        expectResultWithin(webhook.results, "apps/web/app/api/dub/webhook/route.ts", "POST", 5);
        expectResultWithin(webhook.results, "apps/web/app/api/dub/webhook/lead-created.ts", "leadCreated", 8);
        expectResultWithin(webhook.results, "apps/web/app/api/dub/webhook/sale-created.ts", "saleCreated", 8);
        expect(findResult(webhook.results, "apps/web/app/api/dub/webhook/route.ts", "POST").metadata.ranking).toMatchObject({
          paths: expect.arrayContaining([
            expect.objectContaining({
              score: expect.any(Number),
              nodes: expect.arrayContaining([
                expect.objectContaining({ file: "apps/web/app/api/dub/webhook/route.ts", symbol: "POST" }),
              ]),
              edges: expect.arrayContaining([
                expect.objectContaining({
                  kind: "CALLS",
                  evidenceSources: expect.arrayContaining(["module-resolution"]),
                }),
              ]),
            }),
          ]),
        });

        const surveyPageSymbol = await engine.findSymbol("SurveyEditorPage", { limit: 5 });
        expect(surveyPageSymbol.results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "apps/web/modules/survey/editor/page.tsx",
              symbol: expect.objectContaining({ name: "SurveyEditorPage" }),
            }),
          ]),
        );

        const survey = await engine.semanticSearch("survey editor workspace auth survey response count permissions", {
          limit: 10,
        });
        expectResultWithin(survey.results, "apps/web/modules/survey/editor/page.tsx", "SurveyEditorPage", 5);
        expectResultWithin(survey.results, "apps/web/modules/workspaces/lib/utils.ts", "getWorkspaceAuth", 8);
        expectResultWithin(survey.results, "apps/web/modules/survey/lib/response.ts", "getResponseCountBySurveyId", 8);
        expect(findResult(survey.results, "apps/web/modules/workspaces/lib/utils.ts", "getWorkspaceAuth").metadata.ranking).toMatchObject({
          paths: expect.arrayContaining([
            expect.objectContaining({
              score: expect.any(Number),
              nodes: expect.arrayContaining([
                expect.objectContaining({ file: "apps/web/modules/survey/editor/page.tsx", symbol: "SurveyEditorPage" }),
                expect.objectContaining({ file: "apps/web/modules/workspaces/lib/utils.ts", symbol: "getWorkspaceAuth" }),
              ]),
            }),
          ]),
        });

        const topFiveResponseCountSymbols = survey.results
          .slice(0, 5)
          .filter((result) => result.symbol?.name === "responseCount");
        expect(topFiveResponseCountSymbols).toHaveLength(0);
      } finally {
        await engine.close();
      }
    } finally {
      await rm(indexPath, { recursive: true, force: true });
      await rm(repoPath, { recursive: true, force: true });
    }
  });
});

type SearchResult = Awaited<ReturnType<ReturnType<typeof createQueryEngine>["semanticSearch"]>>["results"][number];

function expectResultWithin(results: SearchResult[], file: string, symbol: string, maxRank: number): void {
  const index = results.findIndex((result) => result.file === file && result.symbol?.name === symbol);
  const actual = results.map((result, resultIndex) =>
    `${resultIndex + 1}. ${result.file}#${result.symbol?.name ?? ""} (${result.kind}) score=${result.score ?? ""} signals=${result.matchedSignals.join(",")} demotions=${rankingDemotions(result).join(",")}`,
  ).join("\n");
  expect(index, `${file}#${symbol} should rank within ${maxRank}\n${actual}`).toBeGreaterThanOrEqual(0);
  expect(index + 1).toBeLessThanOrEqual(maxRank);
}

function findResult(results: SearchResult[], file: string, symbol: string): SearchResult {
  const result = results.find((candidate) => candidate.file === file && candidate.symbol?.name === symbol);
  expect(result, `${file}#${symbol} should be present`).toBeDefined();
  return result!;
}

function rankingDemotions(result: SearchResult): string[] {
  const ranking = result.metadata.ranking as { demotions?: Array<{ signal?: string }> } | undefined;
  return ranking?.demotions?.map((demotion) => demotion.signal ?? "").filter(Boolean) ?? [];
}

async function writePathRankingFixture(repoPath: string): Promise<void> {
  await mkdir(join(repoPath, "apps", "web", "app", "api", "dub", "webhook"), { recursive: true });
  await mkdir(join(repoPath, "apps", "web", "modules", "survey", "editor", "components"), { recursive: true });
  await mkdir(join(repoPath, "apps", "web", "modules", "survey", "lib"), { recursive: true });
  await mkdir(join(repoPath, "apps", "web", "modules", "workspaces", "lib"), { recursive: true });
  await mkdir(join(repoPath, "apps", "web", "modules", "survey", "editor", "__tests__"), { recursive: true });

  await writeFile(
    join(repoPath, "package.json"),
    JSON.stringify({
      name: "path-ranking-fixture",
      workspaces: ["apps/*"],
    }),
  );
  await writeFile(join(repoPath, "tsconfig.json"), JSON.stringify({}));
  await writeFile(
    join(repoPath, "apps", "web", "package.json"),
    JSON.stringify({ name: "@fixture/web" }),
  );
  await writeFile(
    join(repoPath, "apps", "web", "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@/*": ["./*"],
        },
        jsx: "react-jsx",
      },
      include: ["**/*.ts", "**/*.tsx"],
    }),
  );

  await writeFile(
    join(repoPath, "apps", "web", "app", "api", "dub", "webhook", "route.ts"),
    `import { leadCreated } from "./lead-created";
import { saleCreated } from "./sale-created";

const webhookSignature = "x-dub-signature";

export async function POST(request: Request) {
  const event = await request.json();
  if (event.type === "lead.created") {
    return leadCreated(event, webhookSignature);
  }
  if (event.type === "sale.created") {
    return saleCreated(event, webhookSignature);
  }
  return new Response("ok");
}
`,
  );
  await writeFile(
    join(repoPath, "apps", "web", "app", "api", "dub", "webhook", "lead-created.ts"),
    `export async function leadCreated(event: unknown, signature: string) {
  return { event, signature, kind: "lead" };
}
`,
  );
  await writeFile(
    join(repoPath, "apps", "web", "app", "api", "dub", "webhook", "sale-created.ts"),
    `export async function saleCreated(event: unknown, signature: string) {
  return { event, signature, kind: "sale" };
}
`,
  );

  await writeFile(
    join(repoPath, "apps", "web", "modules", "survey", "editor", "page.tsx"),
    `import { getResponseCountBySurveyId } from "@/modules/survey/lib/response";
import { getWorkspaceAuth } from "@/modules/workspaces/lib/utils";
import { SurveyEditor } from "./components/survey-editor";

export async function SurveyEditorPage(input: { workspaceId: string; surveyId: string }) {
  const auth = await getWorkspaceAuth(input.workspaceId);
  const responseCount = await getResponseCountBySurveyId(input.surveyId);
  return <SurveyEditor auth={auth} responseCount={responseCount} />;
}
`,
  );
  await writeFile(
    join(repoPath, "apps", "web", "modules", "survey", "editor", "components", "survey-editor.tsx"),
    `export function SurveyEditor(input: { auth: unknown; responseCount: number }) {
  const responseCount = input.responseCount;
  return <div>{responseCount}</div>;
}
`,
  );
  await writeFile(
    join(repoPath, "apps", "web", "modules", "survey", "lib", "response.ts"),
    `export async function getResponseCountBySurveyId(surveyId: string) {
  const responseCount = surveyId.length;
  return responseCount;
}
`,
  );
  await writeFile(
    join(repoPath, "apps", "web", "modules", "workspaces", "lib", "utils.ts"),
    `export async function getWorkspaceAuth(workspaceId: string) {
  return { workspaceId, permissions: ["survey:update"] };
}
`,
  );
  await writeFile(
    join(repoPath, "apps", "web", "modules", "survey", "editor", "__tests__", "page.test.ts"),
    `import { describe, expect, test } from "vitest";
import { SurveyEditorPage } from "../page";

describe("SurveyEditorPage", () => {
  test("loads workspace auth and response counts", async () => {
    await expect(SurveyEditorPage({ workspaceId: "workspace_1", surveyId: "survey_1" })).resolves.toBeDefined();
  });
});
`,
  );
}
