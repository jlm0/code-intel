import { describe, expect, it } from "vitest";

import { createScipQualityReport } from "../../src/scip/quality.js";

describe("SCIP quality reporting", () => {
  it("flags ok but tiny or empty SCIP output as an explicit warning", () => {
    const quality = createScipQualityReport(
      {
        ok: true,
        outputPath: "/tmp/tiny.scip",
        outputBytes: 92,
        durationMs: 25,
        exitCode: 0,
        stdout: "tiny output",
        stderr: "",
      },
      {
        definitions: [],
        references: [],
        occurrences: [],
      },
    );

    expect(quality).toMatchObject({
      outputBytes: 92,
      durationMs: 25,
      exitCode: 0,
      definitions: 0,
      references: 0,
      occurrences: 0,
      warnings: expect.arrayContaining(["scip-empty-or-tiny"]),
      stdoutSummary: "tiny output",
    });
  });

  it("keeps useful SCIP counts without warning for populated output", () => {
    const quality = createScipQualityReport(
      {
        ok: true,
        outputPath: "/tmp/full.scip",
        outputBytes: 10_000,
        durationMs: 100,
        exitCode: 0,
        stdout: "",
        stderr: "",
      },
      {
        definitions: [{ name: "a" }, { name: "b" }],
        references: [{ symbolName: "a" }],
        occurrences: [{ symbolName: "a" }, { symbolName: "b" }, { symbolName: "c" }],
      },
    );

    expect(quality).toMatchObject({
      outputBytes: 10_000,
      definitions: 2,
      references: 1,
      occurrences: 3,
      warnings: [],
    });
  });
});
