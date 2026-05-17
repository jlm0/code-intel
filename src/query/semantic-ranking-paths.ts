import type { CodeEdge } from "../schema/schemas.js";
import type {
  CodeGraphRepository,
  SemanticSearchFilters,
  StoredCodeNode,
} from "../graph/repository.js";
import {
  addReason,
  evidenceSources,
  isTestNode,
  kindRank,
  lexicalCandidates,
  passesFilters,
  roundScore,
} from "./semantic-ranking-model.js";
import { ensureCandidate } from "./semantic-ranking-candidates.js";
import {
  pathRankingWeights,
  type HybridSemanticCandidate,
  type QueryModel,
  type RankingPathEdge,
  type RankingPathExplanation,
} from "./semantic-ranking-types.js";

type TraversalDirection = "outgoing" | "incoming";

interface TraversalEdge {
  edge: CodeEdge;
  from: StoredCodeNode;
  to: StoredCodeNode;
  direction: TraversalDirection;
}

interface PathCandidate {
  nodes: StoredCodeNode[];
  edges: TraversalEdge[];
  score: number;
  reason: string;
}

const appFlowEdgeKinds: CodeEdge["kind"][] = ["CALLS", "REFERENCES", "IMPORTS", "EXPORTS", "TESTS", "MENTIONS"];
const maxPathSeeds = 48;
const maxPathsPerSeed = 40;
const maxPathDepth = 3;

export async function addPathRankingCandidates(input: {
  store: CodeGraphRepository;
  candidates: Map<string, HybridSemanticCandidate>;
  query: QueryModel;
  filters: SemanticSearchFilters;
  allNodes: StoredCodeNode[];
}): Promise<void> {
  if (!shouldUsePathRanking(input.query)) {
    return;
  }

  const nodes = input.allNodes;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges = await input.store.getEdges();
  const adjacency = buildAdjacency(edges, nodeById);
  const seedNodes = collectPathSeeds(input.query, input.candidates, nodes);

  addRepresentativeOwnerCandidates(input.query, input.candidates, nodes);

  let pathRank = 1;
  for (const seed of seedNodes) {
    for (const path of collectPaths(seed, adjacency, input.query).slice(0, maxPathsPerSeed)) {
      for (const node of relevantPathNodes(path, input.query)) {
        if (!passesFilters(node, input.filters)) {
          continue;
        }
        const candidate = ensureCandidate(input.candidates, node);
        const existingRank = candidate.sourceRanks.get("path");
        candidate.sourceRanks.set("path", existingRank ? Math.min(existingRank, pathRank) : pathRank);
        candidate.signals.add("path_app_flow");
        for (const edge of path.edges) {
          candidate.graphEdgeKinds.add(edge.edge.kind);
          for (const source of evidenceSources(edge.edge.metadata)) {
            candidate.evidenceSources.add(source);
          }
        }
        const explanation = toRankingPathExplanation(path);
        candidate.paths = appendPathExplanation(candidate.paths, explanation);
      }
      pathRank += 1;
    }
  }
  addRepresentativeOwnerCandidates(input.query, input.candidates, nodes);
}

function shouldUsePathRanking(query: QueryModel): boolean {
  if (query.intent === "app-flow" || query.intent === "test") {
    return true;
  }
  return query.words.some((word) =>
    [
      "api",
      "auth",
      "database",
      "editor",
      "handler",
      "middleware",
      "payment",
      "permissions",
      "prisma",
      "response",
      "route",
      "service",
      "survey",
      "test",
      "webhook",
      "workspace",
    ].includes(word)
  );
}

function collectPathSeeds(
  query: QueryModel,
  candidates: Map<string, HybridSemanticCandidate>,
  nodes: StoredCodeNode[],
): StoredCodeNode[] {
  const seedMap = new Map<string, StoredCodeNode>();
  for (const candidate of [...candidates.values()].sort((left, right) => seedRank(query, left) - seedRank(query, right))) {
    if (nodeHasQueryConcept(query, candidate.node) || candidate.lexicalScore || candidate.sourceRanks.has("semantic")) {
      seedMap.set(candidate.node.id, candidate.node);
    }
  }
  for (const lexical of lexicalCandidates(query, nodes).slice(0, maxPathSeeds)) {
    seedMap.set(lexical.node.id, lexical.node);
  }
  return [...seedMap.values()]
    .sort((left, right) =>
      nodeConceptScore(query, right) - nodeConceptScore(query, left) ||
      kindRank(left) - kindRank(right) ||
      (left.file ?? "").localeCompare(right.file ?? "") ||
      (left.name ?? "").localeCompare(right.name ?? ""),
    )
    .slice(0, maxPathSeeds);
}

