import { readFile, stat } from "node:fs/promises";

import {
  deserializeSCIP,
  SymbolInformation_Kind,
  SymbolRole,
  type Occurrence,
  type SymbolInformation,
} from "@c4312/scip";

export interface ScipFacts {
  definitions: ScipDefinition[];
  references: ScipReference[];
  occurrences: ScipOccurrence[];
}

export interface ScipDefinition {
  symbol: string;
  name: string;
  kind: string;
  relativePath: string;
  range?: ScipRange;
  enclosingRange?: ScipRange;
  documentation: string[];
}

export interface ScipReference {
  symbol: string;
  symbolName: string;
  symbolKind: string;
  relativePath: string;
  range: ScipRange;
  enclosingRange?: ScipRange;
  roles: ScipOccurrenceRole[];
  isImport: boolean;
  isWriteAccess: boolean;
  isReadAccess: boolean;
  isTest: boolean;
}

export interface ScipRange {
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
}

export type ScipOccurrenceRole =
  | "Definition"
  | "Import"
  | "WriteAccess"
  | "ReadAccess"
  | "Generated"
  | "Test"
  | "ForwardDefinition";

export interface ScipOccurrence {
  symbol: string;
  symbolName: string;
  symbolKind: string;
  relativePath: string;
  range: ScipRange;
  enclosingRange?: ScipRange;
  roles: ScipOccurrenceRole[];
  roleMask: number;
  isDefinition: boolean;
  isReference: boolean;
  isImport: boolean;
  isWriteAccess: boolean;
  isReadAccess: boolean;
  isGenerated: boolean;
  isTest: boolean;
  isForwardDefinition: boolean;
}

const maxScipFileBytes = 128_000_000;

export async function ingestScipIndex(outputPath: string): Promise<ScipFacts> {
  const scipSize = (await stat(outputPath)).size;
  if (scipSize > maxScipFileBytes) {
    throw new Error(`SCIP file exceeds ${maxScipFileBytes} bytes: ${outputPath}`);
  }
  const index = deserializeSCIP(await readFile(outputPath));
  const definitions: ScipDefinition[] = [];
  const definitionBySymbol = new Map<string, ScipDefinition>();
  const symbolInfoBySymbol = new Map<string, SymbolInformation>();

  for (const symbol of index.externalSymbols) {
    const normalizedSymbol = normalizeScipSymbol("", symbol.symbol);
    symbolInfoBySymbol.set(normalizedSymbol, symbol);
  }

  for (const document of index.documents) {
    for (const symbol of document.symbols) {
      const name = extractSymbolName(symbol.documentation, symbol.symbol);
      if (!name || isParameterSymbol(symbol.symbol)) {
        continue;
      }
      const normalizedSymbol = normalizeScipSymbol(document.relativePath, symbol.symbol);
      symbolInfoBySymbol.set(normalizedSymbol, symbol);
      const definitionOccurrence = document.occurrences.find(
        (occurrence) => occurrence.symbol === symbol.symbol && hasRole(occurrence, SymbolRole.Definition),
      );
      const definition: ScipDefinition = {
        symbol: normalizedSymbol,
        name,
        kind: symbolKindName(symbol.kind),
        relativePath: document.relativePath,
        range: definitionOccurrence ? convertRange(definitionOccurrence.range) : undefined,
        enclosingRange: definitionOccurrence?.enclosingRange.length
          ? convertRange(definitionOccurrence.enclosingRange)
          : undefined,
        documentation: [...symbol.documentation],
      };
      definitions.push(definition);
      definitionBySymbol.set(normalizedSymbol, definition);
    }
  }

  const occurrences: ScipOccurrence[] = [];
  for (const document of index.documents) {
    for (const occurrence of document.occurrences) {
      if (!occurrence.symbol || isParameterSymbol(occurrence.symbol)) {
        continue;
      }
      const normalizedSymbol = normalizeScipSymbol(document.relativePath, occurrence.symbol);
      const definition = definitionBySymbol.get(normalizedSymbol);
      const symbolInfo = symbolInfoBySymbol.get(normalizedSymbol);
      const symbolName = definition?.name
        ?? extractSymbolName(symbolInfo?.documentation ?? [], occurrence.symbol)
        ?? extractSymbolName([], occurrence.symbol);
      if (!symbolName) {
        continue;
      }
      const symbolKind = definition?.kind ?? symbolKindName(symbolInfo?.kind);
      const normalizedOccurrence = normalizeOccurrence({
        occurrence,
        symbol: normalizedSymbol,
        symbolName,
        symbolKind,
        relativePath: document.relativePath,
      });
      occurrences.push(normalizedOccurrence);
    }
  }

  return {
    definitions,
    references: referencesFromOccurrences(occurrences, definitionBySymbol),
    occurrences,
  };
}

