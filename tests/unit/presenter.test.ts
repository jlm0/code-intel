import { describe, expect, it } from "vitest";

import { renderResult } from "../../src/cli/presenter.js";
import { schemaVersion } from "../../src/schema/schemas.js";

describe("presenter", () => {
  it("renders deterministic JSON without ANSI terminal control codes", () => {
    const output = renderResult(
      {
        schemaVersion,
        status: "ok",
        checks: [{ name: "node", status: "pass", message: "Node is supported" }],
      },
      { json: true, isTTY: false },
    );

    expect(JSON.parse(output)).toMatchObject({ status: "ok" });
    expect(output).not.toMatch(/\u001b\[/);
    expect(output.endsWith("\n")).toBe(true);
  });

  it("renders compact human-readable query results for TTY output", () => {
    const output = renderResult(
      {
        schemaVersion,
        query: "calculateGivingTotal",
        results: [
          {
            id: "node-1",
            kind: "Function",
            repo: "fixture",
            file: "packages/core/src/tithe.ts",
            range: { startLine: 3, endLine: 8 },
            symbol: { id: "node-1", name: "calculateGivingTotal", kind: "Function" },
            matchedSignals: ["graph_calls"],
            metadata: {
              relationship: {
                kind: "CALLS",
                evidenceSources: ["scip-typescript"],
              },
            },
          },
        ],
      },
      { json: false, isTTY: true },
    );

    expect(output).toContain("query: calculateGivingTotal");
    expect(output).toContain("1. Function calculateGivingTotal");
    expect(output).toContain("packages/core/src/tithe.ts:3");
    expect(output).toContain("signals: graph_calls");
    expect(output).toContain("relationship: CALLS via scip-typescript");
    expect(output).not.toContain("\"schemaVersion\"");
  });
});