function seedRank(query: QueryModel, candidate: HybridSemanticCandidate): number {
  const semanticRank = candidate.sourceRanks.get("semantic") ?? 99;
  const lexicalRank = candidate.sourceRanks.get("lexical") ?? 99;
  return Math.min(semanticRank, lexicalRank) - nodeConceptScore(query, candidate.node);
}

function buildAdjacency(edges: CodeEdge[], nodeById: Map<string, StoredCodeNode>): Map<string, TraversalEdge[]> {
  const adjacency = new Map<string, TraversalEdge[]>();
  for (const edge of edges) {
    if (!appFlowEdgeKinds.includes(edge.kind)) {
      continue;
    }
    const from = nodeById.get(edge.fromId);
    const to = nodeById.get(edge.toId);
    if (!from || !to) {
      continue;
    }
    appendEdge(adjacency, edge.fromId, { edge, from, to, direction: "outgoing" });
    appendEdge(adjacency, edge.toId, { edge, from: to, to: from, direction: "incoming" });
  }
  return adjacency;
}

function appendEdge(adjacency: Map<string, TraversalEdge[]>, nodeId: string, edge: TraversalEdge): void {
  const bucket = adjacency.get(nodeId);
  if (bucket) {
    bucket.push(edge);
  } else {
    adjacency.set(nodeId, [edge]);
  }
}

function collectPaths(
  seed: StoredCodeNode,
  adjacency: Map<string, TraversalEdge[]>,
  query: QueryModel,
): PathCandidate[] {
  const results: PathCandidate[] = [];
  const queue: PathCandidate[] = [{
    nodes: [seed],
    edges: [],
    score: nodeRoleScore(query, seed) + nodeConceptScore(query, seed) * pathRankingWeights.seedRelevance,
    reason: "seed",
  }];

  while (queue.length > 0 && results.length < maxPathsPerSeed * 3) {
    queue.sort((left, right) => right.score - left.score || left.edges.length - right.edges.length);
    const current = queue.shift();
    if (!current || current.edges.length >= maxPathDepth) {
      continue;
    }
    const node = current.nodes[current.nodes.length - 1];
    for (const next of (adjacency.get(node.id) ?? []).sort(compareTraversalEdges)) {
      if (current.nodes.some((existing) => existing.id === next.to.id)) {
        continue;
      }
      const nextEdges = [...current.edges, next];
      const nextNodes = [...current.nodes, next.to];
      const nextScore = scorePath(query, nextNodes, nextEdges);
      const path: PathCandidate = {
        nodes: nextNodes,
        edges: nextEdges,
        score: nextScore,
        reason: pathReason(query, nextNodes, nextEdges),
      };
      if (pathIsUseful(query, path)) {
        results.push(path);
      }
      if (next.to.kind !== "Package" && next.edge.kind !== "MENTIONS") {
        queue.push(path);
      }
    }
  }

  return dedupePaths(results)
    .sort((left, right) =>
      right.score - left.score ||
      left.edges.length - right.edges.length ||
      pathKey(left).localeCompare(pathKey(right)),
    );
}

function compareTraversalEdges(left: TraversalEdge, right: TraversalEdge): number {
  return edgeScore(right) - edgeScore(left) ||
    (left.to.file ?? "").localeCompare(right.to.file ?? "") ||
    (left.to.name ?? "").localeCompare(right.to.name ?? "") ||
    left.edge.id.localeCompare(right.edge.id);
}

function pathIsUseful(query: QueryModel, path: PathCandidate): boolean {
  const conceptScore = path.nodes.reduce((total, node) => total + nodeConceptScore(query, node), 0);
  const hasStrongEdge = path.edges.some((edge) => edge.edge.kind !== "MENTIONS");
  const hasUsefulRole = path.nodes.some((node) => nodeRoleScore(query, node) >= pathRankingWeights.nodeRole.executable);
  return hasStrongEdge && (conceptScore > 0 || hasUsefulRole);
}

function scorePath(query: QueryModel, nodes: StoredCodeNode[], edges: TraversalEdge[]): number {
  let score = 0;
  for (const node of nodes) {
    score += nodeRoleScore(query, node);
  }
  for (const edge of edges) {
    score += edgeScore(edge);
  }
  const concepts = pathConceptMatches(query, nodes);
  score += concepts.size * pathRankingWeights.conceptCoverage;
  score -= edges.length * pathRankingWeights.pathLengthPenalty;
  return roundScore(score);
}

