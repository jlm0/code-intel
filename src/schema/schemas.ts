import { z } from "zod";

export const schemaVersion = "code-intel.v1";

export const NodeKindSchema = z.enum([
  "Workspace",
  "Repo",
  "Package",
  "File",
  "Module",
  "Symbol",
  "Function",
  "Class",
  "Interface",
  "TypeAlias",
  "Import",
  "Export",
  "Callsite",
  "Chunk",
  "Test",
]);

export const EdgeKindSchema = z.enum([
  "CONTAINS",
  "DEFINES",
  "IMPORTS",
  "EXPORTS",
  "REFERENCES",
  "CALLS",
  "EXTENDS",
  "IMPLEMENTS",
  "DEPENDS_ON",
  "HAS_CHUNK",
  "TESTS",
  "MENTIONS",
]);

export const RangeSchema = z.object({
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  startColumn: z.number().int().min(0).optional(),
  endColumn: z.number().int().min(0).optional(),
});

export const CodeNodeSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  id: z.string().min(1),
  kind: NodeKindSchema,
  workspace: z.string().min(1),
  repo: z.string().min(1),
  packageName: z.string().optional(),
  file: z.string().optional(),
  name: z.string().optional(),
  language: z.string().optional(),
  range: RangeSchema.optional(),
  textHash: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()),
});

export const CodeEdgeSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  id: z.string().min(1),
  kind: EdgeKindSchema,
  fromId: z.string().min(1),
  toId: z.string().min(1),
  workspace: z.string().min(1),
  repo: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()),
});

export const ChunkSchema = CodeNodeSchema.extend({
  kind: z.literal("Chunk"),
  file: z.string().min(1),
  range: RangeSchema,
  content: z.string(),
  embedding: z.array(z.number()).optional(),
  embeddingModel: z.string().optional(),
});

export const HealthCheckSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["pass", "warn", "fail"]),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const FileFingerprintSchema = z.object({
  repo: z.string().min(1),
  relativePath: z.string().min(1),
  packageName: z.string().optional(),
  language: z.string().min(1),
  size: z.number().int().min(0),
  mtimeMs: z.number().min(0),
  contentHash: z.string().min(1),
});

export const IncrementalStatsSchema = z.object({
  mode: z.enum(["full", "incremental"]),
  reason: z.string().optional(),
  files: z.object({
    added: z.number().int().min(0),
    changed: z.number().int().min(0),
    deleted: z.number().int().min(0),
    unchanged: z.number().int().min(0),
  }),
  chunks: z.object({
    reused: z.number().int().min(0),
    embedded: z.number().int().min(0),
  }),
});

export const IndexProgressOperationSchema = z.enum(["index", "update"]);
export const IndexProgressStatusSchema = z.enum(["running", "succeeded", "failed", "stale"]);
export const IndexProgressPhaseSchema = z.enum([
  "starting",
  "discovering",
  "planning",
  "facts",
  "scip",
  "embeddings",
  "graph",
  "publishing",
  "succeeded",
  "failed",
]);

export const IndexProgressCountersSchema = z.object({
  filesDiscovered: z.number().int().min(0).optional(),
  filesParsed: z.number().int().min(0).optional(),
  chunksTotal: z.number().int().min(0).optional(),
  chunksVisited: z.number().int().min(0).optional(),
  chunksEmbedded: z.number().int().min(0).optional(),
  chunksReused: z.number().int().min(0).optional(),
  embeddingBatchSize: z.number().int().min(1).optional(),
  embeddingBatchesCompleted: z.number().int().min(0).optional(),
  nodesWritten: z.number().int().min(0).optional(),
  edgesWritten: z.number().int().min(0).optional(),
});

export const IndexProgressEventTypeSchema = z.enum([
  "run_started",
  "phase_started",
  "discovery_summary",
  "step_started",
  "step_progress",
  "step_succeeded",
  "step_failed",
  "scip_quality",
  "warning",
  "run_succeeded",
  "run_failed",
]);
export const IndexProgressWriterStatusSchema = z.enum(["running", "succeeded", "failed"]);
export const IndexProgressStepSchema = z.enum([
  "scip-run",
  "scip-ingest",
  "scip-quality",
  "module-resolution",
  "resolved-module-graph",
  "framework-graph",
  "relationship-graph",
  "test-linking",
  "final-call-promotion",
  "embedding-batch",
]);

export const IndexProgressMemorySchema = z.object({
  rssMb: z.number().min(0),
  heapUsedMb: z.number().min(0),
});

export const IndexProgressErrorDetailsSchema = z.object({
  name: z.string().min(1),
  message: z.string(),
  code: z.string().optional(),
  stack: z.string().optional(),
});

export const IndexProgressScipQualitySchema = z.object({
  outputBytes: z.number().int().min(0),
  durationMs: z.number().min(0),
  exitCode: z.number().int().nullable(),
  definitions: z.number().int().min(0),
  references: z.number().int().min(0),
  occurrences: z.number().int().min(0),
  stdoutSummary: z.string().optional(),
  stderrSummary: z.string().optional(),
  warnings: z.array(z.string()).default([]),
});

