import type { SemanticSearchFilters, StoredCodeNode } from "../graph/repository.js";
import type {
  HybridSemanticCandidate,
  QueryModel,
  RankingDemotion,
  RankingReason,
  SemanticQueryIntent,
} from "./semantic-ranking-types.js";

export function buildQueryModel(raw: string): QueryModel {
  const words = queryWords(raw);
  const codeTokens = semanticGraphTokens(raw);
  return {
    raw,
    intent: detectIntent(words),
    words,
    codeTokens,
    symbolTokens: [...new Set([...rawCodeIdentifiers(raw), ...codeTokens, ...symbolWords(words)])].slice(0, 24),
  };
}

export function lexicalCandidates(
  query: QueryModel,
  nodes: StoredCodeNode[],
): Array<{ node: StoredCodeNode; score: number; detail: string }> {
  return nodes
    .map((node) => ({ node, ...lexicalScore(query, node) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      kindRank(left.node) - kindRank(right.node) ||
      (left.node.file ?? "").localeCompare(right.node.file ?? ""),
    )
    .slice(0, 120);
}

export function passesFilters(node: StoredCodeNode, filters: SemanticSearchFilters): boolean {
  if (filters.repo && node.repo !== filters.repo) return false;
  if (filters.packageName && node.packageName !== filters.packageName) return false;
  if (filters.fileKind && node.metadata.fileKind !== filters.fileKind) return false;
  if (filters.symbolKind && node.metadata.symbolKind !== filters.symbolKind) return false;
  return true;
}

export function isTestNode(node: StoredCodeNode): boolean {
  return node.metadata.fileKind === "test" ||
    node.kind === "Test" ||
    /\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$/.test(node.file ?? "");
}

export function pairedSourceFiles(file: string | undefined, sourceFiles: Set<string>): string[] {
  if (!file) {
    return [];
  }
  const candidates = [
    file.replace(/\.test(\.[cm]?[jt]sx?)$/, "$1"),
    file.replace(/\.spec(\.[cm]?[jt]sx?)$/, "$1"),
  ].filter((candidate) => candidate !== file && sourceFiles.has(candidate));
  return [...new Set(candidates)];
}

export function dedupeNodes(nodes: StoredCodeNode[]): StoredCodeNode[] {
  const seen = new Set<string>();
  const deduped: StoredCodeNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    deduped.push(node);
  }
  return deduped;
}

export function exactSymbolMatch(query: QueryModel, node: StoredCodeNode): boolean {
  const name = node.name?.toLowerCase();
  if (!name) {
    return false;
  }
  if (!["Function", "Class", "Interface", "TypeAlias", "Symbol", "Chunk", "Test"].includes(node.kind)) {
    return false;
  }
  return query.symbolTokens.some((token) => token.toLowerCase() === name);
}

export function evidenceSources(metadata: Record<string, unknown>): string[] {
  const sources = metadata.evidenceSources;
  if (Array.isArray(sources)) {
    return sources.filter((source): source is string => typeof source === "string");
  }
  return typeof metadata.origin === "string" ? [metadata.origin] : [];
}

export function addReason(
  candidate: HybridSemanticCandidate,
  signal: string,
  weight: number,
  detail?: string,
): number {
  candidate.signals.add(signal);
  candidate.reasons.push({ signal, weight: roundScore(weight), detail });
  return weight;
}

export function addDemotion(
  candidate: HybridSemanticCandidate,
  signal: string,
  weight: number,
  detail?: string,
): number {
  candidate.signals.add(signal);
  candidate.demotions.push({ signal, weight: roundScore(weight), detail });
  return weight;
}

export function kindRank(node: StoredCodeNode): number {
  if (node.kind === "Function") return 0;
  if (node.kind === "Class" || node.kind === "Symbol") return 1;
  if (node.kind === "File") return 2;
  if (node.kind === "Chunk") return 3;
  if (node.kind === "Test") return 4;
  return 5;
}

export function normalizeScore(score: number): number {
  return roundScore(Math.max(0, Math.min(0.99, score / 4)));
}

export function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function topReasons<T extends RankingReason | RankingDemotion>(reasons: T[]): T[] {
  return [...reasons]
    .sort((left, right) => right.weight - left.weight || left.signal.localeCompare(right.signal))
    .slice(0, 12);
}

function lexicalScore(query: QueryModel, node: StoredCodeNode): { score: number; detail: string } {
  const haystack = [
    node.file,
    node.name,
    node.kind,
    node.packageName,
    node.metadata.symbolKind,
    node.metadata.qualifiedName,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  let score = 0;
  const matched: string[] = [];
  for (const word of query.words) {
    if (haystack.includes(word)) {
      score += word.length <= 3 ? 0.04 : 0.08;
      matched.push(word);
    }
  }
  for (const token of query.codeTokens) {
    if (node.name?.toLowerCase() === token.toLowerCase()) {
      score += 0.42;
      matched.push(token);
    } else if (haystack.includes(token.toLowerCase())) {
      score += 0.14;
      matched.push(token);
    }
  }
  return {
    score,
    detail: matched.length > 0 ? `matched ${[...new Set(matched)].slice(0, 8).join(", ")}` : "no lexical match",
  };
}

function detectIntent(words: string[]): SemanticQueryIntent {
  if (words.includes("not") && words.some((word) => ["test", "tests", "spec"].includes(word)) &&
    words.some((word) => ["implementation", "source", "real"].includes(word))) {
    return "implementation";
  }
  if (words.some((word) => ["test", "tests", "spec", "suite"].includes(word))) return "test";
  if (words.includes("where") && words.includes("called")) return "caller";
  if (words.some((word) => ["caller", "callers", "calls", "usage", "uses"].includes(word))) return "caller";
  if (words.some((word) => ["import", "imports", "imported", "importing"].includes(word))) return "imports";
  if (words.some((word) => ["callee", "callees", "called"].includes(word))) return "callee";
  if (words.includes("route") && words.some((word) => ["api", "handler", "mutation", "server", "wired"].includes(word))) {
    return "app-flow";
  }
  if (words.some((word) => ["implementation", "implemented", "source", "handler"].includes(word))) return "implementation";
  if (words.some((word) => ["route", "api", "database", "mutation", "middleware", "page", "loader", "dashboard"].includes(word))) {
    return "app-flow";
  }
  return "broad";
}

function semanticGraphTokens(query: string): string[] {
  const words = queryWords(query);
  const tokens = new Set(rawCodeIdentifiers(query));
  for (let index = 0; index < words.length - 1; index += 1) {
    tokens.add(camelize(words.slice(index, index + 2)));
  }
  for (let index = 0; index < words.length - 2; index += 1) {
    tokens.add(camelize(words.slice(index, index + 3)));
  }
  if (words.includes("app") && (words.includes("route") || words.includes("handler") || words.includes("api"))) {
    tokens.add("app");
  }
  return [...tokens].filter((token) => token === "app" || token.length >= 4).slice(0, 18);
}

function queryWords(query: string): string[] {
  return query
    .match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g)
    ?.map((token) => token.toLowerCase())
    .filter((token) => token.length > 2) ?? [];
}

function rawCodeIdentifiers(query: string): string[] {
  return query
    .match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g)
    ?.filter((token) => /[A-Z0-9_$]/.test(token) && token.length >= 4) ?? [];
}

function symbolWords(words: string[]): string[] {
  const stopwords = new Set([
    "where",
    "which",
    "from",
    "this",
    "that",
    "codebase",
    "implementation",
    "source",
    "module",
    "called",
    "calls",
    "callers",
    "files",
    "import",
    "imports",
  ]);
  return words.filter((word) => word.length >= 4 && !stopwords.has(word));
}

function camelize(words: string[]): string {
  return words
    .map((word, index) => index === 0 ? word : `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join("");
}
