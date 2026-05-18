import { z } from "zod";

import { schemaVersion } from "../schema/schemas.js";
import {
  diagnosticsSchemaVersion,
  type DiagnosticStage,
  type FileLifecycleDiagnostic,
  type IndexDiagnostics,
} from "./types.js";

const DiagnosticStageSchema: z.ZodType<DiagnosticStage> = z.object({
  status: z.enum(["pass", "warn", "fail", "skip"]),
  reason: z.string().optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
});

const FileLifecycleDiagnosticSchema: z.ZodType<FileLifecycleDiagnostic> = z.object({
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

export const IndexDiagnosticsSchema: z.ZodType<IndexDiagnostics> = z.object({
  schemaVersion: z.literal(schemaVersion),
  diagnosticsSchemaVersion: z.literal(diagnosticsSchemaVersion),
  workspace: z.string().min(1),
  generatedAt: z.string().datetime(),
  summary: z.object({
    candidateFiles: z.number().int().min(0),
    indexedFiles: z.number().int().min(0),
    skippedFiles: z.number().int().min(0),
    graphFiles: z.number().int().min(0),
    embeddedFiles: z.number().int().min(0),
    symbolQueryableFiles: z.number().int().min(0),
  }),
  files: z.array(FileLifecycleDiagnosticSchema),
});
