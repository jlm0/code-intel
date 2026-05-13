import { readFile, stat } from "node:fs/promises";

import { deserializeSCIP } from "@c4312/scip";

export interface ScipFacts {
  definitions: ScipDefinition[];
  references: ScipReference[];
}

export interface ScipDefinition {
  symbol: string;
  name: string;
  relativePath: string;
  range?: ScipRange;
  documentation: string[];
}

export interface ScipReference {
  symbol: string;
  symbolName: string;
  relativePath: string;
  range: ScipRange;
}

export interface ScipRange {
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
}

const definitionRole = 1;
const maxScipFileBytes = 128_000_000;

export async function ingestScipIndex(outputPath: string): Promise<ScipFacts> {
  const scipSize = (await stat(outputPath)).size;
  if (scipSize > maxScipFileBytes) {
    throw new Error(`SCIP file exceeds ${maxScipFileBytes} bytes: ${outputPath}`);
  }
  const index = deserializeSCIP(await readFile(outputPath));
  const definitions: ScipDefinition[] = [];
  const definitionBySymbol = new Map<string, ScipDefinition>();

  for (const document of index.documents) {
    for (const symbol of document.symbols) {
      const name = extractSymbolName(symbol.documentation, symbol.symbol);
      if (!name || isParameterSymbol(symbol.symbol)) {
        continue;
      }
      const definitionOccurrence = document.occurrences.find(
        (occurrence) => occurrence.symbol === symbol.symbol && (occurrence.symbolRoles & definitionRole) === definitionRole,
      );
      const definition: ScipDefinition = {
        symbol: symbol.symbol,
        name,
        relativePath: document.relativePath,
        range: definitionOccurrence ? convertRange(definitionOccurrence.range) : undefined,
        documentation: [...symbol.documentation],
      };
      definitions.push(definition);
      definitionBySymbol.set(symbol.symbol, definition);
    }
  }

  const references: ScipReference[] = [];
  for (const document of index.documents) {
    for (const occurrence of document.occurrences) {
      if ((occurrence.symbolRoles & definitionRole) === definitionRole) {
        continue;
      }
      const definition = definitionBySymbol.get(occurrence.symbol);
      if (!definition) {
        continue;
      }
      references.push({
        symbol: occurrence.symbol,
        symbolName: definition.name,
        relativePath: document.relativePath,
        range: convertRange(occurrence.range),
      });
    }
  }

  return { definitions, references };
}

function extractSymbolName(documentation: string[], symbol: string): string | undefined {
  const doc = documentation.join("\n");
  const docMatch =
    doc.match(/\bfunction\s+([A-Za-z_$][\w$]*)/) ??
    doc.match(/\bclass\s+([A-Za-z_$][\w$]*)/) ??
    doc.match(/\binterface\s+([A-Za-z_$][\w$]*)/) ??
    doc.match(/\btype\s+([A-Za-z_$][\w$]*)/) ??
    doc.match(/\(method\)\s+([A-Za-z_$][\w$]*)/);
  if (docMatch?.[1]) {
    return docMatch[1];
  }

  const symbolMatch = symbol.match(/\/([A-Za-z_$][\w$]*)(?:\(\)\.|#|$)/);
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
