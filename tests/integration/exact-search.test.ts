import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { searchText } from "../../src/search/exact.js";

const fixturePath = new URL("../fixtures/js-ts-workspace", import.meta.url).pathname;

describe("exact search", () => {
  it("parses rg --json matches into stable result records", async () => {
    const results = await searchText({
      pattern: "calculateGivingTotal",
      repoPaths: [fixturePath],
      limit: 10,
    });

    expect(results.results.length).toBeGreaterThan(0);
    expect(results.results[0]).toMatchObject({
      kind: "File",
      matchedSignals: ["exact_text"],
    });
    expect(results.results.map((result) => result.file)).toContain(
      "packages/core/src/tithe.ts",
    );
  });

  it("treats exact patterns as literals instead of regular expressions", async () => {
    const results = await searchText({
      pattern: "calculateGivingTotal(",
      repoPaths: [fixturePath],
      limit: 10,
    });

    expect(results.results.map((result) => result.file)).toContain(
      "packages/core/src/tithe.ts",
    );
  });

  it("treats patterns that start with a dash as search text", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "code-intel-exact-dash-"));
    try {
      await writeFile(join(repoPath, "flags.ts"), "export const flag = '--json';\n");
      const results = await searchText({
        pattern: "--json",
        repoPaths: [repoPath],
        limit: 5,
      });

      expect(results.results.map((result) => result.file)).toContain("flags.ts");
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });

  it("uses the shared ignore policy for hidden artifact directories", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "code-intel-exact-hidden-"));
    try {
      await mkdir(join(repoPath, ".vercel", "output"), { recursive: true });
      await writeFile(
        join(repoPath, ".vercel", "output", "route.ts"),
        "export const hiddenGeneratedExactNeedle = true;\n",
      );

      const results = await searchText({
        pattern: "hiddenGeneratedExactNeedle",
        repoPaths: [repoPath],
        limit: 5,
      });

      expect(results.results).toHaveLength(0);
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });

  it("can include an explicitly allowlisted hidden source directory", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "code-intel-exact-hidden-source-"));
    try {
      await mkdir(join(repoPath, ".storybook"), { recursive: true });
      await writeFile(join(repoPath, ".storybook", "preview.ts"), "export const allowlistedExactNeedle = true;\n");

      const results = await searchText({
        pattern: "allowlistedExactNeedle",
        repoPaths: [repoPath],
        limit: 5,
        allowedHiddenDirectories: [".storybook"],
      });

      expect(results.results.map((result) => result.file)).toEqual([".storybook/preview.ts"]);
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });
});
