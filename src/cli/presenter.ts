export interface RenderOptions {
  json: boolean;
  isTTY: boolean;
}

export function renderResult(result: unknown, options: RenderOptions): string {
  if (options.json || !options.isTTY) {
    return `${JSON.stringify(sortForStableJson(result), null, 2)}\n`;
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
