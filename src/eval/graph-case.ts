import type { CodeEdge } from "../schema/schemas.js";
import type { CodeGraphRepository, StoredCodeNode } from "../graph/repository.js";
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

interface NodeIndex {
  byId: Map<string, StoredCodeNode>;
  list: StoredCodeNode[];
}

interface EdgeIndex {
  outgoing: Map<string, CodeEdge[]>;
  incoming: Map<string, CodeEdge[]>;
}

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
    const candidateEdges = collectEdges(fromNode.id, edges, direction);
    for (const edge of candidateEdges) {
      const counterpart = direction === "incoming" ? edge.fromId : edge.toId;
      if (!toSet.has(counterpart)) {
        continue;
      }
      if (check.allowedKinds && !check.allowedKinds.includes(edge.kind)) {
        continue;
      }
      if (!evidenceSatisfied(edge.metadata, check.requireEvidence)) {
        continue;
      }
      return {
        passed: true,
        actual: {
          nodesResolved: { from: fromNodes.length, to: toNodes.length },
          edges: [edgeMetadata(edge)],
          path: [pathNodeFromStored(fromNode), pathNodeFromStored(nodes.byId.get(counterpart))],
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
    for (const edge of collectEdges(fromNode.id, edges, direction)) {
      const counterpart = direction === "incoming" ? edge.fromId : edge.toId;
      if (!toSet.has(counterpart)) continue;
      if (check.allowedKinds && !check.allowedKinds.includes(edge.kind)) {
        continue;
      }
      return {
        passed: false,
        actual: {
          nodesResolved: { from: fromNodes.length, to: toNodes.length },
          edges: [edgeMetadata(edge)],
          issue: `forbidden edge ${edge.kind} found`,
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
  const result = findOrderedPath({
    sequence,
    edges,
    nodeIndex: nodes,
    allowedKinds,
    requireEvidence,
    maxDepth,
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
  return {
    passed: true,
    actual: {
      nodesResolved: { sequence: counts },
      path: result.path.map(pathNodeFromStored),
      edges: result.edges.map(edgeMetadata),
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
    const traversal = breadthFirstSearch({
      start: fromNode.id,
      targetIds: toIds,
      edges,
      nodeIndex: nodes,
      allowedKinds,
      maxDepth,
    });
    if (traversal) {
      return {
        passed: false,
        actual: {
          nodesResolved: { from: fromNodes.length, to: toNodes.length },
          path: traversal.path.map(pathNodeFromStored),
          edges: traversal.edges.map(edgeMetadata),
          issue: `forbidden path found via ${traversal.edges.map((edge) => edge.kind).join(" -> ")}`,
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

interface OrderedPathResult {
  path: StoredCodeNode[];
  edges: CodeEdge[];
}

interface OrderedPathInput {
  sequence: StoredCodeNode[][];
  edges: EdgeIndex;
  nodeIndex: NodeIndex;
  allowedKinds?: GraphEdgeKind[];
  requireEvidence?: GraphEvidenceRequirement;
  maxDepth: number;
}

function findOrderedPath(input: OrderedPathInput): OrderedPathResult | undefined {
  const [firstGroup, ...remainingGroups] = input.sequence;
  for (const startNode of firstGroup) {
    const result = walkOrderedPath({
      currentPath: [startNode],
      currentEdges: [],
      remaining: remainingGroups,
      ...input,
    });
    if (result) {
      return result;
    }
  }
  return undefined;
}

interface OrderedWalkInput extends OrderedPathInput {
  currentPath: StoredCodeNode[];
  currentEdges: CodeEdge[];
  remaining: StoredCodeNode[][];
}

function walkOrderedPath(input: OrderedWalkInput): OrderedPathResult | undefined {
  if (input.remaining.length === 0) {
    return { path: input.currentPath, edges: input.currentEdges };
  }
  const [nextGroup, ...rest] = input.remaining;
  const targetIds = new Set(nextGroup.map((node) => node.id));
  const current = input.currentPath[input.currentPath.length - 1];
  const traversal = breadthFirstSearch({
    start: current.id,
    targetIds,
    edges: input.edges,
    nodeIndex: input.nodeIndex,
    allowedKinds: input.allowedKinds,
    requireEvidence: input.requireEvidence,
    maxDepth: input.maxDepth,
    forbidIds: new Set(input.currentPath.slice(0, -1).map((node) => node.id)),
  });
  if (!traversal) {
    return undefined;
  }
  const mergedPath = [...input.currentPath, ...traversal.path.slice(1)];
  const mergedEdges = [...input.currentEdges, ...traversal.edges];
  return walkOrderedPath({
    ...input,
    currentPath: mergedPath,
    currentEdges: mergedEdges,
    remaining: rest,
  });
}

interface BfsInput {
  start: string;
  targetIds: Set<string>;
  edges: EdgeIndex;
  nodeIndex: NodeIndex;
  allowedKinds?: GraphEdgeKind[];
  requireEvidence?: GraphEvidenceRequirement;
  maxDepth: number;
  forbidIds?: Set<string>;
}

interface BfsResult {
  path: StoredCodeNode[];
  edges: CodeEdge[];
}

function breadthFirstSearch(input: BfsInput): BfsResult | undefined {
  const startNode = input.nodeIndex.byId.get(input.start);
  if (!startNode) {
    return undefined;
  }
  if (input.targetIds.has(input.start)) {
    return { path: [startNode], edges: [] };
  }
  interface QueueEntry {
    id: string;
    path: StoredCodeNode[];
    edges: CodeEdge[];
  }
  const queue: QueueEntry[] = [{ id: input.start, path: [startNode], edges: [] }];
  const visited = new Set<string>([input.start, ...(input.forbidIds ?? [])]);
  while (queue.length > 0) {
    const head = queue.shift();
    if (!head) continue;
    if (head.edges.length >= input.maxDepth) continue;
    const outgoing = input.edges.outgoing.get(head.id) ?? [];
    for (const edge of outgoing) {
      if (input.allowedKinds && !input.allowedKinds.includes(edge.kind)) continue;
      if (!evidenceSatisfied(edge.metadata, input.requireEvidence)) continue;
      if (visited.has(edge.toId)) continue;
      const nextNode = input.nodeIndex.byId.get(edge.toId);
      if (!nextNode) continue;
      const nextPath = [...head.path, nextNode];
      const nextEdges = [...head.edges, edge];
      if (input.targetIds.has(edge.toId)) {
        return { path: nextPath, edges: nextEdges };
      }
      visited.add(edge.toId);
      queue.push({ id: edge.toId, path: nextPath, edges: nextEdges });
    }
  }
  return undefined;
}

function collectEdges(
  nodeId: string,
  edges: EdgeIndex,
  direction: "outgoing" | "incoming" | "either",
): CodeEdge[] {
  if (direction === "outgoing") {
    return edges.outgoing.get(nodeId) ?? [];
  }
  if (direction === "incoming") {
    return edges.incoming.get(nodeId) ?? [];
  }
  return [...(edges.outgoing.get(nodeId) ?? []), ...(edges.incoming.get(nodeId) ?? [])];
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

function evidenceSatisfied(
  metadata: Record<string, unknown>,
  requirement: GraphEvidenceRequirement | undefined,
): boolean {
  if (!requirement) return true;
  const sources = collectEvidenceSources(metadata);
  if (typeof requirement === "boolean") {
    return requirement ? sources.length > 0 : true;
  }
  if ("anyOf" in requirement) {
    return requirement.anyOf.some((source) => sources.includes(source));
  }
  return requirement.allOf.every((source) => sources.includes(source));
}

function collectEvidenceSources(metadata: Record<string, unknown>): string[] {
  const sources = new Set<string>();
  const raw = metadata.evidenceSources;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === "string" && entry.length > 0) {
        sources.add(entry);
      }
    }
  }
  if (typeof metadata.origin === "string" && metadata.origin.length > 0) {
    sources.add(metadata.origin);
  }
  return [...sources];
}

function edgeMetadata(edge: CodeEdge): GraphPathEdgeResult {
  return {
    kind: edge.kind,
    evidenceSources: collectEvidenceSources(edge.metadata),
    origin: typeof edge.metadata.origin === "string" ? edge.metadata.origin : undefined,
    confidence:
      typeof edge.metadata.confidence === "string" ? edge.metadata.confidence : undefined,
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
  const list = await store.getNodes();
  const byId = new Map<string, StoredCodeNode>();
  for (const node of list) {
    byId.set(node.id, node);
  }
  return { byId, list };
}

async function buildEdgeIndex(store: CodeGraphRepository): Promise<EdgeIndex> {
  const allEdges = await store.getEdges();
  const outgoing = new Map<string, CodeEdge[]>();
  const incoming = new Map<string, CodeEdge[]>();
  for (const edge of allEdges) {
    appendToBucket(outgoing, edge.fromId, edge);
    appendToBucket(incoming, edge.toId, edge);
  }
  return { outgoing, incoming };
}

function appendToBucket(map: Map<string, CodeEdge[]>, key: string, value: CodeEdge): void {
  const bucket = map.get(key);
  if (bucket) {
    bucket.push(value);
  } else {
    map.set(key, [value]);
  }
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
