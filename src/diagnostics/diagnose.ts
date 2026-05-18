import { relative, resolve } from "node:path";

import { normalizeRelativePath } from "../core/ids.js";
import { schemaVersion, type CodeNode } from "../schema/schemas.js";
import { readActiveIndexDiagnostics } from "./persistence.js";
import {
  diagnosticsSchemaVersion,
  type DiagnoseFileResult,
  type DiagnoseSymbolResult,
  type FileLifecycleDiagnostic,
} from "./types.js";

export async function diagnoseIndexedFile(indexPath: string, fileQuery: string): Promise<DiagnoseFileResult> {
  const diagnostics = await readActiveIndexDiagnostics(indexPath);
  const normalizedQuery = normalizeDiagnosticPath(fileQuery);
  const file = diagnostics?.files.find((candidate) =>
    candidate.relativePath === normalizedQuery ||
    candidate.absolutePath === fileQuery ||
    normalizeDiagnosticPath(candidate.absolutePath ?? "") === normalizedQuery ||
    candidate.relativePath.endsWith(`/${normalizedQuery}`),
  );
  const inferredFile = file ?? inferSkippedFileFromDirectory(diagnostics?.files ?? [], normalizedQuery);
  return {
    schemaVersion,
    diagnosticsSchemaVersion,
    query: fileQuery,
    matched: Boolean(inferredFile),
    file: inferredFile,
  };
}

export async function diagnoseIndexedSymbol(input: {
  indexPath: string;
  symbolQuery: string;
  nodes: CodeNode[];
}): Promise<DiagnoseSymbolResult> {
  const diagnostics = await readActiveIndexDiagnostics(input.indexPath);
  const filesByPath = new Map((diagnostics?.files ?? []).map((file) => [`${file.repo}\0${file.relativePath}`, file]));
  const query = input.symbolQuery.toLowerCase();
  const symbols = input.nodes
    .filter((node) =>
      diagnosableSymbolKinds.has(node.kind) &&
      typeof node.name === "string" &&
      (node.name.toLowerCase() === query || String(node.metadata.qualifiedName ?? "").toLowerCase() === query)
    )
    .sort((left, right) =>
      symbolDiagnosticRank(left, input.symbolQuery) - symbolDiagnosticRank(right, input.symbolQuery) ||
      (left.file ?? "").localeCompare(right.file ?? "") ||
      left.id.localeCompare(right.id),
    )
    .map((node) => ({
      id: node.id,
      name: node.name ?? "",
      kind: node.kind,
      repo: node.repo,
      file: node.file,
      lifecycle: node.file ? filesByPath.get(`${node.repo}\0${node.file}`) : undefined,
    }));
  return {
    schemaVersion,
    diagnosticsSchemaVersion,
    query: input.symbolQuery,
    matched: symbols.length > 0,
    symbols,
  };
}

const diagnosableSymbolKinds = new Set(["Function", "Class", "Interface", "TypeAlias", "Symbol", "Test", "Chunk"]);

function symbolDiagnosticRank(node: CodeNode, query: string): number {
  if (node.kind === "Function" || node.kind === "Class" || node.kind === "Interface" || node.kind === "TypeAlias") {
    return 0;
  }
  if (node.name === query) {
    return 1;
  }
  return 2;
}

function normalizeDiagnosticPath(path: string): string {
  if (!path) {
    return path;
  }
  const normalized = normalizeRelativePath(path);
  if (!normalized.startsWith("/")) {
    return normalized;
  }
  return normalizeRelativePath(relative(resolve("/"), normalized));
}

function inferSkippedFileFromDirectory(
  files: FileLifecycleDiagnostic[],
  normalizedQuery: string,
): FileLifecycleDiagnostic | undefined {
  const skippedDirectory = files
    .filter((file) =>
      file.status === "skipped" &&
      file.reasons.includes("ignored-directory") &&
      (normalizedQuery.startsWith(`${file.relativePath}/`) || normalizedQuery === file.relativePath),
    )
    .sort((left, right) => right.relativePath.length - left.relativePath.length)[0];
  if (!skippedDirectory) {
    return undefined;
  }
  return {
    ...skippedDirectory,
    relativePath: normalizedQuery,
    absolutePath: skippedDirectory.absolutePath
      ? resolve(skippedDirectory.absolutePath, relative(skippedDirectory.relativePath, normalizedQuery))
      : undefined,
  };
}
