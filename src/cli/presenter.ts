export interface RenderOptions {
  json: boolean;
  isTTY: boolean;
}

export function renderResult(result: unknown, options: RenderOptions): string {
  if (options.json || !options.isTTY) {
    return `${JSON.stringify(sortForStableJson(result), null, 2)}\n`;
  }

  if (isQueryResult(result)) {
    return renderQueryResult(result);
  }

  if (
    result &&
    typeof result === "object" &&
    "status" in result &&
    "checks" in result
  ) {
    const status = String((result as { status: unknown }).status);
    const checks = (result as { checks: Array<{ name: string; status: string; message: string }> })
      .checks;
    return [`status: ${status}`, ...checks.map((check) => `${check.status} ${check.name}: ${check.message}`)].join("\n") + "\n";
  }

  return `${JSON.stringify(sortForStableJson(result), null, 2)}\n`;
}

interface QueryResultForDisplay {
  query: string;
  results: Array<{
    kind: string;
    file?: string;
    range?: { startLine?: number };
    symbol?: { name?: string };
    matchedSignals?: string[];
    metadata?: {
      relationship?: {
        kind?: string;
        evidenceSources?: unknown;
      };
      ranking?: {
        reasons?: unknown;
      };
    };
  }>;
}

function isQueryResult(result: unknown): result is QueryResultForDisplay {
  return Boolean(
    result &&
    typeof result === "object" &&
    "query" in result &&
    "results" in result &&
    typeof (result as { query?: unknown }).query === "string" &&
    Array.isArray((result as { results?: unknown }).results),
  );
}

function renderQueryResult(result: QueryResultForDisplay): string {
  const lines = [`query: ${result.query}`, `results: ${result.results.length}`];
  result.results.slice(0, 20).forEach((item, index) => {
    const name = item.symbol?.name ? ` ${item.symbol.name}` : "";
    const location = item.file
      ? `${item.file}${item.range?.startLine ? `:${item.range.startLine}` : ""}`
      : "no file";
    lines.push(`${index + 1}. ${item.kind}${name}`);
    lines.push(`   ${location}`);
    if (item.matchedSignals && item.matchedSignals.length > 0) {
      lines.push(`   signals: ${item.matchedSignals.join(", ")}`);
    }
    const relationship = item.metadata?.relationship;
    const evidence = Array.isArray(relationship?.evidenceSources)
      ? relationship.evidenceSources.filter((source): source is string => typeof source === "string")
      : [];
    if (relationship?.kind) {
      lines.push(`   relationship: ${relationship.kind}${evidence.length > 0 ? ` via ${evidence.join(", ")}` : ""}`);
    }
    const rankingReasons = item.metadata?.ranking?.reasons;
    if (Array.isArray(rankingReasons) && rankingReasons.length > 0) {
      lines.push(`   ranking: ${rankingReasons.length} reason${rankingReasons.length === 1 ? "" : "s"}`);
    }
  });
  if (result.results.length > 20) {
    lines.push(`... ${result.results.length - 20} more`);
  }
  return `${lines.join("\n")}\n`;
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortForStableJson(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortForStableJson(item)]),
    );
  }

  return value;
}
