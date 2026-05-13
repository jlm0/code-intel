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

export const McpToolPayloadSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  tool: z.string().min(1),
  result: z.unknown(),
});

export type CodeNode = z.infer<typeof CodeNodeSchema>;
export type CodeEdge = z.infer<typeof CodeEdgeSchema>;
export type CodeChunk = z.infer<typeof ChunkSchema>;
export type HealthCheck = z.infer<typeof HealthCheckSchema>;
export type IndexManifest = z.infer<typeof IndexManifestSchema>;
export type QueryResult = z.infer<typeof QueryResultSchema>;
export type QueryResultItem = z.infer<typeof QueryResultItemSchema>;
