import { describe, expect, it } from "vitest";

import { createStableId, normalizeRelativePath } from "../../src/core/ids.js";

describe("stable IDs", () => {
  it("uses the portable feature stable ID shape", () => {
    expect(
      createStableId({
        kind: "symbol",
        workspace: "fixture-workspace",
        repo: "fixture-repo",
        commit: "abc123",
        relativePath: "packages/core/src/calculate.ts",
        suffix: "calculateTotal",
      }),
    ).toBe(
      "symbol:fixture-workspace:fixture-repo@abc123:packages/core/src/calculate.ts#calculateTotal",
    );
  });

  it("normalizes platform path separators", () => {
    expect(normalizeRelativePath("packages\\core\\src\\calculate.ts")).toBe(
      "packages/core/src/calculate.ts",
    );
  });
});
