import type {
  EvalFailureClass,
  EvalGateMetadata,
  EvalGateStatus,
} from "./eval-pack.js";

export interface SummarizableEvalCaseResult {
  id: string;
  gate: EvalGateMetadata;
  status: "pass" | "fail";
  failureClass?: EvalFailureClass;
  expected?: unknown;
}

export interface EvalReportSummary {
  blockingStatus: "pass" | "fail";
  qualityStatus: "pass" | "fail";
  totals: {
    total: number;
    passed: number;
    failed: number;
    blockingFailed: number;
  };
  gateStatuses: Record<EvalGateStatus, EvalGateStatusSummary>;
  gates: EvalGateSummary[];
  capabilities: EvalCapabilitySummary[];
  failureClasses: EvalFailureClassSummary[];
}

export interface EvalGateStatusSummary {
  gateStatus: EvalGateStatus;
  blocking: boolean;
  resultStatus: "pass" | "fail";
  total: number;
  passed: number;
  failed: number;
  blockingFailed: number;
  rank: EvalRankSummary;
}

export interface EvalGateSummary {
  id: string;
  gateStatus: EvalGateStatus;
  capability: string;
  layer: string;
  description?: string;
  blocking: boolean;
  resultStatus: "pass" | "fail";
  total: number;
  passed: number;
  failed: number;
  blockingFailed: number;
  rank: EvalRankSummary;
  failureClasses: EvalFailureClassSummary[];
  caseIds: string[];
}

export interface EvalCapabilitySummary {
  capability: string;
  layers: string[];
  gateStatuses: EvalGateStatus[];
  resultStatus: "pass" | "fail";
  total: number;
  passed: number;
  failed: number;
  blockingFailed: number;
  rank: EvalRankSummary;
}

export interface EvalFailureClassSummary {
  failureClass: EvalFailureClass;
  count: number;
  blockingCount: number;
  caseIds: string[];
}

export interface EvalRankSummary {
  expectedTotal: number;
  expectedFound: number;
  expectedMissing: number;
  best?: number;
  worst?: number;
  mrrAt10: number;
  recallAtK: number;
  ndcgAt10: number;
  falsePositiveCount: number;
}

interface RankExpectationResult {
  rank?: number;
}

interface MetricsResult {
  metrics?: {
    mrrAt10: number;
    recallAtK: number;
    ndcgAt10: number;
    falsePositiveCount: number;
  };
}

const gateStatusOrder: EvalGateStatus[] = ["required", "target", "scoreboard"];

export function summarizeEvalResults(results: SummarizableEvalCaseResult[]): EvalReportSummary {
  const totals = summarizeResultGroup(results);
  const blockingStatus = totals.blockingFailed === 0 ? "pass" : "fail";
  const qualityStatus = totals.failed === 0 ? "pass" : "fail";
  const gateStatuses = Object.fromEntries(
    gateStatusOrder.map((gateStatus) => [
      gateStatus,
      summarizeGateStatus(gateStatus, results.filter((result) => result.gate.status === gateStatus)),
    ]),
  ) as Record<EvalGateStatus, EvalGateStatusSummary>;

  return {
    blockingStatus,
    qualityStatus,
    totals,
    gateStatuses,
    gates: summarizeByKey(results, gateKey).map(summarizeGate),
    capabilities: summarizeByKey(results, (result) => result.gate.capability).map(summarizeCapability),
    failureClasses: summarizeFailureClasses(results),
  };
}

function summarizeGateStatus(
  gateStatus: EvalGateStatus,
  results: SummarizableEvalCaseResult[],
): EvalGateStatusSummary {
  const totals = summarizeResultGroup(results);
  return {
    gateStatus,
    blocking: gateStatus === "required",
    resultStatus: totals.failed === 0 ? "pass" : "fail",
    ...totals,
    rank: summarizeRanks(results),
  };
}