export function mergeScipFacts(shardFacts: ScipFacts[]): ScipFacts {
  const definitionBySymbol = new Map<string, ScipDefinition>();
  const occurrencesByKey = new Map<string, ScipOccurrence>();

  for (const facts of shardFacts) {
    for (const definition of facts.definitions) {
      if (!definitionBySymbol.has(definition.symbol)) {
        definitionBySymbol.set(definition.symbol, definition);
      }
    }
    for (const occurrence of facts.occurrences) {
      const key = [
        occurrence.symbol,
        occurrence.relativePath,
        occurrence.range.startLine,
        occurrence.range.startColumn,
        occurrence.range.endLine,
        occurrence.range.endColumn,
        occurrence.roleMask,
      ].join(":");
      if (!occurrencesByKey.has(key)) {
        occurrencesByKey.set(key, occurrence);
      }
    }
  }

  const definitions = [...definitionBySymbol.values()].sort(compareDefinitions);
  const occurrences = [...occurrencesByKey.values()].sort(compareOccurrences);
  const references = referencesFromOccurrences(occurrences, definitionBySymbol).sort(compareReferences);
  return { definitions, references, occurrences };
}

function normalizeOccurrence(input: {
  occurrence: Occurrence;
  symbol: string;
  symbolName: string;
  symbolKind: string;
  relativePath: string;
}): ScipOccurrence {
  const roles = occurrenceRoles(input.occurrence);
  return {
    symbol: input.symbol,
    symbolName: input.symbolName,
    symbolKind: input.symbolKind,
    relativePath: input.relativePath,
    range: convertRange(input.occurrence.range),
    enclosingRange: input.occurrence.enclosingRange.length
      ? convertRange(input.occurrence.enclosingRange)
      : undefined,
    roles,
    roleMask: input.occurrence.symbolRoles,
    isDefinition: hasRole(input.occurrence, SymbolRole.Definition),
    isReference: !hasRole(input.occurrence, SymbolRole.Definition),
    isImport: hasRole(input.occurrence, SymbolRole.Import),
    isWriteAccess: hasRole(input.occurrence, SymbolRole.WriteAccess),
    isReadAccess: roles.includes("ReadAccess"),
    isGenerated: hasRole(input.occurrence, SymbolRole.Generated),
    isTest: hasRole(input.occurrence, SymbolRole.Test) || fileKindForPath(input.relativePath) === "test",
    isForwardDefinition: hasRole(input.occurrence, SymbolRole.ForwardDefinition),
  };
}

function referencesFromOccurrences(
  occurrences: ScipOccurrence[],
  definitionBySymbol: Map<string, ScipDefinition>,
): ScipReference[] {
  return occurrences
    .filter((occurrence) => occurrence.isReference)
    .map((occurrence) => {
      const definition = definitionBySymbol.get(occurrence.symbol);
      return {
        symbol: occurrence.symbol,
        symbolName: definition?.name ?? occurrence.symbolName,
        symbolKind: definition?.kind ?? occurrence.symbolKind,
        relativePath: occurrence.relativePath,
        range: occurrence.range,
        enclosingRange: occurrence.enclosingRange,
        roles: occurrence.roles,
        isImport: occurrence.isImport,
        isWriteAccess: occurrence.isWriteAccess,
        isReadAccess: occurrence.isReadAccess,
        isTest: occurrence.isTest,
      };
    });
}

