import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { discoverWorkspace } from "../../src/workspace/discovery.js";

const fixturePath = new URL("../fixtures/js-ts-workspace", import.meta.url).pathname;

describe("workspace discovery", () => {
  it("discovers package workspaces and source files", async () => {
    const workspace = await discoverWorkspace({
      workspaceRoot: fixturePath,
      repoPaths: [fixturePath],
    });

    expect(workspace.workspaceName).toBe("fixture-workspace");
    expect(workspace.repos).toHaveLength(1);
    expect(workspace.repos[0]?.packages.map((pkg) => pkg.name).sort()).toEqual([
      "@fixture/core",
      "@fixture/legacy",
      "@fixture/ui",
    ]);
    expect(workspace.repos[0]?.files.map((file) => file.relativePath)).toContain(
      "packages/core/src/tithe.ts",
    );
    expect(
      workspace.repos[0]?.files.every((file) => !file.relativePath.includes("node_modules")),
    ).toBe(true);
  });

  it("keeps the root package for a package repo with nested package files", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "code-intel-package-repo-"));
    try {
      await mkdir(join(repoPath, "src", "generated"), { recursive: true });
      await writeFile(
        join(repoPath, "package.json"),
        JSON.stringify({ name: "@fixture/root-package", version: "0.0.0" }),
      );
      await writeFile(
        join(repoPath, "src", "generated", "package.json"),
        JSON.stringify({ name: "generated-asset-package", version: "0.0.0" }),
      );
      await writeFile(join(repoPath, "src", "index.ts"), "export const value = 1;\n");

      const workspace = await discoverWorkspace({
        workspaceRoot: repoPath,
        repoPaths: [repoPath],
      });

      expect(workspace.repos[0]?.packages.map((pkg) => pkg.name)).toContain(
        "@fixture/root-package",
      );
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });

  it("discovers recursive workspace package patterns", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "code-intel-recursive-workspace-repo-"));
    try {
      await mkdir(join(repoPath, "apps", "server", "src"), { recursive: true });
      await mkdir(join(repoPath, "packages", "db", "src"), { recursive: true });
      await writeFile(
        join(repoPath, "package.json"),
        JSON.stringify({
          name: "recursive-workspace",
          workspaces: ["apps/*", "packages/**/*"],
        }),
      );
      await writeFile(join(repoPath, "apps", "server", "package.json"), JSON.stringify({ name: "@fixture/server" }));
      await writeFile(join(repoPath, "packages", "db", "package.json"), JSON.stringify({ name: "@fixture/db" }));
      await writeFile(join(repoPath, "apps", "server", "src", "index.ts"), "export const server = 1;\n");
      await writeFile(join(repoPath, "packages", "db", "src", "index.ts"), "export const db = 1;\n");

      const workspace = await discoverWorkspace({
        workspaceRoot: repoPath,
        repoPaths: [repoPath],
      });

      expect(workspace.repos[0]?.packages.map((pkg) => pkg.name).sort()).toEqual([
        "@fixture/db",
        "@fixture/server",
      ]);
      expect(workspace.repos[0]?.files.map((file) => file.relativePath).sort()).toEqual([
        "apps/server/src/index.ts",
        "packages/db/src/index.ts",
      ]);
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });

  it("fails clearly for missing repository roots", async () => {
    await expect(
      discoverWorkspace({
        workspaceRoot: fixturePath,
        repoPaths: [join(fixturePath, "missing-repo")],
      }),
    ).rejects.toThrow(/Repository path does not exist/);
  });

  it("loads repository paths from an optional workspace manifest", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "code-intel-manifest-workspace-"));
    const repoPath = join(workspacePath, "packages", "app");
    try {
      await mkdir(join(repoPath, "src"), { recursive: true });
      await writeFile(join(workspacePath, "package.json"), JSON.stringify({ name: "manifest-workspace" }));
      await writeFile(join(repoPath, "package.json"), JSON.stringify({ name: "@fixture/app" }));
      await writeFile(join(repoPath, "src", "index.ts"), "export const value = 1;\n");
      await writeFile(
        join(workspacePath, "code-intel.workspace.json"),
        JSON.stringify({ repos: [{ path: "packages/app" }] }),
      );

      const workspace = await discoverWorkspace({
        workspaceRoot: workspacePath,
        repoPaths: [],
        workspaceManifestPath: "code-intel.workspace.json",
      });

      expect(workspace.repos).toHaveLength(1);
      expect(workspace.repos[0]?.path).toBe(repoPath);
      expect(workspace.repos[0]?.files.map((file) => file.relativePath)).toContain("src/index.ts");
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("uses tsconfig includes and excludes for nonstandard source roots", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "code-intel-tsconfig-repo-"));
    try {
      await mkdir(join(repoPath, "app", "generated"), { recursive: true });
      await mkdir(join(repoPath, "src"), { recursive: true });
      await writeFile(join(repoPath, "package.json"), JSON.stringify({ name: "@fixture/nonstandard" }));
      await writeFile(
        join(repoPath, "tsconfig.json"),
        JSON.stringify({ include: ["app/**/*.ts"], exclude: ["app/generated/**"] }),
      );
      await writeFile(join(repoPath, "app", "index.ts"), "export const included = 1;\n");
      await writeFile(join(repoPath, "app", "generated", "ignored.ts"), "export const ignored = 1;\n");
      await writeFile(join(repoPath, "src", "ignored.ts"), "export const ignored = 1;\n");

      const workspace = await discoverWorkspace({
        workspaceRoot: repoPath,
        repoPaths: [repoPath],
      });
      const files = workspace.repos[0]?.files.map((file) => file.relativePath) ?? [];

      expect(workspace.repos[0]?.packages[0]?.sourceRoots).toContain(join(repoPath, "app"));
      expect(files).toEqual(["app/index.ts"]);
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });

  it("indexes source files under lib directories", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "code-intel-source-lib-repo-"));
    try {
      await mkdir(join(repoPath, "src", "lib"), { recursive: true });
      await writeFile(join(repoPath, "package.json"), JSON.stringify({ name: "@fixture/source-lib" }));
      await writeFile(join(repoPath, "src", "lib", "service.ts"), "export const service = 1;\n");

      const workspace = await discoverWorkspace({
        workspaceRoot: repoPath,
        repoPaths: [repoPath],
      });

      expect(workspace.repos[0]?.files.map((file) => file.relativePath)).toEqual([
        "src/lib/service.ts",
      ]);
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });

  it("keeps explicit test files under source roots even when tsconfig excludes tests", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "code-intel-excluded-tests-repo-"));
    try {
      await mkdir(join(repoPath, "src", "__tests__"), { recursive: true });
      await writeFile(join(repoPath, "package.json"), JSON.stringify({ name: "@fixture/excluded-tests" }));
      await writeFile(
        join(repoPath, "tsconfig.json"),
        JSON.stringify({ include: ["src/**/*.ts"], exclude: ["src/__tests__"] }),
      );
      await writeFile(join(repoPath, "src", "helper.ts"), "export const helper = () => true;\n");
      await writeFile(
        join(repoPath, "src", "__tests__", "helper.test.ts"),
        "import { helper } from '../helper.js';\nit('uses helper', () => expect(helper()).toBe(true));\n",
      );

      const workspace = await discoverWorkspace({
        workspaceRoot: repoPath,
        repoPaths: [repoPath],
      });
      const files = workspace.repos[0]?.files.map((file) => file.relativePath).sort() ?? [];

      expect(files).toEqual(["src/__tests__/helper.test.ts", "src/helper.ts"]);
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });

  it("requires explicit opt-in before indexing ignored generated paths", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "code-intel-ignore-repo-"));
    try {
      await mkdir(join(repoPath, "generated"), { recursive: true });
      await writeFile(join(repoPath, "package.json"), JSON.stringify({ name: "@fixture/ignored" }));
      await writeFile(join(repoPath, "generated", "value.ts"), "export const generated = 1;\n");

      const defaultWorkspace = await discoverWorkspace({
        workspaceRoot: repoPath,
        repoPaths: [repoPath],
      });
      expect(defaultWorkspace.repos[0]?.files).toHaveLength(0);

      const includedWorkspace = await discoverWorkspace({
        workspaceRoot: repoPath,
        repoPaths: [repoPath],
        includeIgnored: true,
      });
      expect(includedWorkspace.repos[0]?.files.map((file) => file.relativePath)).toEqual(["generated/value.ts"]);
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });
});
