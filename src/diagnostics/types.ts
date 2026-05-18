import type { CodeNode, schemaVersion } from "../schema/schemas.js";

export const diagnosticsSchemaVersion = "code-intel.diagnostics.v1";

export type DiagnosticStageStatus = "pass" | "warn" | "fail" | "skip";

export interface DiagnosticStage {
  status: DiagnosticStageStatus;
  reason?: string;
  evidence?: Record<string, unknown>;
}

export interface FileLifecycleDiagnostic {
  repo: string;
  relativePath: string;
  absolutePath?: string;
  packageName?: string;
  language?: string;
  status: "indexed" | "skipped";
  reasons: string[];
  lifecycle: Record<string, DiagnosticStage>;
  counts: {
    chunks: number;
    imports: number;
    exports: number;
    declarations: number;
    calls: number;
    scipDefinitions: number;
    scipReferences: number;
    graphNodes: number;
    graphEdges: number;
    embeddedChunks: number;
  };
  queryability: {
    exact: boolean;
    symbol: boolean;
    semantic: boolean;
    symbolNames: string[];
  };
}

export interface IndexDiagnostics {
  schemaVersion: typeof schemaVersion;
  diagnosticsSchemaVersion: typeof diagnosticsSchemaVersion;
  workspace: string;
  generatedAt: string;
  summary: {
    candidateFiles: number;
    indexedFiles: number;
    skippedFiles: number;
    graphFiles: number;
    embeddedFiles: number;
    symbolQueryableFiles: number;
  };
  files: FileLifecycleDiagnostic[];
}

export interface DiagnoseFileResult {
  schemaVersion: typeof schemaVersion;
  diagnosticsSchemaVersion: typeof diagnosticsSchemaVersion;
  query: string;
  matched: boolean;
  file?: FileLifecycleDiagnostic;
}

export interface DiagnoseSymbolResult {
  schemaVersion: typeof schemaVersion;
  diagnosticsSchemaVersion: typeof diagnosticsSchemaVersion;
  query: string;
  matched: boolean;
  symbols: Array<{
    id: string;
    name: string;
    kind: CodeNode["kind"];
    repo: string;
    file?: string;
    lifecycle?: Pick<FileLifecycleDiagnostic, "status" | "lifecycle" | "queryability" | "counts">;
  }>;
}
