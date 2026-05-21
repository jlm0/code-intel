import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveActiveGenerationPath } from "../../src/core/index-artifacts.js";
import { indexWorkspace } from "../../src/indexer/indexer.js";
import { ingestScipIndex, type ScipFacts } from "../../src/scip/ingest.js";
import { runScipTypescript } from "../../src/scip/runner.js";

const fixturePath = new URL("../fixtures/js-ts-workspace", import.meta.url).pathname;

describe("SCIP sharding", () => {
  it("preserves cross-package references when package shard outputs are ingested separately", async () => {
    const tempPath = await mkdtemp(join(tmpdir(), "code-intel-scip-shards-"));
    try {
      const coreFacts = await runAndIngestShard({
        repoPath: fixturePath,
        outputPath: join(tempPath, "core.scip"),
        projectPath: join(fixturePath, "packages", "core"),
      });
      const uiFacts = await runAndIngestShard({
        repoPath: fixturePath,
        outputPath: join(tempPath, "ui.scip"),
        projectPath: join(fixturePath, "packages", "ui"),
      });

      expect(coreFacts.definitions.length, "core shard should produce definitions").toBeGreaterThan(0);
      expect(uiFacts.occurrences.length, "ui shard should produce occurrences").toBeGreaterThan(0);

      const references = [...coreFacts.references, ...uiFacts.references];
      expect(references.length, "separate shard ingestion should retain references").toBeGreaterThan(0);
      expect(references).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            relativePath: "packages/ui/src/useGivingSummary.tsx",
            symbolName: "GivingLedger",
          }),
          expect.objectContaining({
            relativePath: "packages/ui/src/useGivingSummary.tsx",
            symbolName: "GivingSummary",
          }),
        ]),
      );
    } finally {
      await rm(tempPath, { recursive: true, force: true });
    }
  });

  it("includes a repo-level shard for discovered source files outside workspace packages", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "code-intel-scip-root-scope-repo-"));
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-scip-root-scope-index-"));
    try {
      await writeWorkspaceWithRootTest(repoPath);

      await indexWorkspace({
        workspaceRoot: repoPath,
        repoPaths: [repoPath],
        indexPath,
        embeddingProviderName: "hash",
      });

      const scipFacts = await readPublishedScipFacts(indexPath);
      const occurrencePaths = new Set(
        scipFacts.flatMap((repo) => repo.occurrences.map((occurrence) => occurrence.relativePath)),
      );
      expect(occurrencePaths.size, "SCIP facts should include at least one occurrence path").toBeGreaterThan(0);
      expect(occurrencePaths).toContain("e2e/root-flow.test.ts");
    } finally {
      await rm(indexPath, { recursive: true, force: true });
      await rm(repoPath, { recursive: true, force: true });
    }
  });

  it("keeps generated documents ignored by discovery out of inferred package shard output", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "code-intel-scip-generated-repo-"));
    const outputPath = join(repoPath, "generated.scip");
    try {
      const packagePath = join(repoPath, "packages", "app");
      await mkdir(join(packagePath, "src"), { recursive: true });
      await mkdir(join(packagePath, ".next", "types"), { recursive: true });
      await mkdir(join(packagePath, "generated"), { recursive: true });
      await writeFile(
        join(repoPath, "package.json"),
        JSON.stringify({ name: "generated-workspace", private: true, workspaces: ["packages/*"] }),
      );
      await writeFile(
        join(repoPath, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            module: "ESNext",
            moduleResolution: "Bundler",
            target: "ES2022",
          },
        }),
      );
      await writeFile(join(packagePath, "package.json"), JSON.stringify({ name: "@fixture/app" }));
      await writeFile(join(packagePath, "src", "index.ts"), "export const appName = 'fixture';\n");
      await writeFile(
        join(packagePath, ".next", "types", "routes.ts"),
        "export interface GeneratedRoute { path: string }\n",
      );
      await writeFile(
        join(packagePath, "generated", "schema.ts"),
        "export interface GeneratedSchema { id: string }\n",
      );

      const facts = await runAndIngestShard({
        repoPath,
        outputPath,
        projectPath: packagePath,
      });
      const factPaths = new Set([
        ...facts.definitions.map((definition) => definition.relativePath),
        ...facts.occurrences.map((occurrence) => occurrence.relativePath),
      ]);

      expect(factPaths.size, "SCIP shard should produce source facts").toBeGreaterThan(0);
      expect([...factPaths].filter((path) => path.includes("/.next/") || path.includes("/generated/"))).toEqual([]);
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });

  it("constrains package shards to discovered files when a package config includes generated files", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "code-intel-scip-discovered-files-repo-"));
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-scip-discovered-files-index-"));
    try {
      const packagePath = join(repoPath, "packages", "app");
      await mkdir(join(packagePath, "src"), { recursive: true });
      await mkdir(join(packagePath, "generated"), { recursive: true });
      await writeFile(
        join(repoPath, "package.json"),
        JSON.stringify({ name: "discovered-files-workspace", private: true, workspaces: ["packages/*"] }),
      );
      await writeFile(
        join(repoPath, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            module: "ESNext",
            moduleResolution: "Bundler",
            target: "ES2022",
          },
        }),
      );
      await writeFile(join(packagePath, "package.json"), JSON.stringify({ name: "@fixture/app" }));
      await writeFile(
        join(packagePath, "tsconfig.json"),
        JSON.stringify({
          extends: "../../tsconfig.json",
          include: ["**/*.ts"],
        }),
      );
      await writeFile(join(packagePath, "src", "index.ts"), "export const appName = 'fixture';\n");
      await writeFile(
        join(packagePath, "generated", "schema.ts"),
        "export interface GeneratedSchema { id: string }\n",
      );

      await indexWorkspace({
        workspaceRoot: repoPath,
        repoPaths: [repoPath],
        indexPath,
        embeddingProviderName: "hash",
      });

      const scipFacts = await readPublishedScipFacts(indexPath);
      const factPaths = new Set(
        scipFacts.flatMap((repo) => [
          ...repo.definitions.map((definition) => definition.relativePath),
          ...repo.occurrences.map((occurrence) => occurrence.relativePath),
        ]),
      );
      expect(factPaths).toContain("packages/app/src/index.ts");
      expect([...factPaths].filter((path) => path.includes("/generated/"))).toEqual([]);
    } finally {
      await rm(indexPath, { recursive: true, force: true });
      await rm(repoPath, { recursive: true, force: true });
    }
  });
});

