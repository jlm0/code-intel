export { buildIndexDiagnostics } from "./build-index-diagnostics.js";
export { diagnoseIndexedFile, diagnoseIndexedSymbol } from "./diagnose.js";
export { readActiveIndexDiagnostics, writeIndexDiagnostics } from "./persistence.js";
export {
  diagnosticsSchemaVersion,
  type DiagnosticStage,
  type DiagnosticStageStatus,
  type DiagnoseFileResult,
  type DiagnoseSymbolResult,
  type FileLifecycleDiagnostic,
  type IndexDiagnostics,
} from "./types.js";
