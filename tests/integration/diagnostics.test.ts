import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readActiveIndexDiagnostics } from "../../src/diagnostics/index-diagnostics.js";
import { diagnoseIndexedFile } from "../../src/diagnostics/index-diagnostics.js";
import { indexWorkspace } from "../../src/indexer/indexer.js";
import { createHashEmbeddingProvider } from "../../src/vectors/embedding.js";
import { discoverWorkspace } from "../../src/workspace/discovery.js";

describe("index diagnostics", () => {
  it("records file lifecycle coverage for included, skipped, unsupported, graph, embedding, and queryable files", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "code-intel-diagnostics-repo-"));
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-diagnostics-index-"));

    try {
      await mkdir(join(repoPath, "src", "generated"), { recursive: true });
      await mkdir(join(repoPath, "notes"), { recursive: true });
      await writeFile(join(repoPath, "package.json"), JSON.stringify({ name: "@fixture/diagnostics" }));
      await writeFile(
        join(repoPath, "tsconfig.json"),
        JSON.stringify({ include: ["src/**/*.ts"], exclude: ["src/excluded.ts"] }),
      );
      await writeFile(
        join(repoPath, "src", "index.ts"),
        "export function includedThing() { return 'included'; }\n",
      );
      await writeFile(join(repoPath, "src", "excluded.ts"), "export const excludedThing = true;\n");
      await writeFile(join(repoPath, "src", "generated", "ignored.ts"), "export const ignoredThing = true;\n");
      await writeFile(join(repoPath, "notes", "readme.md"), "# not indexed\n");

      const workspace = await discoverWorkspace({
        workspaceRoot: repoPath,
        repoPaths: [repoPath],
      });
      expect(workspace.diagnostics.files.find((file) => file.relativePath === "src/excluded.ts")).toMatchObject({
        status: "excluded",
        reason: "tsconfig-excluded",
      });
      expect(workspace.diagnostics.files.find((file) => file.relativePath === "src/generated")).toMatchObject({
        status: "excluded",
        reason: "ignored-directory",
      });
      expect(workspace.diagnostics.files.find((file) => file.relativePath === "notes/readme.md")).toMatchObject({
        status: "excluded",
        reason: "unsupported-extension",
      });

      await indexWorkspace({
        workspaceRoot: repoPath,
        repoPaths: [repoPath],
        indexPath,
        embeddingProvider: createHashEmbeddingProvider(),
      });

      const diagnostics = await readActiveIndexDiagnostics(indexPath);
      expect(diagnostics?.summary).toMatchObject({
        indexedFiles: 1,
        skippedFiles: 3,
        graphFiles: 1,
        embeddedFiles: 1,
      });

      const included = diagnostics?.files.find((file) => file.relativePath === "src/index.ts");
      expect(included).toMatchObject({
        status: "indexed",
        lifecycle: {
          discovery: { status: "pass" },
          parse: { status: "pass" },
          ast: { status: "pass" },
          chunks: { status: "pass" },
          embeddings: { status: "pass" },
          graph: { status: "pass" },
          exactQueryability: { status: "pass" },
          symbolQueryability: { status: "pass" },
          semanticRanking: { status: "pass" },
        },
        counts: {
          chunks: 1,
          embeddedChunks: 1,
        },
      });
      expect(included?.queryability.symbolNames).toContain("includedThing");

      const excluded = diagnostics?.files.find((file) => file.relativePath === "src/excluded.ts");
      expect(excluded).toMatchObject({
        status: "skipped",
        lifecycle: {
          tsconfig: { status: "fail", reason: "tsconfig-excluded" },
          graph: { status: "skip" },
        },
      });

      await expect(diagnoseIndexedFile(indexPath, "src/generated/ignored.ts")).resolves.toMatchObject({
        matched: true,
        file: {
          relativePath: "src/generated/ignored.ts",
          status: "skipped",
          reasons: ["ignored-directory"],
        },
      });
    } finally {
      await rm(repoPath, { recursive: true, force: true });
      await rm(indexPath, { recursive: true, force: true });
    }
  }, 60_000);
});
