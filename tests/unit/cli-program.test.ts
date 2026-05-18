import { describe, expect, it, vi } from "vitest";

import { createCliProgram } from "../../src/cli/program.js";

describe("createCliProgram", () => {
  it("registers the required command surface", () => {
    const program = createCliProgram();

    expect(program.commands.map((command) => command.name()).sort()).toEqual([
      "benchmark",
      "callees",
      "callers",
      "diagnose",
      "eval",
      "expand-context",
      "find-symbol",
      "get-context",
      "health",
      "index",
      "mcp",
      "references",
      "relationships",
      "search",
      "semantic",
      "status",
      "trace-path",
      "update",
    ]);
  });

  it("registers diagnostic subcommands", () => {
    const diagnose = createCliProgram().commands.find((command) => command.name() === "diagnose");

    expect(diagnose?.commands.map((command) => command.name()).sort()).toEqual(["file", "symbol"]);
  });

  it("registers graph traversal options for relationship browsing", () => {
    const relationships = createCliProgram().commands.find((command) => command.name() === "relationships");

    expect(relationships?.description()).toContain("typed graph relationships");
    expect(relationships?.options.map((option) => option.long).sort()).toEqual(
      expect.arrayContaining(["--depth", "--direction", "--edge-kind", "--json", "--limit"]),
    );
  });

  it("delegates command actions to injected handlers", async () => {
    const status = vi.fn(async () => ({ ok: true }));
    const program = createCliProgram({
      actions: { status },
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    });

    await program.parseAsync(["node", "code-intel", "status", "--json"], {
      from: "node",
    });

    expect(status).toHaveBeenCalledWith(
      expect.objectContaining({ json: true }),
    );
  });

  it("delegates relationship browsing with edge-kind and direction options", async () => {
    const relationships = vi.fn(async () => ({ ok: true }));
    const program = createCliProgram({
      actions: { relationships },
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    });

    await program.parseAsync([
      "node",
      "code-intel",
      "relationships",
      "calculateGivingTotal",
      "--edge-kind",
      "CALLS",
      "REFERENCES",
      "--direction",
      "incoming",
      "--limit",
      "7",
      "--json",
    ], {
      from: "node",
    });

    expect(relationships).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "incoming",
        edgeKind: ["CALLS", "REFERENCES"],
        json: true,
        limit: 7,
      }),
      "calculateGivingTotal",
    );
  });
});
