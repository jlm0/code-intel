import { basename } from "node:path";

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

  const deduped = dedupeRankedCandidates(query, scored, limit);
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
  if (candidate.evidenceSources.has("side-effect")) boost += addReason(candidate, "evidence_side_effect", 0.44);

  if (query.intent === "implementation") boost += implementationIntentBoost(candidate);
  if (query.intent === "test") boost += testIntentBoost(candidate);
  if (query.intent === "caller" && candidate.graphEdgeKinds.has("CALLS")) boost += relationshipIntentBoost(candidate, "caller");
  if (query.intent === "callee" && candidate.graphEdgeKinds.has("CALLS")) boost += relationshipIntentBoost(candidate, "callee");
  if (query.intent === "imports") boost += importIntentBoost(candidate);
  if (query.intent === "app-flow") boost += appFlowBoost(query, candidate, path, name);
  boost += surfaceIntentBoost(query, candidate, path, name);
  boost += pathWordCoverageBoost(query, candidate, path, name);
  if (sideEffectIntent(query)) boost += sideEffectIntentBoost(candidate, path);
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
  if (isPrimaryFileSymbol(candidate.node)) {
    boost += addReason(candidate, "implementation_primary_file_symbol", 0.9);
  }
  boost += queryWordIdentityBoost(candidate);
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
  if (intent === "caller" && (candidate.node.kind === "Function" || candidate.node.kind === "Symbol")) {
    boost += addReason(candidate, "caller_executable_candidate", 0.55);
  } else if (["Function", "Class", "Chunk", "File"].includes(candidate.node.kind)) {
    boost += addReason(candidate, intent === "caller" ? "caller_source_candidate" : "callee_target_candidate", 0.3);
  }
  return boost;
}

