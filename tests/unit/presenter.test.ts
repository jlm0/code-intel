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
});
