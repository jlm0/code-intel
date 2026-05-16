export function truncateUtf8Bytes(text: string, maxBytes: number, suffix = "\n[truncated]"): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const contentBytes = Math.max(0, maxBytes - suffixBytes);
  let truncated = Buffer.from(text, "utf8").subarray(0, contentBytes).toString("utf8");
  while (Buffer.byteLength(truncated + suffix, "utf8") > maxBytes) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}${suffix}`;
}
