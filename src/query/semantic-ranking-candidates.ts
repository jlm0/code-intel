import type {
  CodeGraphRepository,
  RelatedCodeNode,
  SemanticSearchFilters,
  StoredCodeNode,
} from "../graph/repository.js";
import {
  addReason,
  dedupeNodes,
  evidenceSources,
  isTestNode,
  lexicalCandidates,
  pairedSourceFiles,
  passesFilters,
} from "./semantic-ranking-model.js";
import {
  edgeKindsForSemanticGraph,
  sourceWeights,
  type HybridSemanticCandidate,
  type QueryModel,
} from "./semantic-ranking-types.js";

export function addRankedCandidates(input: {
  candidates: Map<string, HybridSemanticCandidate>;
  rows: StoredCodeNode[];
  source: keyof typeof sourceWeights;
  signal: string;
  baseDetail: string;
}): void {
  input.rows.forEach((node, index) => {
    const candidate = ensureCandidate(input.candidates, node);
    const rank = index + 1;
    const existingRank = candidate.sourceRanks.get(input.source);
    candidate.sourceRanks.set(input.source, existingRank ? Math.min(existingRank, rank) : rank);
    candidate.signals.add(input.signal);
    addReason(candidate, input.signal, sourceWeights[input.source], `${input.baseDetail} at rank ${rank}`);
  });
}

export async function addSymbolCandidates(
  store: CodeGraphRepository,
  candidates: Map<string, HybridSemanticCandidate>,
  query: QueryModel,
  filters: SemanticSearchFilters,
): Promise<void> {
  const rows: StoredCodeNode[] = [];
  for (const token of query.symbolTokens) {
    rows.push(...(await store.findSymbols(token, 8)).filter((node) => passesFilters(node, filters)));
  }
  addRankedCandidates({
    candidates,
    rows: dedupeNodes(rows),
    source: "symbol",
    signal: "symbol_text",
    baseDetail: "symbol/name lookup candidate",
  });
}

export async function addGraphCandidates(
  store: CodeGraphRepository,
  candidates: Map<string, HybridSemanticCandidate>,
  query: QueryModel,
  filters: SemanticSearchFilters,
): Promise<void> {
  const rows: RelatedCodeNode[] = [];
  for (const token of query.symbolTokens) {
    for (const edge of edgeKindsForSemanticGraph) {
      rows.push(...await store.getRelatedNodes(token, edge.kind, edge.direction, 10));
    }
  }
  const filtered = rows.filter((row) => passesFilters(row.node, filters));
  addRankedCandidates({
    candidates,
    rows: dedupeNodes(filtered.map((row) => row.node)),
    source: "graph",
    signal: "graph_relationship",
    baseDetail: "relationship candidate",
  });
  for (const row of filtered) {
    const candidate = candidates.get(row.node.id);
    if (!candidate) continue;
    candidate.graphEdgeKinds.add(row.edgeKind);
    for (const source of evidenceSources(row.edgeMetadata)) {
      candidate.evidenceSources.add(source);
    }
    candidate.signals.add(`graph_${row.edgeKind.toLowerCase()}`);
    addReason(candidate, `graph_${row.edgeKind.toLowerCase()}`, graphEdgeWeight(row), graphReasonDetail(row));
  }
}

export async function addAdjacentSemanticCandidates(
  store: CodeGraphRepository,
  candidates: Map<string, HybridSemanticCandidate>,
  query: QueryModel,
  filters: SemanticSearchFilters,
  allNodes: StoredCodeNode[],
  semanticNodes: StoredCodeNode[],
): Promise<void> {
  const seedIds = new Set<string>();
  const fileNodesByFile = new Map(
    allNodes
      .filter((node) => node.kind === "File" && node.file)
      .map((node) => [node.file!, node]),
  );
  for (const node of semanticNodes.slice(0, 12)) {
    seedIds.add(node.id);
    const fileNode = node.file ? fileNodesByFile.get(node.file) : undefined;
    if (fileNode) {
      seedIds.add(fileNode.id);
    }
  }
  if (seedIds.size === 0) {
    return;
  }
  const rows = (await store.getAdjacentNodes([...seedIds], 120))
    .filter((row) => passesFilters(row.node, filters))
    .filter((row) => semanticNeighborMatchesQuery(query, row));
  addRankedCandidates({
    candidates,
    rows: dedupeNodes(rows.map((row) => row.node)),
    source: "graph",
    signal: "semantic_graph_neighbor",
    baseDetail: "neighbor of semantic candidate",
  });
  for (const row of rows) {
    const candidate = candidates.get(row.node.id);
    if (!candidate) continue;
    candidate.graphEdgeKinds.add(row.edgeKind);
    for (const source of evidenceSources(row.edgeMetadata)) {
      candidate.evidenceSources.add(source);
    }
    candidate.signals.add(`graph_${row.edgeKind.toLowerCase()}`);
    addReason(candidate, `graph_${row.edgeKind.toLowerCase()}`, graphEdgeWeight(row), graphReasonDetail(row));
  }
}