function edgeScore(edge: TraversalEdge): number {
  let score = pathRankingWeights.edgeKind[edge.edge.kind];
  const sources = evidenceSources(edge.edge.metadata);
  for (const source of sources) {
    score += pathRankingWeights.evidence[source as keyof typeof pathRankingWeights.evidence] ?? 0;
    if (source.startsWith("tree-sitter") && !(source in pathRankingWeights.evidence)) {
      score += 0.14;
    }
  }
  const confidence = edge.edge.metadata.confidence;
  if (typeof confidence === "string") {
    score += pathRankingWeights.confidence[confidence as keyof typeof pathRankingWeights.confidence] ?? 0;
  }
  if (edge.direction === "incoming") {
    score -= pathRankingWeights.incomingPenalty;
  }
  if (edge.edge.metadata.fallbackReason) {
    score -= pathRankingWeights.fallbackPenalty;
  }
  if (edge.edge.metadata.unresolved || edge.edge.metadata.dynamicStatus === "unresolved-dynamic") {
    score -= pathRankingWeights.unresolvedPenalty;
  }
  if (edge.edge.kind === "MENTIONS") {
    score -= pathRankingWeights.weakMentionPenalty;
  }
  return score;
}

function nodeRoleScore(query: QueryModel, node: StoredCodeNode): number {
  const path = node.file?.toLowerCase() ?? "";
  const name = node.name?.toLowerCase() ?? "";
  let score = 0;
  if (isRouteHandler(node) || isRouteOwnerFile(node)) score += pathRankingWeights.nodeRole.routeHandler;
  if (isPageNode(node)) score += pathRankingWeights.nodeRole.page;
  if (/service|action|mutation|resolver|handler/.test(`${path} ${name}`)) score += pathRankingWeights.nodeRole.service;
  if (/database|prisma|db|client|response/.test(`${path} ${name}`)) score += pathRankingWeights.nodeRole.database;
  if (/middleware/.test(`${path} ${name}`)) score += pathRankingWeights.nodeRole.middleware;
  if (isTestNode(node)) score += pathRankingWeights.nodeRole.test;
  if (["Function", "Class", "Symbol"].includes(node.kind)) score += pathRankingWeights.nodeRole.executable;
  if (node.kind === "File") score += pathRankingWeights.nodeRole.file;
  if (query.words.includes("webhook") && path.includes("webhook")) score += 0.36;
  if (query.words.includes("auth") && /auth|permission|workspace/.test(`${path} ${name}`)) score += 0.32;
  if (query.words.includes("editor") && /editor|page/.test(`${path} ${name}`)) score += 0.26;
  return score;
}

function isRouteHandler(node: StoredCodeNode): boolean {
  return node.kind === "Function" &&
    ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(node.name ?? "") &&
    /\/api\/|\/route\.[cm]?[jt]sx?$/.test(node.file ?? "");
}

function isRouteOwnerFile(node: StoredCodeNode): boolean {
  return node.kind === "File" && /\/routes?\/|\/api\/|\/route\.[cm]?[jt]sx?$/.test(node.file ?? "");
}

function isPageNode(node: StoredCodeNode): boolean {
  return node.kind === "Function" &&
    (/Page$/.test(node.name ?? "") || node.name === "Page") &&
    /(^|\/)(app|pages|modules)\/.*\.[cm]?[jt]sx?$/.test(node.file ?? "");
}

function nodeConceptScore(query: QueryModel, node: StoredCodeNode): number {
  return pathConceptMatches(query, [node]).size;
}

function nodeHasQueryConcept(query: QueryModel, node: StoredCodeNode): boolean {
  return nodeConceptScore(query, node) > 0;
}

function pathConceptMatches(query: QueryModel, nodes: StoredCodeNode[]): Set<string> {
  const haystack = nodes
    .flatMap((node) => [node.file, node.name, node.kind, node.packageName, node.metadata.qualifiedName])
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return new Set(
    query.words.filter((word) => word.length >= 4 && haystack.includes(word)),
  );
}

function pathReason(query: QueryModel, nodes: StoredCodeNode[], edges: TraversalEdge[]): string {
  const concepts = [...pathConceptMatches(query, nodes)].slice(0, 6).join(",");
  const kinds = [...new Set(edges.map((edge) => edge.edge.kind))].join(",");
  return `${kinds}${concepts ? ` matched ${concepts}` : ""}`;
}

function relevantPathNodes(path: PathCandidate, query: QueryModel): StoredCodeNode[] {
  return path.nodes.filter((node) =>
    node.kind !== "Import" &&
    node.kind !== "Export" &&
    (nodeRoleScore(query, node) > 0 || nodeHasQueryConcept(query, node))
  );
}

