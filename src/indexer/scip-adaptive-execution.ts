import type { IndexProgressReporter } from "../core/progress.js";
import type { IndexPolicy } from "../core/index-policy.js";
import { classifyScipFailure } from "../scip/quality.js";
import {
  runScipTypescript,
  type RunScipTypescriptInput,
  type RunScipTypescriptResult,
} from "../scip/runner.js";
import type { ScipShardPlan } from "./scip-shard-planning.js";

export interface ExecuteAdaptiveScipShardInput {
  repoPath: string;
  shard: ScipShardPlan;
  policy: IndexPolicy;
  progress?: IndexProgressReporter;
  runScipTypescript?: (input: RunScipTypescriptInput) => Promise<RunScipTypescriptResult>;
}

export interface AdaptiveScipShardOutcome {
  shard: ScipShardPlan;
  run: RunScipTypescriptResult;
  status: "succeeded" | "failed";
  failureKind?: ReturnType<typeof classifyScipFailure>;
  retryExhausted?: boolean;
}

export async function executeAdaptiveScipShard(
  input: ExecuteAdaptiveScipShardInput,
): Promise<AdaptiveScipShardOutcome[]> {
  const runner = input.runScipTypescript ?? runScipTypescript;
  return executeShard({
    ...input,
    runner,
    depth: 0,
    heapMb: input.policy.scip.defaultHeapMb,
  });
}

async function executeShard(input: ExecuteAdaptiveScipShardInput & {
  runner: (input: RunScipTypescriptInput) => Promise<RunScipTypescriptResult>;
  depth: number;
  heapMb: number;
}): Promise<AdaptiveScipShardOutcome[]> {
  const run = await input.runner({
    repoPath: input.repoPath,
    outputPath: input.shard.outputPath,
    inferTsconfig: true,
    projectPaths: [input.shard.projectPath],
    includedFiles: input.shard.includedFiles,
    maxOldSpaceSizeMb: input.heapMb,
    timeoutMs: input.policy.scip.timeoutMs,
    safeTsconfig: true,
    projectReferencesEnabled: input.policy.scip.projectReferencesEnabled,
  });

  if (run.ok) {
    return [{ shard: input.shard, run, status: "succeeded" }];
  }

  const failureKind = classifyScipFailure(run);
  const files = input.shard.includedFiles ?? [];
  const canSplit = failureKind === "oom" &&
    files.length > 1 &&
    input.depth < input.policy.scip.maxRetrySplits;
  if (canSplit) {
    const midpoint = Math.ceil(files.length / 2);
    const childFiles = [files.slice(0, midpoint), files.slice(midpoint)].filter((child) => child.length > 0);
    const outcomes: AdaptiveScipShardOutcome[] = [];
    for (const [index, includedFiles] of childFiles.entries()) {
      const childId = `${input.shard.id}-retry-${input.depth + 1}-${index + 1}`;
      outcomes.push(
        ...await executeShard({
          ...input,
          depth: input.depth + 1,
          shard: {
            ...input.shard,
            id: childId,
            outputPath: input.shard.outputPath.replace(/\.scip$/, `-${input.depth + 1}-${index + 1}.scip`),
            includedFiles,
            cost: Math.ceil((input.shard.cost ?? includedFiles.length) / childFiles.length),
            reason: `${input.shard.reason}:retry-split`,
            lineage: [...input.shard.lineage, childId],
          },
          heapMb: input.policy.scip.defaultHeapMb,
        }),
      );
    }
    return outcomes;
  }

  const canEscalateHeap = failureKind === "oom" &&
    input.heapMb < input.policy.scip.tinyShardHeapEscalationMb &&
    files.length > 0 &&
    files.length <= input.policy.scip.tinyShardMaxFiles;
  if (canEscalateHeap) {
    return executeShard({
      ...input,
      heapMb: input.policy.scip.tinyShardHeapEscalationMb,
      depth: input.depth + 1,
      shard: {
        ...input.shard,
        reason: `${input.shard.reason}:heap-escalated`,
        lineage: [...input.shard.lineage, `${input.shard.id}-heap-${input.policy.scip.tinyShardHeapEscalationMb}`],
      },
    });
  }

  return [{
    shard: input.shard,
    run,
    status: "failed",
    failureKind,
    retryExhausted: true,
  }];
}
