import { describe, expect, it } from "vitest";

import { createSafeScipTsconfig } from "../../src/scip/runner.js";

describe("safe SCIP tsconfig generation", () => {
  it("limits files and neutralizes emit, build, and project-reference settings by default", () => {
    const config = createSafeScipTsconfig({
      repoPath: "/repo",
      baseConfigPath: "/repo/tsconfig.json",
      includedFiles: ["/repo/src/b.ts", "/repo/src/a.ts"],
      allowJs: false,
      projectReferencesEnabled: false,
      tsBuildInfoFile: "/tmp/code-intel.tsbuildinfo",
    });

    expect(config).toEqual({
      extends: "/repo/tsconfig.json",
      compilerOptions: expect.objectContaining({
        noEmit: true,
        declaration: false,
        composite: false,
        incremental: false,
        emitDeclarationOnly: false,
        skipLibCheck: true,
        tsBuildInfoFile: "/tmp/code-intel.tsbuildinfo",
      }),
      files: ["/repo/src/a.ts", "/repo/src/b.ts"],
      references: [],
      exclude: expect.arrayContaining(["/repo/node_modules/**", "/repo/dist/**"]),
    });
  });

  it("preserves project references only when the policy explicitly enables them", () => {
    const config = createSafeScipTsconfig({
      repoPath: "/repo",
      baseConfigPath: undefined,
      includedFiles: [],
      allowJs: true,
      projectReferencesEnabled: true,
      references: [{ path: "./packages/core" }],
      tsBuildInfoFile: "/tmp/code-intel.tsbuildinfo",
    });

    expect(config.compilerOptions).toMatchObject({ allowJs: true, checkJs: false });
    expect(config.references).toEqual([{ path: "./packages/core" }]);
  });
});
