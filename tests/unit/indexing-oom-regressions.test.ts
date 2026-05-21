import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readIndexProgress,
  readIndexWriteLockState,
  writeIndexProgress,
} from "../../src/core/progress.js";
import { applyRelationshipGraphFacts } from "../../src/indexer/relationship-graph.js";
import { IndexProgressEventSchema, schemaVersion, type CodeEdge, type CodeNode } from "../../src/schema/schemas.js";
import type { FileFact } from "../../src/indexer/fact-cache.js";

type AddedEdge = {
  kind: CodeEdge["kind"];
  fromId: string;
  toId: string;
  repo: string;
  metadata?: Record<string, unknown>;
};

describe("indexing OOM graph regressions", () => {
  it("does not expand transitive calls from previously indexed repos while graphing the current repo", () => {
    const repoAFirst = sourceFunction("repo-a:first", "repo-a", "first");
    const repoASecond = sourceFunction("repo-a:second", "repo-a", "second");
    const repoAThird = sourceFunction("repo-a:third", "repo-a", "third");
    const additions = applyRelationshipPass({
      currentRepo: "repo-b",
      nodes: [repoAFirst, repoASecond, repoAThird],
      edges: [
        callEdge("repo-a:first->second", repoAFirst.id, repoASecond.id, "repo-a"),
        callEdge("repo-a:second->third", repoASecond.id, repoAThird.id, "repo-a"),
      ],
    });

    expect(additions).toEqual([]);
  });

  it("deduplicates evidence-specific call edges before transitive expansion", () => {
    const source = sourceFunction("repo-a:source", "repo-a", "source");
    const intermediate = sourceFunction("repo-a:intermediate", "repo-a", "intermediate");
    const target = sourceFunction("repo-a:target", "repo-a", "target");
    const additions = applyRelationshipPass({
      currentRepo: "repo-a",
      nodes: [source, intermediate, target],
      edges: [
        callEdge("canonical-source-intermediate", source.id, intermediate.id, "repo-a"),
        callEdge("evidence-source-intermediate", source.id, intermediate.id, "repo-a", {
          evidenceSources: ["tree-sitter-call", "call-evidence-promotion"],
        }),
        callEdge("canonical-intermediate-target", intermediate.id, target.id, "repo-a"),
      ],
    });

    expect(additions.filter((edge) => edge.kind === "CALLS" && edge.fromId === source.id && edge.toId === target.id))
      .toHaveLength(1);
  });

  it("does not resolve imported member calls through same-relative-path edges from another repo", () => {
    const foreignTarget = sourceFunction("repo-a:api-run", "repo-a", "run", "src/api.ts");
    const currentSource = sourceFunction("repo-b:use-api", "repo-b", "useApi", "src/use.ts");
    const additions = applyRelationshipPass({
      currentRepo: "repo-b",
      nodes: [foreignTarget, currentSource],
      astSymbolsByFile: new Map([["src/use.ts", [currentSource]]]),
      fileFactsByRelativePath: new Map([[
        "src/use.ts",
        fileFact("repo-b", "src/use.ts", {
          imports: [importFact("src/use.ts", "./api", "api")],
          calls: [memberCallFact("src/use.ts", "api.run", "api", "run", "useApi")],
        }),
      ]]),
      edges: [
        {
          ...referenceEdge("repo-a:import-api", "repo-a:file-use", foreignTarget.id, "repo-a"),
          kind: "IMPORTS",
          metadata: {
            ownerRepo: "repo-a",
            ownerFile: "src/use.ts",
            moduleSpecifier: "./api",
            localName: "api",
            targetSymbolId: foreignTarget.id,
          },
        },
      ],
    });

    expect(additions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "CALLS",
          toId: foreignTarget.id,
        }),
      ]),
    );
  });

  it("does not re-promote existing call-evidence references during relationship graphing", () => {
    const source = sourceFunction("repo-a:source", "repo-a", "source");
    const target = sourceFunction("repo-a:target", "repo-a", "target");
    const additions = applyRelationshipPass({
      currentRepo: "repo-a",
      nodes: [source, target],
      edges: [
        referenceEdge("repo-a:call-reference", source.id, target.id, "repo-a", {
          roles: ["Call"],
          evidenceSources: ["tree-sitter-call"],
        }),
      ],
    });

    expect(additions.filter((edge) => edge.kind === "CALLS")).toEqual([]);
  });
});

describe("indexing OOM progress and lock regressions", () => {
  it("keeps an alive CPU-bound graph step running when its heartbeat is late", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-progress-red-"));
    try {
      await writeIndexProgress(indexPath, {
        schemaVersion,
        runId: "run-cpu-bound",
        operation: "index",
        status: "running",
        phase: "graph",
        message: "Applying relationship graph",
        indexPath,
        pid: 12345,
        startedAt: "2026-05-21T15:10:30.000Z",
        updatedAt: "2026-05-21T15:10:30.000Z",
        currentRepo: "user-management",
        currentStep: "relationship-graph",
        counters: {},
      });

      await expect(readIndexProgress(indexPath, {
        isPidAlive: () => true,
        now: new Date("2026-05-21T15:20:30.000Z"),
        staleAfterMs: 60_000,
      })).resolves.toMatchObject({
        status: "running",
        staleReason: undefined,
      });
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });

  it("accepts durable step_progress events for long graph substeps", () => {
    expect(() =>
      IndexProgressEventSchema.parse({
        schemaVersion,
        runId: "run-step-progress",
        operation: "index",
        event: "step_progress",
        phase: "graph",
        message: "Relationship graph progress",
        indexPath: "/tmp/code-intel-index",
        pid: 12345,
        timestamp: "2026-05-21T15:15:30.000Z",
        currentRepo: "user-management",
        currentStep: "relationship-graph",
        counters: {
          edgesWritten: 100,
        },
        memory: {
          rssMb: 512,
          heapUsedMb: 256,
        },
        warnings: [],
      })
    ).not.toThrow();
  });

  it("does not treat an old live-pid write lock as held without owner freshness evidence", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-lock-red-"));
    const lockPath = join(indexPath, ".index-write.lock");
    try {
      await mkdir(lockPath);
      await writeFile(
        join(lockPath, "owner.json"),
        JSON.stringify({
          pid: 12345,
          createdAt: "2026-05-20T00:00:00.000Z",
        }),
      );

      await expect(readIndexWriteLockState(indexPath, {
        isPidAlive: () => true,
        now: new Date("2026-05-21T15:20:30.000Z"),
      })).resolves.toMatchObject({
        status: "stale",
      });
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });
});

