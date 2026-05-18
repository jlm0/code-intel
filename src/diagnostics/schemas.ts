import { z } from "zod";

import { NodeKindSchema, schemaVersion } from "../schema/schemas.js";
import { diagnosticsSchemaVersion } from "./types.js";

export const DiagnosticStageSchema = z.object({
  status: z.enum(["pass", "warn", "fail", "skip"]),
  reason: z.string().optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
});

export const FileLifecycleDiagnosticSchema = z.object({
  repo: z.string().min(1),
  relativePath: z.string().min(1),
  absolutePath: z.string().optional(),
  packageName: z.string().optional(),
  language: z.string().optional(),
  status: z.enum(["indexed", "skipped"]),
  reasons: z.array(z.string()),
  lifecycle: z.record(z.string(), DiagnosticStageSchema),
  counts: z.object({
    chunks: z.number().int().min(0),
    imports: z.number().int().min(0),
    exports: z.number().int().min(0),
    declarations: z.number().int().min(0),
    calls: z.number().int().min(0),
    scipDefinitions: z.number().int().min(0),
    scipReferences: z.number().int().min(0),
    graphNodes: z.number().int().min(0),
    graphEdges: z.number().int().min(0),
    embeddedChunks: z.number().int().min(0),
  }),
  queryability: z.object({
    exact: z.boolean(),
    symbol: z.boolean(),
    semantic: z.boolean(),
    symbolNames: z.array(z.string()),
  }),
});

export const DiagnoseFileResultSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  diagnosticsSchemaVersion: z.literal(diagnosticsSchemaVersion),
  query: z.string(),
  matched: z.boolean(),
  file: FileLifecycleDiagnosticSchema.optional(),
});

export const DiagnoseSymbolResultSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  diagnosticsSchemaVersion: z.literal(diagnosticsSchemaVersion),
  query: z.string(),
  matched: z.boolean(),
  symbols: z.array(z.object({
    id: z.string().min(1),
    name: z.string(),
    kind: NodeKindSchema,
    repo: z.string().min(1),
    file: z.string().optional(),
    lifecycle: z.object({
      status: z.enum(["indexed", "skipped"]),
      lifecycle: z.record(z.string(), DiagnosticStageSchema),
      queryability: FileLifecycleDiagnosticSchema.shape.queryability,
      counts: FileLifecycleDiagnosticSchema.shape.counts,
    }).optional(),
  })),
});