function normalizeScipSymbol(relativePath: string, symbol: string): string {
  return isLocalScipSymbol(symbol) ? `local ${relativePath} ${symbol.slice("local ".length)}` : symbol;
}

function isLocalScipSymbol(symbol: string): boolean {
  return /^local \d+/.test(symbol);
}

function occurrenceRoles(occurrence: Occurrence): ScipOccurrenceRole[] {
  const roles = [
    hasRole(occurrence, SymbolRole.Definition) ? "Definition" : undefined,
    hasRole(occurrence, SymbolRole.Import) ? "Import" : undefined,
    hasRole(occurrence, SymbolRole.WriteAccess) ? "WriteAccess" : undefined,
    hasRole(occurrence, SymbolRole.ReadAccess) ? "ReadAccess" : undefined,
    hasRole(occurrence, SymbolRole.Generated) ? "Generated" : undefined,
    hasRole(occurrence, SymbolRole.Test) ? "Test" : undefined,
    hasRole(occurrence, SymbolRole.ForwardDefinition) ? "ForwardDefinition" : undefined,
  ].filter((role): role is ScipOccurrenceRole => Boolean(role));
  return roles.length === 0 && occurrence.symbol ? ["ReadAccess"] : roles;
}

function hasRole(occurrence: Occurrence, role: SymbolRole): boolean {
  return (occurrence.symbolRoles & role) === role;
}

function symbolKindName(kind: number | undefined): string {
  if (typeof kind !== "number") {
    return "Unknown";
  }
  return SymbolInformation_Kind[kind] ?? "Unknown";
}

function extractSymbolName(documentation: string[], symbol: string): string | undefined {
  const doc = documentation.join("\n");
  const docMatch =
    doc.match(/\bfunction\s+([A-Za-z_$][\w$]*)/) ??
    doc.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/) ??
    doc.match(/\bclass\s+([A-Za-z_$][\w$]*)/) ??
    doc.match(/\binterface\s+([A-Za-z_$][\w$]*)/) ??
    doc.match(/\btype\s+([A-Za-z_$][\w$]*)/) ??
    doc.match(/\(method\)\s+([A-Za-z_$][\w$]*)/) ??
    doc.match(/\(property\)\s+([A-Za-z_$][\w$]*)/);
  if (docMatch?.[1]) {
    return docMatch[1];
  }

  const symbolMatch =
    symbol.match(/\/([A-Za-z_$][\w$]*)(?:\(\)\.|#|$)/) ??
    symbol.match(/`([^`]+)`\./) ??
    symbol.match(/\.([A-Za-z_$][\w$]*)(?:\(\)|#)?$/);
  return symbolMatch?.[1];
}

function isParameterSymbol(symbol: string): boolean {
  return /\([^)]*[A-Za-z_$][\w$]*\)$/.test(symbol);
}

function convertRange(range: number[]): ScipRange {
  if (range.length === 3) {
    return {
      startLine: range[0] + 1,
      endLine: range[0] + 1,
      startColumn: range[1],
      endColumn: range[2],
    };
  }
  return {
    startLine: range[0] + 1,
    startColumn: range[1],
    endLine: range[2] + 1,
    endColumn: range[3],
  };
}

function fileKindForPath(relativePath: string): string {
  return /(^|\/)(__tests__|tests?)\//.test(relativePath) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath)
    ? "test"
    : "source";
}

function compareDefinitions(left: ScipDefinition, right: ScipDefinition): number {
  return left.relativePath.localeCompare(right.relativePath) || left.name.localeCompare(right.name);
}

function compareOccurrences(left: ScipOccurrence, right: ScipOccurrence): number {
  return (
    left.relativePath.localeCompare(right.relativePath) ||
    left.range.startLine - right.range.startLine ||
    left.range.startColumn - right.range.startColumn ||
    left.symbol.localeCompare(right.symbol)
  );
}

function compareReferences(left: ScipReference, right: ScipReference): number {
  return (
    left.relativePath.localeCompare(right.relativePath) ||
    left.range.startLine - right.range.startLine ||
    left.range.startColumn - right.range.startColumn ||
    left.symbol.localeCompare(right.symbol)
  );
}