export async function addAppFlowExpansionCandidates(
  store: CodeGraphRepository,
  candidates: Map<string, HybridSemanticCandidate>,
  query: QueryModel,
  filters: SemanticSearchFilters,
  seedNodes: StoredCodeNode[],
): Promise<void> {
  const rows: RelatedCodeNode[] = [];
  for (const seed of seedNodes.slice(0, 48)) {
    rows.push(
      ...(await store.getAdjacentNodes([seed.id], 80))
        .filter((row) => passesFilters(row.node, filters))
        .filter((row) => semanticNeighborMatchesQuery(query, row)),
    );
    if (seed.name) {
      rows.push(
        ...(await store.getRelatedNodes(seed.name, "CALLS", "outgoing", 30))
          .filter((row) => passesFilters(row.node, filters))
          .filter((row) => semanticNeighborMatchesQuery(query, row)),
      );
    }
  }
  const filtered = rows.filter((row) => passesFilters(row.node, filters));
  addRankedCandidates({
    candidates,
    rows: dedupeNodes(filtered.map((row) => row.node)),
    source: "graph",
    signal: "app_flow_graph_expansion",
    baseDetail: "app-flow neighbor candidate",
  });
  for (const row of filtered) {
    const candidate = candidates.get(row.node.id);
    if (!candidate) continue;
    candidate.graphEdgeKinds.add(row.edgeKind);
    for (const source of evidenceSources(row.edgeMetadata)) {
      candidate.evidenceSources.add(source);
    }
    candidate.signals.add(`graph_${row.edgeKind.toLowerCase()}`);
    addReason(candidate, `graph_${row.edgeKind.toLowerCase()}`, graphEdgeWeight(row), graphReasonDetail(row));
  }
}

export function addTestIntentCandidates(
  candidates: Map<string, HybridSemanticCandidate>,
  query: QueryModel,
  allNodes: StoredCodeNode[],
): void {
  if (query.intent !== "test") {
    return;
  }
  const sourceFiles = new Set(allNodes.map((node) => node.file).filter((file): file is string => Boolean(file)));
  const testNodes = lexicalCandidates(query, allNodes.filter((node) => isTestNode(node)))
    .slice(0, 50)
    .map((candidate) => candidate.node);
  addRankedCandidates({
    candidates,
    rows: testNodes,
    source: "test",
    signal: "intent_test",
    baseDetail: "test-intent candidate",
  });
  const pairedSources = dedupeNodes(testNodes.flatMap((node) =>
    pairedSourceFiles(node.file, sourceFiles)
      .flatMap((file) => allNodes.filter((candidate) =>
        candidate.file === file && candidate.metadata.fileKind === "source",
      )),
  ));
  addRankedCandidates({
    candidates,
    rows: pairedSources,
    source: "test_pair",
    signal: "test_to_implementation_pair",
    baseDetail: "source paired with matching test file",
  });
  for (const node of pairedSources) {
    const candidate = candidates.get(node.id);
    if (candidate) {
      candidate.pairedFromTest = true;
    }
  }
}

function ensureCandidate(
  candidates: Map<string, HybridSemanticCandidate>,
  node: StoredCodeNode,
): HybridSemanticCandidate {
  const existing = candidates.get(node.id);
  if (existing) {
    return existing;
  }
  const candidate: HybridSemanticCandidate = {
    node,
    sourceRanks: new Map(),
    signals: new Set(),
    reasons: [],
    demotions: [],
    evidenceSources: new Set(),
    graphEdgeKinds: new Set(),
    score: 0,
  };
  candidates.set(node.id, candidate);
  return candidate;
}

function graphEdgeWeight(row: RelatedCodeNode): number {
  let weight = row.edgeKind === "MENTIONS" ? 0.08 : 0.22;
  if (row.edgeKind === "CALLS" || row.edgeKind === "TESTS") weight += 0.12;
  if (row.edgeMetadata.confidence === "high") weight += 0.08;
  if (evidenceSources(row.edgeMetadata).includes("scip-typescript")) weight += 0.08;
  if (evidenceSources(row.edgeMetadata).includes("module-resolution")) weight += 0.08;
  return weight;
}

function graphReasonDetail(row: RelatedCodeNode): string {
  const sources = evidenceSources(row.edgeMetadata);
  return `${row.edgeKind}${sources.length > 0 ? ` via ${sources.join(",")}` : ""}`;
}

function semanticNeighborMatchesQuery(query: QueryModel, row: RelatedCodeNode): boolean {
  if (evidenceSources(row.edgeMetadata).includes("side-effect")) {
    return true;
  }
  if (query.intent === "caller" || query.intent === "callee") {
    return false;
  }
  if (query.intent === "imports" && row.edgeKind === "IMPORTS") {
    return true;
  }
  if (query.intent === "implementation" && row.edgeKind === "TESTS") {
    return true;
  }
  return row.edgeKind === "REFERENCES" || row.edgeKind === "CALLS";
}
