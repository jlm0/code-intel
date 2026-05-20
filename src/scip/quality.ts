import { truncateUtf8Bytes } from "../core/text.js";
import type { IndexProgressScipQuality } from "../schema/schemas.js";
import type { ScipFacts } from "./ingest.js";
import type { RunScipTypescriptResult } from "./runner.js";

const tinyScipBytes = 128;
const maxSummaryBytes = 1024;

export function createScipQualityReport(
  run: Pick<RunScipTypescriptResult, "ok" | "outputBytes" | "durationMs" | "exitCode" | "stdout" | "stderr">,
  facts: Pick<ScipFacts, "definitions" | "references" | "occurrences">,
): IndexProgressScipQuality {
  const warnings: string[] = [];
  const factCount = facts.definitions.length + facts.references.length + facts.occurrences.length;
  if (run.ok && (run.outputBytes < tinyScipBytes || factCount === 0)) {
    warnings.push("scip-empty-or-tiny");
  }
  if (!run.ok) {
    warnings.push("scip-typescript-failed");
  }

  return {
    outputBytes: run.outputBytes,
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    definitions: facts.definitions.length,
    references: facts.references.length,
    occurrences: facts.occurrences.length,
    stdoutSummary: summarizeOutput(run.stdout),
    stderrSummary: summarizeOutput(run.stderr),
    warnings,
  };
}

function summarizeOutput(output: string): string | undefined {
  const trimmed = output.trim();
  return trimmed.length > 0 ? truncateUtf8Bytes(trimmed, maxSummaryBytes) : undefined;
}