function summarizeGate(results: SummarizableEvalCaseResult[]): EvalGateSummary {
  const [firstResult] = results;
  const totals = summarizeResultGroup(results);
  return {
    id: firstResult.gate.id,
    gateStatus: firstResult.gate.status,
    capability: firstResult.gate.capability,
    layer: firstResult.gate.layer,
    description: firstResult.gate.description,
    blocking: firstResult.gate.status === "required",
    resultStatus: totals.failed === 0 ? "pass" : "fail",
    ...totals,
    rank: summarizeRanks(results),
    failureClasses: summarizeFailureClasses(results),
    caseIds: results.map((result) => result.id),
  };
}

function summarizeCapability(results: SummarizableEvalCaseResult[]): EvalCapabilitySummary {
  const [firstResult] = results;
  const totals = summarizeResultGroup(results);
  return {
    capability: firstResult.gate.capability,
    layers: uniqueSorted(results.map((result) => result.gate.layer)),
    gateStatuses: uniqueByOrder(results.map((result) => result.gate.status), gateStatusOrder),
    resultStatus: totals.failed === 0 ? "pass" : "fail",
    ...totals,
    rank: summarizeRanks(results),
  };
}

function summarizeResultGroup(
  results: SummarizableEvalCaseResult[],
): EvalReportSummary["totals"] {
  const failed = results.filter((result) => result.status === "fail").length;
  const blockingFailed = results.filter(
    (result) => result.status === "fail" && result.gate.status === "required",
  ).length;
  return {
    total: results.length,
    passed: results.length - failed,
    failed,
    blockingFailed,
  };
}

function summarizeRanks(results: SummarizableEvalCaseResult[]): EvalRankSummary {
  const expectations = results.flatMap(queryExpectationResults);
  const ranks = expectations
    .map((expectation) => expectation.rank)
    .filter((rank): rank is number => typeof rank === "number");
  const metrics = results
    .map((result) => (result as MetricsResult).metrics)
    .filter((metric): metric is NonNullable<MetricsResult["metrics"]> => Boolean(metric));
  return {
    expectedTotal: expectations.length,
    expectedFound: ranks.length,
    expectedMissing: expectations.length - ranks.length,
    best: ranks.length > 0 ? Math.min(...ranks) : undefined,
    worst: ranks.length > 0 ? Math.max(...ranks) : undefined,
    mrrAt10: averageMetric(metrics.map((metric) => metric.mrrAt10)),
    recallAtK: averageMetric(metrics.map((metric) => metric.recallAtK)),
    ndcgAt10: averageMetric(metrics.map((metric) => metric.ndcgAt10)),
    falsePositiveCount: metrics.reduce((total, metric) => total + metric.falsePositiveCount, 0),
  };
}

function queryExpectationResults(result: SummarizableEvalCaseResult): RankExpectationResult[] {
  return Array.isArray(result.expected)
    ? result.expected as RankExpectationResult[]
    : [];
}

function summarizeFailureClasses(
  results: SummarizableEvalCaseResult[],
): EvalFailureClassSummary[] {
  return summarizeByKey(
    results.filter((result) => result.status === "fail" && result.failureClass),
    (result) => result.failureClass ?? "unknown",
  ).map((group) => ({
    failureClass: group[0].failureClass ?? "unknown",
    count: group.length,
    blockingCount: group.filter((result) => result.gate.status === "required").length,
    caseIds: group.map((result) => result.id),
  }));
}

function summarizeByKey<T>(items: T[], getKey: (item: T) => string): T[][] {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = getKey(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => group);
}

function gateKey(result: SummarizableEvalCaseResult): string {
  return [
    result.gate.status,
    result.gate.layer,
    result.gate.capability,
    result.gate.id,
  ].join("\0");
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function uniqueByOrder<T extends string>(values: T[], order: T[]): T[] {
  const valueSet = new Set(values);
  return order.filter((value) => valueSet.has(value));
}

function averageMetric(values: number[]): number {
  if (values.length === 0) {
    return 1;
  }
  return Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 1_000_000) / 1_000_000;
}
