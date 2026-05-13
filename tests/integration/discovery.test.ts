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
});
