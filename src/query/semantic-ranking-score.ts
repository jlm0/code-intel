import {
  addDemotion,
  addReason,
  exactSymbolMatch,
  isTestNode,
  kindRank,
  normalizeScore,
  roundScore,
  topReasons,
} from "./semantic-ranking-model.js";
import {
  rrfConstant,
  sourceWeights,
  type HybridSemanticCandidate,
  type HybridSemanticRow,
  type QueryModel,
} from "./semantic-ranking-types.js";

export function finalizeCandidates(
  query: QueryModel,
  candidates: HybridSemanticCandidate[],
  limit: number,
): HybridSemanticRow[] {
  const scored = candidates
    .map((candidate) => scoreCandidate(query, candidate))
    .sort((left, right) =>
      right.score - left.score ||
      kindRank(left.node) - kindRank(right.node) ||
      (left.node.file ?? "").localeCompare(right.node.file ?? "") ||
      (left.node.name ?? "").localeCompare(right.node.name ?? ""),
    );

  const deduped = dedupeRankedCandidates(scored, limit);
  return deduped.map((candidate, index) => {
    const score = normalizeScore(candidate.score);
    return {
      node: candidate.node,
      distance: Math.max(0, 1 - score),
      signals: [...candidate.signals].sort(),
      ranking: {
        intent: query.intent,
        score,
        fusion: {
          rank: index + 1,
          score: roundScore(fusionScore(candidate)),
          sources: Object.fromEntries(
            [...candidate.sourceRanks.entries()].sort(([left], [right]) => left.localeCompare(right)),
          ),
        },
        reasons: topReasons(candidate.reasons),
        demotions: topReasons(candidate.demotions),
      },
    };
  });
}

function scoreCandidate(query: QueryModel, candidate: HybridSemanticCandidate): HybridSemanticCandidate {
  let score = fusionScore(candidate);
  score += codeAwareBoosts(query, candidate);
  score -= codeAwareDemotions(query, candidate);
  candidate.score = score;
  return candidate;
}

function fusionScore(candidate: HybridSemanticCandidate): number {
  let score = 0;
  for (const [source, rank] of candidate.sourceRanks) {
    score += (sourceWeights[source] ?? 1) / (rrfConstant + rank);
  }
  return score * 18;
}

function codeAwareBoosts(query: QueryModel, candidate: HybridSemanticCandidate): number {
  let boost = 0;
  const exactSymbol = exactSymbolMatch(query, candidate.node);
  const path = candidate.node.file?.toLowerCase() ?? "";
  const name = candidate.node.name?.toLowerCase() ?? "";

  if (exactSymbol) boost += addReason(candidate, "symbol_exact", 1.1, "query token exactly matches symbol name");
  if (candidate.evidenceSources.has("scip-typescript")) boost += addReason(candidate, "evidence_scip", 0.25);
  if (candidate.evidenceSources.has("module-resolution")) boost += addReason(candidate, "evidence_module_resolution", 0.22);
  if (candidate.evidenceSources.has("tree-sitter-test")) boost += addReason(candidate, "evidence_test_context", 0.2);
  if (candidate.graphEdgeKinds.has("CALLS")) boost += addReason(candidate, "edge_calls", 0.22);
  if (candidate.graphEdgeKinds.has("TESTS")) boost += addReason(candidate, "edge_tests", 0.22);
  if (candidate.graphEdgeKinds.has("IMPORTS") || candidate.graphEdgeKinds.has("EXPORTS")) {
    boost += addReason(candidate, "edge_module_boundary", 0.16);
  }

  if (query.intent === "implementation") boost += implementationIntentBoost(candidate);
  if (query.intent === "test") boost += testIntentBoost(candidate);
  if (query.intent === "caller" && candidate.graphEdgeKinds.has("CALLS")) boost += relationshipIntentBoost(candidate, "caller");
  if (query.intent === "callee" && candidate.graphEdgeKinds.has("CALLS")) boost += relationshipIntentBoost(candidate, "callee");
  if (query.intent === "app-flow") boost += appFlowBoost(query, candidate, path, name);
  if (query.words.includes("private") && path.includes("private")) boost += addReason(candidate, "path_private", 0.38);
  if (query.words.includes("web") && path.includes("apps/web")) boost += addReason(candidate, "path_web_app", 0.24);
  if (query.words.includes("api") && path.includes("/api/")) boost += addReason(candidate, "path_api", 0.24);
  if (query.words.includes("route") && /(^|\/)(routes?|route)\b|\[\.\.\.route\]/.test(path)) {
    boost += addReason(candidate, "path_route", 0.22);
  }
  if (query.words.includes("dashboard") && path.includes("dashboard")) {
    boost += addReason(candidate, "path_dashboard", 0.62);
  }
  if (candidate.lexicalScore) boost += Math.min(candidate.lexicalScore, 0.6);

  return boost;
}