export const IndexDiscoverySummarySchema = z.object({
  totals: z.object({
    repos: z.number().int().min(0),
    packages: z.number().int().min(0),
    includedFiles: z.number().int().min(0),
    unsupportedFiles: z.number().int().min(0),
    ignoredDirectories: z.number().int().min(0),
    tsconfigExcludedFiles: z.number().int().min(0),
    outsideSourceRootFiles: z.number().int().min(0),
  }),
  repos: z.array(
    z.object({
      repo: z.string().min(1),
      path: z.string().min(1),
      packages: z.array(
        z.object({
          name: z.string().min(1),
          path: z.string().min(1),
          sourceRoots: z.array(z.string()).default([]),
          includedFiles: z.number().int().min(0),
          tsconfigExcludedFiles: z.number().int().min(0),
          outsideSourceRootFiles: z.number().int().min(0),
        }),
      ),
      includedFiles: z.number().int().min(0),
      unsupportedFiles: z.number().int().min(0),
      ignoredDirectories: z.number().int().min(0),
      tsconfigExcludedFiles: z.number().int().min(0),
      outsideSourceRootFiles: z.number().int().min(0),
    }),
  ),
});

export const IndexWriteLockStateSchema = z.object({
  status: z.enum(["unlocked", "held", "stale"]),
  path: z.string().min(1),
  pid: z.number().int().min(1).optional(),
  createdAt: z.string().datetime().optional(),
  ageMs: z.number().int().min(0).optional(),
  alive: z.boolean().optional(),
});

export const IndexProgressSnapshotSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  runId: z.string().min(1),
  operation: IndexProgressOperationSchema,
  status: IndexProgressStatusSchema,
  phase: IndexProgressPhaseSchema,
  message: z.string().min(1),
  indexPath: z.string().min(1),
  pid: z.number().int().min(1),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  currentRepo: z.string().min(1).optional(),
  currentStep: IndexProgressStepSchema.optional(),
  startedStepAt: z.string().datetime().optional(),
  counters: IndexProgressCountersSchema.default({}),
  error: z.string().optional(),
  errorDetails: IndexProgressErrorDetailsSchema.optional(),
  warnings: z.array(z.string()).default([]),
  staleReason: z.enum(["process-exited", "heartbeat-timeout"]).optional(),
});

const IndexProgressEventBaseSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  runId: z.string().min(1),
  operation: IndexProgressOperationSchema,
  phase: IndexProgressPhaseSchema,
  status: IndexProgressWriterStatusSchema.optional(),
  message: z.string().min(1),
  indexPath: z.string().min(1),
  pid: z.number().int().min(1),
  timestamp: z.string().datetime(),
  currentRepo: z.string().min(1).optional(),
  currentStep: IndexProgressStepSchema.optional(),
  startedStepAt: z.string().datetime().optional(),
  durationMs: z.number().min(0).optional(),
  counters: IndexProgressCountersSchema.default({}),
  memory: IndexProgressMemorySchema,
  error: IndexProgressErrorDetailsSchema.optional(),
  warnings: z.array(z.string()).default([]),
  scip: IndexProgressScipQualitySchema.optional(),
  discovery: IndexDiscoverySummarySchema.optional(),
});

export const IndexProgressEventSchema = z.discriminatedUnion("event", [
  IndexProgressEventBaseSchema.extend({
    event: z.literal("run_started"),
  }),
  IndexProgressEventBaseSchema.extend({
    event: z.literal("phase_started"),
  }),
  IndexProgressEventBaseSchema.extend({
    event: z.literal("discovery_summary"),
    discovery: IndexDiscoverySummarySchema,
  }),
  IndexProgressEventBaseSchema.extend({
    event: z.literal("step_started"),
    currentStep: IndexProgressStepSchema,
  }),
  IndexProgressEventBaseSchema.extend({
    event: z.literal("step_progress"),
    currentStep: IndexProgressStepSchema,
  }),
  IndexProgressEventBaseSchema.extend({
    event: z.literal("step_succeeded"),
    currentStep: IndexProgressStepSchema,
    durationMs: z.number().min(0),
  }),
  IndexProgressEventBaseSchema.extend({
    event: z.literal("step_failed"),
    status: z.literal("failed"),
    currentStep: IndexProgressStepSchema,
    durationMs: z.number().min(0),
    error: IndexProgressErrorDetailsSchema,
  }),
  IndexProgressEventBaseSchema.extend({
    event: z.literal("scip_quality"),
    currentStep: z.literal("scip-quality"),
    scip: IndexProgressScipQualitySchema,
  }),
  IndexProgressEventBaseSchema.extend({
    event: z.literal("warning"),
  }),
  IndexProgressEventBaseSchema.extend({
    event: z.literal("run_succeeded"),
    status: z.literal("succeeded"),
  }),
  IndexProgressEventBaseSchema.extend({
    event: z.literal("run_failed"),
    status: z.literal("failed"),
    error: IndexProgressErrorDetailsSchema,
  }),
]);