async function runAndIngestShard(input: {
  repoPath: string;
  outputPath: string;
  projectPath: string;
}): Promise<ScipFacts> {
  const run = await runScipTypescript({
    repoPath: input.repoPath,
    outputPath: input.outputPath,
    inferTsconfig: true,
    projectPaths: [input.projectPath],
    maxOldSpaceSizeMb: 1024,
  });
  expect(run.ok, run.stderr).toBe(true);
  return ingestScipIndex(input.outputPath);
}

async function writeWorkspaceWithRootTest(repoPath: string): Promise<void> {
  await mkdir(join(repoPath, "packages", "core", "src"), { recursive: true });
  await mkdir(join(repoPath, "e2e"), { recursive: true });
  await writeFile(
    join(repoPath, "package.json"),
    JSON.stringify({ name: "root-scope-workspace", private: true, workspaces: ["packages/*"] }),
  );
  await writeFile(
    join(repoPath, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@fixture/core": ["packages/core/src/index.ts"],
        },
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ES2022",
      },
      include: ["packages/**/*.ts", "e2e/**/*.ts"],
    }),
  );
  await writeFile(join(repoPath, "packages", "core", "package.json"), JSON.stringify({ name: "@fixture/core" }));
  await writeFile(
    join(repoPath, "packages", "core", "src", "index.ts"),
    "export function calculateRootScopeValue(input: number) { return input + 1; }\n",
  );
  await writeFile(
    join(repoPath, "e2e", "root-flow.test.ts"),
    `import { calculateRootScopeValue } from "@fixture/core";

export const rootScopeResult = calculateRootScopeValue(41);
`,
  );
}

async function readPublishedScipFacts(indexPath: string): Promise<Array<ScipFacts & { name: string }>> {
  const generationPath = await resolveActiveGenerationPath(indexPath);
  expect(generationPath).toBeDefined();
  const facts = JSON.parse(await readFile(join(generationPath!, "facts", "scip.json"), "utf8")) as {
    repos: Array<ScipFacts & { name: string }>;
  };
  return facts.repos;
}