function implementationIntentBoost(candidate: HybridSemanticCandidate): number {
  let boost = 0;
  candidate.signals.add("intent_implementation");
  if (candidate.node.metadata.fileKind === "source") boost += addReason(candidate, "intent_implementation", 0.7);
  if (["Function", "Class", "Symbol"].includes(candidate.node.kind)) {
    boost += addReason(candidate, "implementation_symbol_kind", 0.28);
  }
  return boost;
}

function testIntentBoost(candidate: HybridSemanticCandidate): number {
  let boost = 0;
  candidate.signals.add("intent_test");
  if (isTestNode(candidate.node)) boost += addReason(candidate, "intent_test", 0.68);
  if (candidate.pairedFromTest) boost += addReason(candidate, "test_to_implementation_pair", 0.48);
  return boost;
}

function relationshipIntentBoost(candidate: HybridSemanticCandidate, intent: "caller" | "callee"): number {
  let boost = addReason(candidate, `intent_${intent}`, 0.55);
  if (["Function", "Class", "Chunk", "File"].includes(candidate.node.kind)) {
    boost += addReason(candidate, intent === "caller" ? "caller_source_candidate" : "callee_target_candidate", 0.3);
  }
  return boost;
}

function appFlowBoost(
  query: QueryModel,
  candidate: HybridSemanticCandidate,
  path: string,
  name: string,
): number {
  let boost = 0;
  candidate.signals.add("intent_app_flow");
  if (query.words.includes("route") && /\/routes?\/|\/api\//.test(path)) boost += addReason(candidate, "app_flow_route", 0.34);
  if ((query.words.includes("mutation") || query.words.includes("create") || query.words.includes("delete")) && path.includes("mutation")) {
    boost += addReason(candidate, "app_flow_mutation", 0.32);
  }
  if ((query.words.includes("database") || query.words.includes("record") || query.words.includes("db")) && (path.includes("database") || name === "prisma")) {
    boost += addReason(candidate, "app_flow_database", 0.28);
  }
  if (query.words.includes("middleware") && path.includes("middleware")) boost += addReason(candidate, "app_flow_middleware", 0.26);
  if ((query.words.includes("ui") || query.words.includes("page")) && (path.includes("/app/") || path.endsWith(".tsx"))) {
    boost += addReason(candidate, "app_flow_ui", 0.24);
  }
  return boost;
}

function codeAwareDemotions(query: QueryModel, candidate: HybridSemanticCandidate): number {
  let demotion = 0;
  const path = candidate.node.file?.toLowerCase() ?? "";
  const name = candidate.node.name?.toLowerCase() ?? "";
  const onlyWeakMention = candidate.graphEdgeKinds.size === 1 && candidate.graphEdgeKinds.has("MENTIONS");

  if (onlyWeakMention) demotion += addDemotion(candidate, "weak_mentions_only", 0.45);
  if (path.includes("/node_modules/") || path.includes("/dist/") || path.includes("/generated/")) {
    demotion += addDemotion(candidate, "generated_or_vendor", 0.6);
  }
  if (query.intent === "implementation" && isTestNode(candidate.node)) {
    demotion += addDemotion(candidate, "implementation_demotes_tests", 0.72);
  }
  if (query.intent !== "test" && isTestNode(candidate.node)) {
    demotion += addDemotion(candidate, "non_test_intent_demotes_tests", 0.45);
  }
  if ((query.intent === "caller" || query.intent === "callee") && isTestNode(candidate.node)) {
    demotion += addDemotion(candidate, "relationship_intent_demotes_tests", 0.28);
  }
  if ((query.intent === "caller" || query.intent === "callee") && exactSymbolMatch(query, candidate.node) && !candidate.graphEdgeKinds.has("CALLS")) {
    demotion += addDemotion(candidate, "relationship_intent_demotes_seed_symbol", 0.82);
  }
  if (candidate.node.kind === "Import" || candidate.node.kind === "Export") {
    demotion += addDemotion(candidate, "import_export_wrapper", 0.48);
  }
  if (!query.words.includes("schema") && !query.words.includes("params") && /(schema|params|input)$/.test(name)) {
    demotion += addDemotion(candidate, "schema_helper", 0.18);
  }
  if (query.intent === "test" && candidate.node.metadata.fileKind === "source" && !candidate.pairedFromTest) {
    demotion += addDemotion(candidate, "test_intent_demotes_unpaired_source", 0.22);
  }
  return demotion;
}

function dedupeRankedCandidates(candidates: HybridSemanticCandidate[], limit: number): HybridSemanticCandidate[] {
  const selected: HybridSemanticCandidate[] = [];
  const fileCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const file = candidate.node.file;
    const count = file ? fileCounts.get(file) ?? 0 : 0;
    const maxPerFile = candidate.signals.has("symbol_exact") ||
      candidate.signals.has("test_to_implementation_pair") ||
      candidate.signals.has("graph_calls")
      ? 2
      : 1;
    if (file && count >= maxPerFile) {
      continue;
    }
    selected.push(candidate);
    if (file) {
      fileCounts.set(file, count + 1);
    }
    if (selected.length >= limit) {
      break;
    }
  }
  return selected;
}
