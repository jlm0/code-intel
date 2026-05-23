import { describe, expect, it } from "vitest";

import { resolveIndexPolicy } from "../../src/core/index-policy.js";
import { applyRelationshipGraphFacts, summarizeRelationshipFanOut } from "../../src/indexer/relationship-graph.js";
import { schemaVersion, type CodeEdge, type CodeNode } from "../../src/schema/schemas.js";

describe("relationship graph fan-out policy", () => {
  it("caps transitive call expansion while preserving direct high-confidence edges", () => {
    const source = node("source");
    const middle = node("middle");
    const left = node("left");
    const right = node("right");
    const additions: CodeEdge[] = [];
    const edges = new Map([
      edge("source-middle", source, middle),
      edge("middle-left", middle, left),
      edge("middle-right", middle, right),
    ].map((edgeValue) => [edgeValue.id, edgeValue]));

    applyRelationshipGraphFacts({
      workspaceName: "workspace",
      repo: { name: "repo", commit: "commit" },
      nodes: new Map([source, middle, left, right].map((nodeValue) => [nodeValue.id, nodeValue])),
      edges,
      fileNodes: new Map(),
      astSymbolsByFile: new Map(),
      fileFactsByRelativePath: new Map(),
      policy: resolveIndexPolicy({ profile: "lean", overrides: { graph: { transitiveCallLimit: 1 } } }).graph,
      addNode: (nodeValue) => ({ schemaVersion, ...nodeValue }),
      addEdge: (kind, fromId, toId, workspace, repo, metadata) => {
        additions.push({
          schemaVersion,
          id: `${kind}:${fromId}:${toId}`,
          kind,
          fromId,
          toId,
          workspace,
          repo,
          metadata: metadata ?? {},
        });
      },
    });

    expect(additions.filter((added) => added.metadata.relationship === "transitive-call")).toHaveLength(1);
    expect(summarizeRelationshipFanOut([...edges.values(), ...additions])).toMatchObject({
      logicalEdges: 4,
      byKind: expect.objectContaining({ CALLS: 4 }),
      byOrigin: expect.objectContaining({ "graph-transitive-call": 1 }),
    });
  });
});

function node(name: string): CodeNode {
  return {
    schemaVersion,
    id: name,
    kind: "Function",
    workspace: "workspace",
    repo: "repo",
    file: `src/${name}.ts`,
    name,
    metadata: {
      fileKind: "source",
      ownerRepo: "repo",
      ownerFile: `src/${name}.ts`,
    },
  };
}

function edge(id: string, from: CodeNode, to: CodeNode): CodeEdge {
  return {
    schemaVersion,
    id,
    kind: "CALLS",
    fromId: from.id,
    toId: to.id,
    workspace: "workspace",
    repo: "repo",
    metadata: {
      ownerRepo: "repo",
      ownerFile: from.file,
      origin: "scip-typescript",
      confidence: "high",
      evidenceSources: ["scip-typescript"],
    },
  };
}
