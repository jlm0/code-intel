import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";
import { beforeAll, describe, expect, it } from "vitest";

const cliPath = new URL("../../dist/cli/main.js", import.meta.url).pathname;

describe("code-intel process behavior", () => {
  beforeAll(async () => {
    await execa("npm", ["run", "build"]);
  });

  it("prints help to stdout", async () => {
    const result = await execa("node", [cliPath, "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: code-intel");
    expect(result.stderr).toBe("");
  });

  it("returns JSON health checks", async () => {
    const result = await execa("node", [cliPath, "health", "--json"]);
    const payload = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.schemaVersion).toBe("code-intel.v1");
    expect(payload.checks.map((check: { name: string }) => check.name)).toContain("node");
    expect(payload.status).toMatch(/^(ok|warn|fail)$/);
    expect(result.stderr).toBe("");
  });

  it("returns status before indexing", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-status-"));
    try {
      const result = await execa("node", [
        cliPath,
        "status",
        "--index-path",
        indexPath,
        "--json",
      ]);
      const payload = JSON.parse(result.stdout);

      expect(payload.indexed).toBe(false);
      expect(payload.indexPath).toBe(indexPath);
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });

  it("rejects invalid arguments with stderr and nonzero exit", async () => {
    const result = await execa("node", [cliPath, "find-symbol"], {
      reject: false,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("missing required argument");
  });
});