function addRepresentativeOwnerCandidates(
  query: QueryModel,
  candidates: Map<string, HybridSemanticCandidate>,
  nodes: StoredCodeNode[],
): void {
  const representativesByFile = new Map<string, StoredCodeNode[]>();
  for (const node of nodes) {
    if (!node.file || !isRepresentativeOwner(node)) {
      continue;
    }
    const bucket = representativesByFile.get(node.file) ?? [];
    bucket.push(node);
    representativesByFile.set(node.file, bucket);
  }

  for (const candidate of [...candidates.values()]) {
    if (!candidate.node.file || !nodeHasQueryConcept(query, candidate.node)) {
      continue;
    }
    const representatives = (representativesByFile.get(candidate.node.file) ?? [])
      .filter((node) => node.id !== candidate.node.id)
      .sort((left, right) =>
        representativeScore(query, right) - representativeScore(query, left) ||
        kindRank(left) - kindRank(right) ||
        (left.name ?? "").localeCompare(right.name ?? ""),
      );
    const owner = representatives[0];
    if (!owner || representativeScore(query, owner) <= 0) {
      continue;
    }
    const ownerCandidate = ensureCandidate(candidates, owner);
    const rank = isRouteHandler(owner) || isRouteOwnerFile(owner) || isPageNode(owner)
      ? 1
      : Math.max(1, 30 - Math.floor(representativeScore(query, owner) * 4));
    const existingRank = ownerCandidate.sourceRanks.get("path");
    ownerCandidate.sourceRanks.set("path", existingRank ? Math.min(existingRank, rank) : rank);
    ownerCandidate.signals.add("representative_owner");
    ownerCandidate.paths = appendPathExplanation(ownerCandidate.paths, {
      score: roundScore(pathRankingWeights.representativeOwner + representativeScore(query, owner)),
      reason: "representative owner for matching file",
      nodes: [toRankingPathNode(candidate.node), toRankingPathNode(owner)],
      edges: [],
    });
    addReason(ownerCandidate, "representative_owner", pathRankingWeights.representativeOwner);
  }
}

function isRepresentativeOwner(node: StoredCodeNode): boolean {
  return ["Function", "Class", "Symbol"].includes(node.kind) &&
    (isRouteHandler(node) || isPageNode(node) || /^[A-Z][A-Za-z0-9_$]+$/.test(node.name ?? "") || /^(get|create|update|delete|process|record|use)[A-Z]/.test(node.name ?? ""));
}

function representativeScore(query: QueryModel, node: StoredCodeNode): number {
  return nodeRoleScore(query, node) + nodeConceptScore(query, node) * 0.2;
}

function toRankingPathExplanation(path: PathCandidate): RankingPathExplanation {
  return {
    score: roundScore(path.score),
    reason: path.reason,
    nodes: path.nodes.map(toRankingPathNode),
    edges: path.edges.map(toRankingPathEdge),
  };
}

function toRankingPathNode(node: StoredCodeNode) {
  return {
    id: node.id,
    kind: node.kind,
    file: node.file,
    symbol: node.name,
  };
}

function toRankingPathEdge(edge: TraversalEdge): RankingPathEdge {
  const metadata = edge.edge.metadata;
  return {
    kind: edge.edge.kind,
    fromId: edge.edge.fromId,
    toId: edge.edge.toId,
    direction: edge.direction,
    evidenceSources: evidenceSources(metadata),
    confidence: typeof metadata.confidence === "string" ? metadata.confidence : undefined,
    fallbackReason: typeof metadata.fallbackReason === "string" ? metadata.fallbackReason : undefined,
    relationship: typeof metadata.relationship === "string" ? metadata.relationship : undefined,
  };
}

function appendPathExplanation(
  current: RankingPathExplanation[] | undefined,
  next: RankingPathExplanation,
): RankingPathExplanation[] {
  const paths = [...(current ?? []), next];
  return dedupePathExplanations(paths)
    .sort((left, right) => right.score - left.score || pathExplanationKey(left).localeCompare(pathExplanationKey(right)))
    .slice(0, 4);
}

function dedupePaths(paths: PathCandidate[]): PathCandidate[] {
  const seen = new Set<string>();
  const deduped: PathCandidate[] = [];
  for (const path of paths) {
    const key = pathKey(path);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(path);
  }
  return deduped;
}

function dedupePathExplanations(paths: RankingPathExplanation[]): RankingPathExplanation[] {
  const seen = new Set<string>();
  const deduped: RankingPathExplanation[] = [];
  for (const path of paths) {
    const key = pathExplanationKey(path);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(path);
  }
  return deduped;
}

function pathKey(path: PathCandidate): string {
  return path.nodes.map((node) => node.id).join(">");
}

function pathExplanationKey(path: RankingPathExplanation): string {
  return path.nodes.map((node) => node.id).join(">");
}
