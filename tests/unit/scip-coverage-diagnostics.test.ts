import { describe, expect, it } from "vitest";

import { buildIndexDiagnostics, type ScipFileCoverage } from "../../src/diagnostics/index-diagnostics.js";
import { schemaVersion } from "../../src/schema/schemas.js";
import type { FileFact } from "../../src/indexer/fact-cache.js";
import type { DiscoveredWorkspace } from "../../src/workspace/discovery.js";

describe("SCIP coverage diagnostics", () => {
  it("propagates failed shard reasons, coverage ratios, and retry lineage to affected files", () => {
    const workspace = workspaceWithFile("src/large.ts");
    const fileFactsByKey = new Map<string, FileFact>([["repo:src/large.ts", fileFact("src/large.ts")]]);
    const scipCoverageByFile = new Map<string, ScipFileCoverage>([[
      "repo:src/large.ts",
      {
        planned: 2,
        succeeded: 1,
        failed: 1,
        fallback: 0,
        failureReasons: ["scip-oom-retry-exhausted"],
        shardIds: ["package-app", "package-app-retry-1-2"],
        retryLineage: [["package-app", "package-app-retry-1-2"]],
      },
    ]]);

    const diagnostics = buildIndexDiagnostics({
      workspace,
      generatedAt: "2026-05-23T00:00:00.000Z",
      fileFactsByKey,
      scipCountsByFile: new Map([["repo:src/large.ts", { definitions: 2, references: 1 }]]),
      scipCoverageByFile,
      nodes: [{
        schemaVersion,
        id: "file",
        kind: "File",
        workspace: "workspace",
        repo: "repo",
        file: "src/large.ts",
        metadata: {},
      }],
      edges: [],
    });

    expect(diagnostics.files[0]?.lifecycle.scip).toMatchObject({
      status: "warn",
      reason: "scip-oom-retry-exhausted",
      evidence: {
        plannedShards: 2,
        successfulShards: 1,
        failedShards: 1,
        coverageRatio: 0.5,
        retryLineage: [["package-app", "package-app-retry-1-2"]],
      },
    });
  });
});

function workspaceWithFile(relativePath: string): DiscoveredWorkspace {
  return {
    workspaceName: "workspace",
    workspaceRoot: "/repo",
    repos: [{
      name: "repo",
      path: "/repo",
      relativePath: ".",
      commit: "test",
      packageManager: "npm",
      packages: [],
      files: [{
        absolutePath: `/repo/${relativePath}`,
        relativePath,
        language: "typescript",
      }],
    }],
    diagnostics: { files: [] },
  };
}

function fileFact(relativePath: string): FileFact {
  return {
    fingerprint: {
      repo: "repo",
      relativePath,
      language: "typescript",
      size: 10,
      mtimeMs: 1,
      contentHash: "hash",
    },
    chunks: [],
    imports: [],
    exports: [],
    declarations: [],
    calls: [],
    memberAccesses: [],
    typeReferences: [],
    ownerships: [],
    testCases: [],
    callbacks: [],
  };
}
