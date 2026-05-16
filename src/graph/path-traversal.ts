import type { CodeEdge } from "../schema/schemas.js";
import type { StoredCodeNode } from "./repository.js";

export type GraphTraversalDirection = "outgoing" | "incoming" | "either";

export type GraphEvidenceRequirement =
  | boolean
  | { anyOf: string[] }
  | { allOf: string[] };

export interface GraphNodeIndex {
  byId: Map<string, StoredCodeNode>;
  list: StoredCodeNode[];
}

export interface GraphEdgeIndex {
  outgoing: Map<string, CodeEdge[]>;
  incoming: Map<string, CodeEdge[]>;
}

export interface TraversedGraphEdge {
  edge: CodeEdge;
  from: StoredCodeNode;
  to: StoredCodeNode;
  direction: "outgoing" | "incoming";
  score: number;
}

export interface GraphPathTraversalResult {
  path: StoredCodeNode[];
  edges: TraversedGraphEdge[];
  rank: number;
  score: number;
}

export interface GraphPathTraversalOptions {
  allowedKinds?: CodeEdge["kind"][];
  requireEvidence?: GraphEvidenceRequirement;
  maxDepth: number;
  direction?: GraphTraversalDirection;
  allowPackageIntermediates?: boolean;
}

export function buildGraphNodeIndex(nodes: StoredCodeNode[]): GraphNodeIndex {
  return {
    byId: new Map(nodes.map((node) => [node.id, node])),
    list: nodes,
  };
}

export function buildGraphEdgeIndex(edges: CodeEdge[]): GraphEdgeIndex {
  const outgoing = new Map<string, CodeEdge[]>();
  const incoming = new Map<string, CodeEdge[]>();
  for (const edge of edges) {
    appendToBucket(outgoing, edge.fromId, edge);
    appendToBucket(incoming, edge.toId, edge);
  }
  return { outgoing, incoming };
}

export function findGraphPath(input: {
  startIds: Set<string>;
  targetIds: Set<string>;
  nodeIndex: GraphNodeIndex;
  edgeIndex: GraphEdgeIndex;
  options: GraphPathTraversalOptions;
  forbidIds?: Set<string>;
}): GraphPathTraversalResult | undefined {
  const direction = input.options.direction ?? "outgoing";
  const queue: Array<{
    id: string;
    path: StoredCodeNode[];
    edges: TraversedGraphEdge[];
    score: number;
  }> = [];
  for (const startId of input.startIds) {
    const start = input.nodeIndex.byId.get(startId);
    if (!start) {
      continue;
    }
    if (input.targetIds.has(startId)) {
      return { path: [start], edges: [], rank: 1, score: 0 };
    }
    queue.push({ id: startId, path: [start], edges: [], score: 0 });
  }

  const bestDepthByNode = new Map<string, number>();
  for (const startId of input.startIds) {
    bestDepthByNode.set(startId, 0);
  }
  for (const forbidId of input.forbidIds ?? []) {
    bestDepthByNode.set(forbidId, 0);
  }

  let bestResult: GraphPathTraversalResult | undefined;
  let expansions = 0;
  const maxExpansions = 5_000;
  while (queue.length > 0 && expansions < maxExpansions) {
    queue.sort((left, right) => right.score - left.score || left.edges.length - right.edges.length);
    const head = queue.shift();
    if (!head || head.edges.length >= input.options.maxDepth) {
      continue;
    }
    expansions += 1;

    for (const next of collectTraversableEdges(head.id, input.edgeIndex, input.nodeIndex, direction)) {
      if (input.options.allowedKinds && !input.options.allowedKinds.includes(next.edge.kind)) {
        continue;
      }
      if (!evidenceSatisfied(next.edge.metadata, input.options.requireEvidence)) {
        continue;
      }
      const nextDepth = head.edges.length + 1;
      const previousBestDepth = bestDepthByNode.get(next.to.id);
      if (previousBestDepth !== undefined && previousBestDepth <= nextDepth) {
        continue;
      }
      const traversedEdge = {
        ...next,
        score: scoreGraphEdge(next.edge, next.direction),
      };
      const nextPath = [...head.path, next.to];
      const nextEdges = [...head.edges, traversedEdge];
      const nextScore = head.score + traversedEdge.score - nextDepth;
      if (input.targetIds.has(next.to.id)) {
        const candidate = {
          path: nextPath,
          edges: nextEdges,
          rank: 1,
          score: nextScore,
        };
        bestResult = betterPath(candidate, bestResult);
        continue;
      }
      if (shouldSkipIntermediateNode(next.to, input.targetIds, input.options)) {
        continue;
      }
      bestDepthByNode.set(next.to.id, nextDepth);
      queue.push({
        id: next.to.id,
        path: nextPath,
        edges: nextEdges,
        score: nextScore,
      });
    }
  }
  return bestResult ? { ...bestResult, rank: 1 } : undefined;
}

export function findOrderedGraphPath(input: {
  sequence: StoredCodeNode[][];
  nodeIndex: GraphNodeIndex;
  edgeIndex: GraphEdgeIndex;
  options: GraphPathTraversalOptions;
}): GraphPathTraversalResult | undefined {
  const [firstGroup, ...remainingGroups] = input.sequence;
  for (const startNode of firstGroup ?? []) {
    const result = walkOrderedPath({
      currentPath: [startNode],
      currentEdges: [],
      remaining: remainingGroups,
      score: 0,
      nodeIndex: input.nodeIndex,
      edgeIndex: input.edgeIndex,
      options: input.options,
    });
    if (result) {
      return result;
    }
  }
  return undefined;
}

