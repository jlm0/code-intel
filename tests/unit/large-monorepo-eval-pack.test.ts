import { describe, expect, it } from "vitest";

import { loadEvalPack } from "../../src/eval/eval-pack.js";

describe("large monorepo eval pack", () => {
  it("loads synthetic large-monorepo coverage with required gates and false-positive guards", async () => {
    const pack = await loadEvalPack({
      evalPackPath: "eval-packs/monorepo-js-ts",
      workspaceRoot: process.cwd(),
    });

    expect(pack.pack.id).toBe("monorepo-js-ts");
    expect(pack.pack.corpus.repoPaths).toEqual(["."]);
    expect(pack.cases.map((testCase) => testCase.gate.layer)).toEqual(
      expect.arrayContaining(["AST", "SCIP", "fusion", "embedding", "ranking"]),
    );
    expect(pack.graphCases.map((testCase) => testCase.gate.layer)).toEqual(
      expect.arrayContaining(["graph", "test-linking"]),
    );
    expect(pack.cases.some((testCase) => testCase.notExpected.length > 0)).toBe(true);
  });
});
