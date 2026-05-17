import type { CodeEdge } from "../schema/schemas.js";
import type { CodeGraphRepository, StoredCodeNode } from "../graph/repository.js";
import {
  buildGraphEdgeIndex,
  buildGraphNodeIndex,
  collectEvidenceSources,
  evidenceSatisfied,
  findGraphPath,
  findOrderedGraphPath,
  type GraphEdgeIndex as TraversalEdgeIndex,
  type GraphNodeIndex as TraversalNodeIndex,
} from "../graph/path-traversal.js";
import type {
  EvalFailureClass,
  GraphCheck,
  GraphEdgeKind,
  GraphEvalCase,
  GraphEvidenceRequirement,
  GraphNodeSelector,
} from "./eval-pack.js";
import type {
  GraphEvalCaseResult,
  GraphPathEdgeResult,
  GraphPathNodeResult,
} from "./results.js";

type NodeIndex = TraversalNodeIndex;
type EdgeIndex = TraversalEdgeIndex;

export async function runGraphEvalCase(
  testCase: GraphEvalCase,
  store: CodeGraphRepository,
): Promise<GraphEvalCaseResult> {
  const start = performance.now();
  const nodeIndex = await buildNodeIndex(store);
  const edgeIndex = await buildEdgeIndex(store);
  const outcome = evaluateGraphCheck(testCase.check, nodeIndex, edgeIndex);
  const latencyMs = Math.round(performance.now() - start);

  return {
    id: testCase.id,
    name: testCase.name,
    gate: testCase.gate,
    status: outcome.passed ? "pass" : "fail",
    check: testCase.check,
    latencyMs,
    actual: outcome.actual,
    failureClass: outcome.passed
      ? undefined
      : (testCase.failureClassHint ?? defaultFailureClass(testCase.check.type)),
  };
}

interface CheckOutcome {
  passed: boolean;
  actual: GraphEvalCaseResult["actual"];
}

function evaluateGraphCheck(
  check: GraphCheck,
  nodes: NodeIndex,
  edges: EdgeIndex,
): CheckOutcome {
  switch (check.type) {
    case "edge-exists":
      return evaluateEdgeExists(check, nodes, edges);
    case "no-edge":
      return evaluateNoEdge(check, nodes, edges);
    case "path-exists":
      return evaluatePathExists(check, nodes, edges);
    case "no-path":
      return evaluateNoPath(check, nodes, edges);
  }
}

function evaluateEdgeExists(
  check: Extract<GraphCheck, { type: "edge-exists" }>,
  nodes: NodeIndex,
  edges: EdgeIndex,
): CheckOutcome {
  const fromNodes = selectNodes(check.from, nodes);
  const toNodes = selectNodes(check.to, nodes);
  if (fromNodes.length === 0 || toNodes.length === 0) {
    return {
      passed: false,
      actual: {
        nodesResolved: { from: fromNodes.length, to: toNodes.length },
        issue:
          fromNodes.length === 0
            ? "from selector resolved to zero nodes"
            : "to selector resolved to zero nodes",
      },
    };
  }
  const toSet = new Set(toNodes.map((node) => node.id));
  const direction = check.direction ?? "outgoing";
  for (const fromNode of fromNodes) {
    for (const candidate of collectDirectedEdges(fromNode.id, edges, direction)) {
      if (!toSet.has(candidate.counterpartId)) {
        continue;
      }
      if (check.allowedKinds && !check.allowedKinds.includes(candidate.edge.kind)) {
        continue;
      }
      if (!evidenceSatisfied(candidate.edge.metadata, check.requireEvidence)) {
        continue;
      }
      return {
        passed: true,
        actual: {
          nodesResolved: { from: fromNodes.length, to: toNodes.length },
          edges: [edgeMetadata(candidate.edge, candidate.direction)],
          path: [pathNodeFromStored(fromNode), pathNodeFromStored(nodes.byId.get(candidate.counterpartId))],
        },
      };
    }
  }
  return {
    passed: false,
    actual: {
      nodesResolved: { from: fromNodes.length, to: toNodes.length },
      issue: `no ${describeEdgeFilter(check.allowedKinds, check.requireEvidence)} edge found in direction ${direction}`,
    },
  };
}

