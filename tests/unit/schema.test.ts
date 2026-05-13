import { describe, expect, it } from "vitest";

import {
  CodeNodeSchema,
  IndexManifestSchema,
  QueryResultSchema,
  schemaVersion,
} from "../../src/schema/schemas.js";

describe("schema contracts", () => {
  it("accepts a valid symbol node", () => {
    expect(
      CodeNodeSchema.parse({
        schemaVersion,
        id: "symbol:fixture:repo@abc:file.ts#thing",
        kind: "Symbol",
        workspace: "fixture",
        repo: "repo",
        file: "file.ts",
        name: "thing",
        range: { startLine: 1, endLine: 3 },
        metadata: {},
      }),
    ).toMatchObject({ kind: "Symbol", name: "thing" });
  });

  it("rejects invalid node kinds", () => {
    expect(() =>
      CodeNodeSchema.parse({
        schemaVersion,
        id: "bad",
        kind: "Unknown",
        workspace: "fixture",
        repo: "repo",
        metadata: {},
      }),
    ).toThrow();
  });

  it("keeps manifest artifacts versioned", () => {
    expect(
      IndexManifestSchema.parse({
        schemaVersion,
        workspace: "fixture",
        generatedAt: "2026-05-13T00:00:00.000Z",
        indexPath: "/tmp/index",
        repos: [],
        stats: { nodes: 0, edges: 0, chunks: 0 },
        health: [],
      }),
    ).toMatchObject({ schemaVersion });
  });

  it("validates query payloads before CLI and MCP output", () => {
    expect(
      QueryResultSchema.parse({
        schemaVersion,
        query: "use session",
        results: [],
      }),
    ).toMatchObject({ query: "use session" });
  });
});
