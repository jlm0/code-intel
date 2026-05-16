export function cypherValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "NULL";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => cypherValue(item)).join(", ")}]`;
  }
  return JSON.stringify(JSON.stringify(value));
}

export function cypherAssignments(alias: string, values: Record<string, unknown>): string {
  return Object.entries(values)
    .map(([key, value]) => `${alias}.${key} = ${cypherValue(value)}`)
    .join(", ");
}