function evaluateNoEdge(
  check: Extract<GraphCheck, { type: "no-edge" }>,
  nodes: NodeIndex,
  edges: EdgeIndex,
): CheckOutcome {
  const fromNodes = selectNodes(check.from, nodes);
  const toNodes = selectNodes(check.to, nodes);
  if (fromNodes.length === 0 || toNodes.length === 0) {
    return {
      passed: true,
      actual: {
        nodesResolved: { from: fromNodes.length, to: toNodes.length },
      },
    };
  }
  const toSet = new Set(toNodes.map((node) => node.id));
  const direction = check.direction ?? "outgoing";
  for (const fromNode of fromNodes) {
    for (const candidate of collectDirectedEdges(fromNode.id, edges, direction)) {
      if (!toSet.has(candidate.counterpartId)) continue;
      if (check.allowedKinds && !check.allowedKinds.includes(candidate.edge.kind)) {
        continue;
      }
      return {
        passed: false,
        actual: {
          nodesResolved: { from: fromNodes.length, to: toNodes.length },
          edges: [edgeMetadata(candidate.edge, candidate.direction)],
          issue: `forbidden edge ${candidate.edge.kind} found`,
        },
      };
    }
  }
  return {
    passed: true,
    actual: {
      nodesResolved: { from: fromNodes.length, to: toNodes.length },
    },
  };
}

function evaluatePathExists(
  check: Extract<GraphCheck, { type: "path-exists" }>,
  nodes: NodeIndex,
  edges: EdgeIndex,
): CheckOutcome {
  const sequence = check.nodes.map((selector) => selectNodes(selector, nodes));
  const counts = sequence.map((group) => group.length);
  const missingIndex = counts.findIndex((count) => count === 0);
  if (missingIndex >= 0) {
    return {
      passed: false,
      actual: {
        nodesResolved: { sequence: counts },
        issue: `node selector #${missingIndex + 1} resolved to zero nodes`,
      },
    };
  }
  const allowedKinds = check.allowedEdgeKinds;
  const requireEvidence = check.requireEvidence;
  const maxDepth = check.maxDepth ?? 4;
  const result = findOrderedGraphPath({
    sequence,
    edgeIndex: edges,
    nodeIndex: nodes,
    options: {
      allowedKinds,
      requireEvidence,
      maxDepth,
      direction: check.direction ?? "outgoing",
    },
  });
  if (!result) {
    return {
      passed: false,
      actual: {
        nodesResolved: { sequence: counts },
        issue: `no path satisfies ${describeEdgeFilter(allowedKinds, requireEvidence)} with maxDepth ${maxDepth}`,
      },
    };
  }
  if (check.maxRank && result.rank > check.maxRank) {
    return {
      passed: false,
      actual: {
        nodesResolved: { sequence: counts },
        path: result.path.map(pathNodeFromStored),
        edges: result.edges.map(({ edge, direction }) => edgeMetadata(edge, direction)),
        rank: result.rank,
        issue: `path rank ${result.rank} exceeds maxRank ${check.maxRank}`,
      },
    };
  }
  return {
    passed: true,
    actual: {
      nodesResolved: { sequence: counts },
      path: result.path.map(pathNodeFromStored),
      edges: result.edges.map(({ edge, direction }) => edgeMetadata(edge, direction)),
      rank: result.rank,
    },
  };
}

function evaluateNoPath(
  check: Extract<GraphCheck, { type: "no-path" }>,
  nodes: NodeIndex,
  edges: EdgeIndex,
): CheckOutcome {
  const fromNodes = selectNodes(check.from, nodes);
  const toNodes = selectNodes(check.to, nodes);
  if (fromNodes.length === 0 || toNodes.length === 0) {
    return {
      passed: true,
      actual: {
        nodesResolved: { from: fromNodes.length, to: toNodes.length },
      },
    };
  }
  const toIds = new Set(toNodes.map((node) => node.id));
  const allowedKinds = check.allowedEdgeKinds;
  const maxDepth = check.maxDepth ?? 4;
  for (const fromNode of fromNodes) {
    const traversal = findGraphPath({
      startIds: new Set([fromNode.id]),
      targetIds: toIds,
      edgeIndex: edges,
      nodeIndex: nodes,
      options: {
        allowedKinds,
        maxDepth,
        direction: check.direction ?? "outgoing",
      },
    });
    if (traversal) {
      return {
        passed: false,
        actual: {
          nodesResolved: { from: fromNodes.length, to: toNodes.length },
          path: traversal.path.map(pathNodeFromStored),
          edges: traversal.edges.map(({ edge, direction }) => edgeMetadata(edge, direction)),
          issue: `forbidden path found via ${traversal.edges.map(({ edge }) => edge.kind).join(" -> ")}`,
        },
      };
    }
  }
  return {
    passed: true,
    actual: {
      nodesResolved: { from: fromNodes.length, to: toNodes.length },
    },
  };
}

interface DirectedEdge {
  edge: CodeEdge;
  counterpartId: string;
  direction: "outgoing" | "incoming";
}