function walkOrderedPath(input: {
  currentPath: StoredCodeNode[];
  currentEdges: TraversedGraphEdge[];
  remaining: StoredCodeNode[][];
  score: number;
  nodeIndex: GraphNodeIndex;
  edgeIndex: GraphEdgeIndex;
  options: GraphPathTraversalOptions;
}): GraphPathTraversalResult | undefined {
  if (input.remaining.length === 0) {
    return {
      path: input.currentPath,
      edges: input.currentEdges,
      rank: 1,
      score: input.score,
    };
  }
  const [nextGroup, ...rest] = input.remaining;
  const current = input.currentPath[input.currentPath.length - 1];
  if (!current) {
    return undefined;
  }
  const segment = findGraphPath({
    startIds: new Set([current.id]),
    targetIds: new Set(nextGroup.map((node) => node.id)),
    nodeIndex: input.nodeIndex,
    edgeIndex: input.edgeIndex,
    options: input.options,
    forbidIds: new Set(input.currentPath.slice(0, -1).map((node) => node.id)),
  });
  if (!segment) {
    return undefined;
  }
  return walkOrderedPath({
    currentPath: [...input.currentPath, ...segment.path.slice(1)],
    currentEdges: [...input.currentEdges, ...segment.edges],
    remaining: rest,
    score: input.score + segment.score,
    nodeIndex: input.nodeIndex,
    edgeIndex: input.edgeIndex,
    options: input.options,
  });
}

export function evidenceSatisfied(
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

export function collectEvidenceSources(metadata: Record<string, unknown>): string[] {
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
  return [...sources].sort();
}

export function scoreGraphEdge(edge: CodeEdge, direction: "outgoing" | "incoming" = "outgoing"): number {
  return edgeKindScore(edge.kind)
    + evidenceScore(collectEvidenceSources(edge.metadata))
    + confidenceScore(edge.metadata.confidence)
    + (direction === "incoming" ? -5 : 0);
}

function collectTraversableEdges(
  nodeId: string,
  edgeIndex: GraphEdgeIndex,
  nodeIndex: GraphNodeIndex,
  direction: GraphTraversalDirection,
): TraversedGraphEdge[] {
  const traversed: TraversedGraphEdge[] = [];
  if (direction === "outgoing" || direction === "either") {
    for (const edge of edgeIndex.outgoing.get(nodeId) ?? []) {
      const from = nodeIndex.byId.get(edge.fromId);
      const to = nodeIndex.byId.get(edge.toId);
      if (from && to) {
        traversed.push({ edge, from, to, direction: "outgoing", score: scoreGraphEdge(edge, "outgoing") });
      }
    }
  }
  if (direction === "incoming" || direction === "either") {
    for (const edge of edgeIndex.incoming.get(nodeId) ?? []) {
      const from = nodeIndex.byId.get(edge.toId);
      const to = nodeIndex.byId.get(edge.fromId);
      if (from && to) {
        traversed.push({ edge, from, to, direction: "incoming", score: scoreGraphEdge(edge, "incoming") });
      }
    }
  }
  return traversed.sort((left, right) => right.score - left.score || left.edge.id.localeCompare(right.edge.id));
}

function appendToBucket(map: Map<string, CodeEdge[]>, key: string, value: CodeEdge): void {
  const bucket = map.get(key);
  if (bucket) {
    bucket.push(value);
  } else {
    map.set(key, [value]);
  }
}

function edgeKindScore(kind: CodeEdge["kind"]): number {
  switch (kind) {
    case "CALLS":
    case "TESTS":
      return 40;
    case "IMPORTS":
    case "EXPORTS":
    case "REFERENCES":
      return 30;
    case "DEFINES":
    case "HAS_CHUNK":
      return 10;
    case "MENTIONS":
      return 1;
    default:
      return 5;
  }
}

function evidenceScore(sources: string[]): number {
  let score = 0;
  if (sources.includes("scip-typescript")) score += 40;
  if (sources.includes("module-resolution")) score += 25;
  if (sources.some((source) => source.startsWith("tree-sitter"))) score += 10;
  return score;
}

function confidenceScore(confidence: unknown): number {
  switch (confidence) {
    case "high":
      return 20;
    case "medium":
      return 10;
    case "fallback":
      return 2;
    default:
      return 0;
  }
}

function betterPath(
  candidate: GraphPathTraversalResult,
  current: GraphPathTraversalResult | undefined,
): GraphPathTraversalResult {
  if (!current) {
    return candidate;
  }
  if (candidate.score !== current.score) {
    return candidate.score > current.score ? candidate : current;
  }
  if (candidate.edges.length !== current.edges.length) {
    return candidate.edges.length < current.edges.length ? candidate : current;
  }
  return candidate.path.map((node) => node.id).join("\0") < current.path.map((node) => node.id).join("\0")
    ? candidate
    : current;
}

function shouldSkipIntermediateNode(
  node: StoredCodeNode,
  targetIds: Set<string>,
  options: GraphPathTraversalOptions,
): boolean {
  if (targetIds.has(node.id)) {
    return false;
  }
  if (node.kind !== "Package") {
    return false;
  }
  if (options.allowPackageIntermediates) {
    return false;
  }
  return !(options.allowedKinds ?? []).includes("DEPENDS_ON");
}
