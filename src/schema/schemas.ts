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
  chunksEmbedded: z.number().int().min(0).optional(),
  chunksReused: z.number().int().min(0).optional(),
  nodesWritten: z.number().int().min(0).optional(),
  edgesWritten: z.number().int().min(0).optional(),
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
  counters: IndexProgressCountersSchema.default({}),
  error: z.string().optional(),
  staleReason: z.enum(["process-exited", "heartbeat-timeout"]).optional(),
});

export const IndexProgressResultSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  indexPath: z.string().min(1),
  progress: IndexProgressSnapshotSchema.optional(),
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
export type IndexProgressOperation = z.infer<typeof IndexProgressOperationSchema>;
export type IndexProgressPhase = z.infer<typeof IndexProgressPhaseSchema>;
export type IndexProgressResult = z.infer<typeof IndexProgressResultSchema>;
export type IndexProgressSnapshot = z.infer<typeof IndexProgressSnapshotSchema>;
export type IndexProgressStatus = z.infer<typeof IndexProgressStatusSchema>;
export type QueryResult = z.infer<typeof QueryResultSchema>;
export type QueryResultItem = z.infer<typeof QueryResultItemSchema>;