function importIntentBoost(candidate: HybridSemanticCandidate): number {
  let boost = 0;
  candidate.signals.add("intent_imports");
  if (candidate.graphEdgeKinds.has("IMPORTS")) {
    boost += addReason(candidate, "intent_imports_edge", 0.72);
  }
  if (candidate.node.kind === "File" || candidate.node.kind === "Chunk") {
    boost += addReason(candidate, "imports_file_candidate", 0.24);
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
  if (query.words.includes("route") && /\/routes?\/|\/api\//.test(path)) boost += addReason(candidate, "app_flow_route", 1);
  if ((query.words.includes("mutation") || query.words.includes("create") || query.words.includes("delete")) && path.includes("mutation")) {
    boost += addReason(candidate, "app_flow_mutation", 0.9);
  }
  if ((query.words.includes("mutation") || query.words.includes("call")) && path.includes("/api-core/")) {
    boost += addReason(candidate, "app_flow_api_core", 0.48);
  }
  if (
    (query.words.includes("database") || query.words.includes("record") || query.words.includes("db") ||
      (query.words.includes("mutation") && query.words.includes("call"))) &&
    (path.includes("database") || name === "prisma")
  ) {
    boost += addReason(candidate, "app_flow_database", 0.74);
  }
  if (candidate.evidenceSources.has("mutation-to-database")) {
    boost += addReason(candidate, "app_flow_mutation_to_database", 0.9);
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
    demotion += addDemotion(candidate, "non_test_intent_demotes_tests", 0.62);
  }
  if ((query.intent === "caller" || query.intent === "callee") && isTestNode(candidate.node)) {
    demotion += addDemotion(candidate, "relationship_intent_demotes_tests", 0.28);
  }
  if (query.intent === "caller" && exactSymbolMatch(query, candidate.node)) {
    demotion += addDemotion(candidate, "relationship_intent_demotes_seed_symbol", 2.2);
  } else if ((query.intent === "caller" || query.intent === "callee") && exactSymbolMatch(query, candidate.node) && !candidate.graphEdgeKinds.has("CALLS")) {
    demotion += addDemotion(candidate, "relationship_intent_demotes_seed_symbol", 0.82);
  }
  if (query.intent === "imports" && exactSymbolMatch(query, candidate.node)) {
    demotion += addDemotion(candidate, "imports_intent_demotes_seed_symbol", 1.1);
  }
  if (candidate.node.kind === "Import" || candidate.node.kind === "Export") {
    demotion += addDemotion(candidate, "import_export_wrapper", 0.48);
  }
  if (!query.words.some((word) => ["story", "stories", "storybook"].includes(word)) && /\.stories\.[cm]?[jt]sx?$/.test(path)) {
    demotion += addDemotion(candidate, "storybook_non_story_query", 0.64);
  }
  if (!query.words.includes("schema") && !query.words.includes("params") && /(schema|params|input)$/.test(name)) {
    demotion += addDemotion(candidate, "schema_helper", 0.18);
  }
  if (query.intent === "test" && candidate.node.metadata.fileKind === "source") {
    demotion += addDemotion(
      candidate,
      candidate.pairedFromTest ? "test_intent_keeps_paired_source_below_tests" : "test_intent_demotes_unpaired_source",
      candidate.pairedFromTest ? 0.38 : 0.22,
    );
  }
  if (query.words.includes("not") && query.words.some((word) => ["test", "tests", "spec"].includes(word)) && isTestNode(candidate.node)) {
    demotion += addDemotion(candidate, "negative_test_intent", 1.15);
  }
  if (
    query.intent === "app-flow" &&
    !query.words.some((word) => ["ui", "page", "component"].includes(word)) &&
    path.includes("/packages/ui/")
  ) {
    demotion += addDemotion(candidate, "app_flow_demotes_generic_ui", 0.55);
  }
  return demotion;
}

function surfaceIntentBoost(
  query: QueryModel,
  candidate: HybridSemanticCandidate,
  path: string,
  name: string,
): number {
  let boost = 0;
  const hasUiIntent = query.words.some((word) =>
    ["angular", "react", "component", "components", "page", "dashboard", "form", "table", "tui", "terminal", "hook"].includes(word)
  );
  if (hasUiIntent && isUiSurface(path, name)) {
    boost += addReason(candidate, "surface_ui", 0.46);
  }
  if (query.words.includes("hook") && /^use[A-Z]/.test(candidate.node.name ?? "") && hookDomainMatches(query, path, name)) {
    boost += addReason(candidate, "surface_hook_domain", 0.86);
  }
  if (query.words.includes("angular") && /\.component\.[cm]?[jt]sx?$/.test(path)) {
    boost += addReason(candidate, "surface_angular_component", 0.88);
  }
  if (query.words.includes("table") && (path.includes("table") || name.includes("table"))) {
    boost += addReason(candidate, "surface_table", 0.42);
  }
  if ((query.words.includes("page") || query.words.includes("dashboard") || query.words.includes("form")) && isPageSymbol(candidate)) {
    boost += addReason(candidate, "surface_page_symbol", 0.95);
  }

  const hasGatewayIntent = query.words.some((word) =>
    ["gateway", "websocket", "rpc", "request", "session", "composer"].includes(word)
  );
  if (hasGatewayIntent && /gateway|client|rpc|websocket/.test(`${path} ${name}`)) {
    boost += addReason(candidate, "surface_gateway_client", 0.58);
  }
  if (hasGatewayIntent && candidate.node.kind === "Class" && /client/.test(name)) {
    boost += addReason(candidate, "surface_client_class", 0.98);
  }
  return boost;
}

function pathWordCoverageBoost(
  query: QueryModel,
  candidate: HybridSemanticCandidate,
  path: string,
  name: string,
): number {
  const ignored = new Set(["then", "from", "with", "into", "this", "that"]);
  const words = query.words.filter((word) => word.length >= 4 && !ignored.has(word));
  const matched = words.filter((word) => path.includes(word) || name.includes(word));
  if (matched.length < 2) {
    return 0;
  }
  let boost = addReason(
    candidate,
    "path_word_coverage",
    Math.min(0.14 * matched.length, 0.84),
    `matched ${[...new Set(matched)].slice(0, 6).join(", ")}`,
  );
  if (matched.length >= 3 && (candidate.node.kind === "Function" || candidate.node.kind === "Class")) {
    boost += addReason(candidate, "path_symbol_coverage", 0.28);
  }
  return boost;
}

function isUiSurface(path: string, name: string): boolean {
  return /(^|\/)(libs|packages)\/ui\//.test(path) ||
    /\/components?\//.test(path) ||
    /\/app\//.test(path) ||
    /\.component\.[cm]?[jt]sx?$/.test(path) ||
    /\.tsx$/.test(path) ||
    /component|page|hook/.test(name);
}

function isPageSymbol(candidate: HybridSemanticCandidate): boolean {
  return candidate.node.name === "Page" &&
    candidate.node.kind === "Function" &&
    /(^|\/)(app|pages)\/.*\/page\.[cm]?[jt]sx?$/.test(candidate.node.file ?? "");
}

function hookDomainMatches(query: QueryModel, path: string, name: string): boolean {
  const ignored = new Set(["hook", "hooks", "terminal", "tui"]);
  return query.words.some((word) =>
    word.length >= 4 &&
    !ignored.has(word) &&
    (path.includes(word) || name.includes(word))
  );
}

function sideEffectIntent(query: QueryModel): boolean {
  return query.words.some((word) => ["polyfill", "module", "evaluation", "load", "loads"].includes(word));
}

function sideEffectIntentBoost(candidate: HybridSemanticCandidate, path: string): number {
  let boost = 0;
  if (candidate.evidenceSources.has("side-effect")) {
    boost += addReason(candidate, "side_effect_edge", 1.35);
  }
  if (path.includes("side-effect")) {
    boost += addReason(candidate, "side_effect_path", 1.75);
  }
  return boost;
}

function isPrimaryFileSymbol(node: HybridSemanticCandidate["node"]): boolean {
  if (!node.file || !node.name || !["Function", "Class", "Symbol", "Chunk"].includes(node.kind)) {
    return false;
  }
  const stem = basename(node.file).replace(/(\.test|\.spec|\.stories)?\.[cm]?[jt]sx?$/, "");
  const normalizedStem = normalizeIdentifier(stem);
  const normalizedName = normalizeIdentifier(node.name);
  return normalizedStem.length > 0 && normalizedName === normalizedStem;
}

function queryWordIdentityBoost(candidate: HybridSemanticCandidate): number {
  const path = candidate.node.file?.toLowerCase() ?? "";
  const name = candidate.node.name?.toLowerCase() ?? "";
  let boost = 0;
  for (const reason of candidate.reasons) {
    if (reason.signal !== "lexical_score" || !reason.detail) {
      continue;
    }
    const matches = reason.detail.match(/matched (.+)$/)?.[1]?.split(", ").filter((word) => word.length >= 4) ?? [];
    for (const word of matches) {
      if (path.includes(word) && name.includes(word)) {
        boost += addReason(candidate, "implementation_path_name_match", 0.18, `path and name match ${word}`);
      }
    }
  }
  return Math.min(boost, 0.54);
}

function normalizeIdentifier(value: string): string {
  return value
    .replace(/^[^a-zA-Z_$]+/, "")
    .replace(/[-_\s]+([a-zA-Z0-9_$])/g, (_, char: string) => char.toUpperCase())
    .replace(/[^a-zA-Z0-9_$]/g, "")
    .toLowerCase();
}

function dedupeRankedCandidates(
  query: QueryModel,
  candidates: HybridSemanticCandidate[],
  limit: number,
): HybridSemanticCandidate[] {
  const selected: HybridSemanticCandidate[] = [];
  const fileCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const file = candidate.node.file;
    const count = file ? fileCounts.get(file) ?? 0 : 0;
    const maxPerFile = surfaceQueryAllowsMorePerFile(query)
      ? 3
      : query.intent === "caller" || query.intent === "callee" || query.intent === "imports"
      ? 4
      : candidate.signals.has("symbol_exact") ||
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

function surfaceQueryAllowsMorePerFile(query: QueryModel): boolean {
  return query.words.some((word) =>
    [
      "angular",
      "component",
      "dashboard",
      "form",
      "gateway",
      "hook",
      "page",
      "rpc",
      "table",
      "terminal",
      "tui",
      "websocket",
    ].includes(word)
  );
}