export const IndexProgressResultSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  indexPath: z.string().min(1),
  progress: IndexProgressSnapshotSchema.optional(),
  events: z.array(IndexProgressEventSchema).optional(),
  writeLock: IndexWriteLockStateSchema,
});

export const IndexManifestSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  workspace: z.string().min(1),
  generatedAt: z.string().datetime(),
  indexPath: z.string().min(1),
  repos: z.array(
    z.object({
      name: z.string().min(1),
      path: z.string().min(1),
      commit: z.string().min(1),
      packages: z.number().int().min(0),
      files: z.number().int().min(0),
    }),
  ),
  stats: z.object({
    nodes: z.number().int().min(0),
    edges: z.number().int().min(0),
    chunks: z.number().int().min(0),
  }),
  embedding: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    dimension: z.number().int().min(1),
  }),
  incremental: IncrementalStatsSchema.optional(),
  health: z.array(HealthCheckSchema),
});

export const QueryResultItemSchema = z.object({
  id: z.string().min(1),
  score: z.number().optional(),
  kind: NodeKindSchema,
  repo: z.string().min(1),
  packageName: z.string().optional(),
  file: z.string().optional(),
  range: RangeSchema.optional(),
  symbol: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      kind: NodeKindSchema,
    })
    .optional(),
  matchedSignals: z.array(z.string()).default([]),
  neighborCounts: z
    .object({
      callers: z.number().int().min(0).default(0),
      callees: z.number().int().min(0).default(0),
      references: z.number().int().min(0).default(0),
      tests: z.number().int().min(0).default(0),
    })
    .optional(),
  excerpt: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const QueryResultSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  query: z.string(),
  results: z.array(QueryResultItemSchema),
});

export const HealthResultSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  status: z.enum(["ok", "warn", "fail"]),
  indexPath: z.string().min(1),
  checks: z.array(HealthCheckSchema),
});

export const StatusResultSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  indexed: z.boolean(),
  indexPath: z.string().min(1),
  manifest: IndexManifestSchema.optional(),
  manifestPath: z.string().optional(),
  progress: IndexProgressSnapshotSchema.optional(),
  writeLock: IndexWriteLockStateSchema,
  repos: z.array(z.unknown()).optional(),
});

export const McpToolPayloadSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  tool: z.string().min(1),
  guidance: z
    .object({
      purpose: z.string().min(1),
      evidenceFields: z.array(z.string()).default([]),
      nextTools: z.array(z.string()).default([]),
      examples: z.array(z.string()).default([]),
    })
    .optional(),
  result: z.unknown(),
});

export function mcpToolOutputSchema(resultSchema: z.ZodTypeAny) {
  return {
    schemaVersion: z.literal(schemaVersion),
    tool: z.string().min(1),
    guidance: z
      .object({
        purpose: z.string().min(1),
        evidenceFields: z.array(z.string()).default([]),
        nextTools: z.array(z.string()).default([]),
        examples: z.array(z.string()).default([]),
      })
      .optional(),
    result: resultSchema,
  };
}

export type CodeNode = z.infer<typeof CodeNodeSchema>;
export type CodeEdge = z.infer<typeof CodeEdgeSchema>;
export type CodeChunk = z.infer<typeof ChunkSchema>;
export type FileFingerprint = z.infer<typeof FileFingerprintSchema>;
export type HealthCheck = z.infer<typeof HealthCheckSchema>;
export type IncrementalStats = z.infer<typeof IncrementalStatsSchema>;
export type IndexManifest = z.infer<typeof IndexManifestSchema>;
export type IndexProgressCounters = z.infer<typeof IndexProgressCountersSchema>;
export type IndexDiscoverySummary = z.infer<typeof IndexDiscoverySummarySchema>;
export type IndexProgressErrorDetails = z.infer<typeof IndexProgressErrorDetailsSchema>;
export type IndexProgressEvent = z.infer<typeof IndexProgressEventSchema>;
export type IndexProgressEventType = z.infer<typeof IndexProgressEventTypeSchema>;
export type IndexProgressOperation = z.infer<typeof IndexProgressOperationSchema>;
export type IndexProgressPhase = z.infer<typeof IndexProgressPhaseSchema>;
export type IndexProgressResult = z.infer<typeof IndexProgressResultSchema>;
export type IndexProgressScipQuality = z.infer<typeof IndexProgressScipQualitySchema>;
export type IndexProgressSnapshot = z.infer<typeof IndexProgressSnapshotSchema>;
export type IndexProgressStatus = z.infer<typeof IndexProgressStatusSchema>;
export type IndexProgressStep = z.infer<typeof IndexProgressStepSchema>;
export type IndexWriteLockState = z.infer<typeof IndexWriteLockStateSchema>;
export type QueryResult = z.infer<typeof QueryResultSchema>;
export type QueryResultItem = z.infer<typeof QueryResultItemSchema>;
