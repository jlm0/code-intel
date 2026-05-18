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
});