function collectDirectedEdges(
  nodeId: string,
  edges: EdgeIndex,
  direction: "outgoing" | "incoming" | "either",
): DirectedEdge[] {
  if (direction === "outgoing") {
    return (edges.outgoing.get(nodeId) ?? []).map((edge) => ({
      edge,
      counterpartId: edge.toId,
      direction: "outgoing" as const,
    }));
  }
  if (direction === "incoming") {
    return (edges.incoming.get(nodeId) ?? []).map((edge) => ({
      edge,
      counterpartId: edge.fromId,
      direction: "incoming" as const,
    }));
  }
  return [
    ...collectDirectedEdges(nodeId, edges, "outgoing"),
    ...collectDirectedEdges(nodeId, edges, "incoming"),
  ];
}

function selectNodes(selector: GraphNodeSelector, nodes: NodeIndex): StoredCodeNode[] {
  const fileMatcher = selector.file ? compileGlob(selector.file) : undefined;
  const symbolNeedle = selector.symbol?.toLowerCase();
  const matches: StoredCodeNode[] = [];
  for (const node of nodes.list) {
    if (fileMatcher && (!node.file || !fileMatcher.test(node.file))) continue;
    if (selector.symbol) {
      const name = node.name?.toLowerCase();
      if (!name) continue;
      if (name !== symbolNeedle) continue;
    }
    if (selector.kind && node.kind !== selector.kind) continue;
    matches.push(node);
  }
  return matches;
}

function edgeMetadata(edge: CodeEdge, direction?: "outgoing" | "incoming"): GraphPathEdgeResult {
  return {
    kind: edge.kind,
    evidenceSources: collectEvidenceSources(edge.metadata),
    origin: typeof edge.metadata.origin === "string" ? edge.metadata.origin : undefined,
    confidence:
      typeof edge.metadata.confidence === "string" ? edge.metadata.confidence : undefined,
    ownerFile: typeof edge.metadata.ownerFile === "string" ? edge.metadata.ownerFile : undefined,
    range: typeof edge.metadata.range === "object" ? edge.metadata.range : undefined,
    fallbackReason:
      typeof edge.metadata.fallbackReason === "string" ? edge.metadata.fallbackReason : undefined,
    testCaseName:
      typeof edge.metadata.testCaseName === "string" ? edge.metadata.testCaseName : undefined,
    testCaseTitle:
      typeof edge.metadata.testCaseTitle === "string" ? edge.metadata.testCaseTitle : undefined,
    testCaseRange:
      typeof edge.metadata.testCaseRange === "object" ? edge.metadata.testCaseRange : undefined,
    traversalPath:
      Array.isArray(edge.metadata.traversalPath) ? edge.metadata.traversalPath : undefined,
    direction,
  };
}

function pathNodeFromStored(node: StoredCodeNode | undefined): GraphPathNodeResult {
  if (!node) {
    return { id: "<missing>", kind: "Unknown" };
  }
  return {
    id: node.id,
    file: node.file,
    symbol: node.name,
    kind: node.kind,
  };
}

function describeEdgeFilter(
  allowedKinds: GraphEdgeKind[] | undefined,
  requireEvidence: GraphEvidenceRequirement | undefined,
): string {
  const parts: string[] = [];
  if (allowedKinds && allowedKinds.length > 0) {
    parts.push(`edges in {${allowedKinds.join(", ")}}`);
  } else {
    parts.push("any-edge");
  }
  if (requireEvidence) {
    if (typeof requireEvidence === "boolean") {
      parts.push("with-evidence");
    } else if ("anyOf" in requireEvidence) {
      parts.push(`evidence anyOf {${requireEvidence.anyOf.join(", ")}}`);
    } else {
      parts.push(`evidence allOf {${requireEvidence.allOf.join(", ")}}`);
    }
  }
  return parts.join(" ");
}

function defaultFailureClass(checkType: GraphCheck["type"]): EvalFailureClass {
  switch (checkType) {
    case "edge-exists":
    case "no-edge":
      return "graph-edge";
    case "path-exists":
    case "no-path":
      return "graph-traversal";
  }
}

async function buildNodeIndex(store: CodeGraphRepository): Promise<NodeIndex> {
  return buildGraphNodeIndex(await store.getNodes()) as TraversalNodeIndex;
}

async function buildEdgeIndex(store: CodeGraphRepository): Promise<EdgeIndex> {
  return buildGraphEdgeIndex(await store.getEdges()) as TraversalEdgeIndex;
}

function compileGlob(pattern: string): RegExp {
  if (!pattern.includes("*")) {
    return new RegExp(`^${escapeRegExp(pattern)}$`);
  }
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
