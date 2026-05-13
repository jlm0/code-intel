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
});