function applyRelationshipPass(input: {
  currentRepo: string;
  nodes: CodeNode[];
  edges?: CodeEdge[];
  astSymbolsByFile?: Map<string, CodeNode[]>;
  fileFactsByRelativePath?: Map<string, FileFact>;
}): AddedEdge[] {
  const additions: AddedEdge[] = [];
  const nodes = new Map(input.nodes.map((node) => [node.id, node]));
  const edges = new Map((input.edges ?? []).map((edge) => [edge.id, edge]));
  applyRelationshipGraphFacts({
    workspaceName: "workspace",
    repo: {
      name: input.currentRepo,
      commit: "commit",
    },
    nodes,
    edges,
    fileNodes: new Map(),
    astSymbolsByFile: input.astSymbolsByFile ?? new Map(),
    fileFactsByRelativePath: input.fileFactsByRelativePath ?? new Map(),
    addNode: (node) => {
      const parsed = { schemaVersion, ...node };
      nodes.set(parsed.id, parsed);
      return parsed;
    },
    addEdge: (kind, fromId, toId, _workspace, repo, metadata) => {
      additions.push({ kind, fromId, toId, repo, metadata });
    },
  });
  return additions;
}

function sourceFunction(id: string, repo: string, name: string, file = `src/${name}.ts`): CodeNode {
  return {
    schemaVersion,
    id,
    kind: "Function",
    workspace: "workspace",
    repo,
    file,
    name,
    language: "typescript",
    range: { startLine: 1, endLine: 20, startColumn: 0, endColumn: 1 },
    metadata: {
      ownerRepo: repo,
      ownerFile: file,
      fileKind: "source",
      qualifiedName: name,
    },
  };
}

function callEdge(
  id: string,
  fromId: string,
  toId: string,
  repo: string,
  metadata: Record<string, unknown> = {},
): CodeEdge {
  return {
    schemaVersion,
    id,
    kind: "CALLS",
    fromId,
    toId,
    workspace: "workspace",
    repo,
    metadata: {
      ownerRepo: repo,
      ownerFile: "src/calls.ts",
      evidenceSources: ["tree-sitter-call"],
      roles: ["Call"],
      ...metadata,
    },
  };
}

function referenceEdge(
  id: string,
  fromId: string,
  toId: string,
  repo: string,
  metadata: Record<string, unknown> = {},
): CodeEdge {
  return {
    schemaVersion,
    id,
    kind: "REFERENCES",
    fromId,
    toId,
    workspace: "workspace",
    repo,
    metadata: {
      ownerRepo: repo,
      ownerFile: "src/use.ts",
      evidenceSources: ["tree-sitter-member-access"],
      ...metadata,
    },
  };
}

function fileFact(
  repo: string,
  relativePath: string,
  facts: Partial<Pick<FileFact, "imports" | "calls">> = {},
): FileFact {
  return {
    fingerprint: {
      repo,
      relativePath,
      language: "typescript",
      size: 1,
      mtimeMs: 1,
      contentHash: `${repo}:${relativePath}`,
    },
    chunks: [],
    imports: facts.imports ?? [],
    exports: [],
    declarations: [],
    calls: facts.calls ?? [],
    memberAccesses: [],
    typeReferences: [],
    ownerships: [],
    testCases: [],
    callbacks: [],
  };
}

function importFact(ownerFile: string, moduleSpecifier: string, localName: string): FileFact["imports"][number] {
  return {
    idSuffix: `import-${localName}`,
    range: { startLine: 1, endLine: 1, startColumn: 0, endColumn: 10 },
    sourceText: `import * as ${localName} from "${moduleSpecifier}"`,
    contentHash: `import-${localName}`,
    ownerFile,
    moduleSpecifier,
    importKind: "value",
    localName,
    isDefault: false,
    isNamespace: true,
  };
}

function memberCallFact(
  ownerFile: string,
  memberPath: string,
  receiver: string,
  propertyName: string,
  containingDeclarationName: string,
): FileFact["calls"][number] {
  return {
    idSuffix: `call-${memberPath}`,
    range: { startLine: 2, endLine: 2, startColumn: 2, endColumn: 15 },
    sourceText: `${memberPath}()`,
    contentHash: `call-${memberPath}`,
    ownerFile,
    name: propertyName,
    callKind: "member",
    memberPath,
    receiver,
    propertyName,
    optionalChain: false,
    containingDeclarationName,
  };
}
