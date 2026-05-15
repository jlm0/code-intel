import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { resolveActiveGenerationPath, writeJsonAtomically } from "../core/index-artifacts.js";
import {
  FileFingerprintSchema,
  RangeSchema,
  schemaVersion,
  type FileFingerprint,
} from "../schema/schemas.js";
import type {
  SourceCallbackFact,
  SourceCallFact,
  SourceDeclarationFact,
  SourceExportFact,
  SourceImportFact,
  SourceMemberAccessFact,
  SourceOwnershipFact,
  SourceTestCaseFact,
} from "../treesitter/chunker.js";
import type { EmbeddingProvider } from "../vectors/embedding.js";
import { fingerprintKey } from "./update-planner.js";

export interface ChunkFact {
  idSuffix: string;
  name: string;
  kind: "Function" | "Class" | "Interface" | "TypeAlias" | "Chunk" | "Test";
  range: {
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
  };
  content: string;
  contentHash: string;
  calls: string[];
  embeddingInputHash: string;
  embedding?: number[];
}

export interface FileFact {
  fingerprint: FileFingerprint;
  chunks: ChunkFact[];
  imports: SourceImportFact[];
  exports: SourceExportFact[];
  declarations: SourceDeclarationFact[];
  calls: SourceCallFact[];
  memberAccesses: SourceMemberAccessFact[];
  ownerships: SourceOwnershipFact[];
  testCases: SourceTestCaseFact[];
  callbacks: SourceCallbackFact[];
}

export interface IndexFacts {
  schemaVersion: typeof schemaVersion;
  workspace: string;
  generatedAt: string;
  configHash: string;
  embedding: {
    provider: string;
    model: string;
    dimension: number;
  };
  files: FileFact[];
}

const ChunkFactSchema = z.object({
  idSuffix: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["Function", "Class", "Interface", "TypeAlias", "Chunk", "Test"]),
  range: RangeSchema.required(),
  content: z.string(),
  contentHash: z.string().min(1),
  calls: z.array(z.string()),
  embeddingInputHash: z.string().min(1),
  embedding: z.array(z.number()).optional(),
});

const SourceFactBaseSchema = z.object({
  idSuffix: z.string().min(1),
  range: RangeSchema.required(),
  sourceText: z.string(),
  contentHash: z.string().min(1),
  ownerFile: z.string().min(1),
  containingChunkIdSuffix: z.string().optional(),
});

const SourceImportFactSchema = SourceFactBaseSchema.extend({
  moduleSpecifier: z.string().min(1),
  importKind: z.enum(["value", "type", "side-effect"]),
  importedName: z.string().optional(),
  localName: z.string().optional(),
  isDefault: z.boolean(),
  isNamespace: z.boolean(),
});

const SourceExportFactSchema = SourceFactBaseSchema.extend({
  exportKind: z.enum(["local", "re-export", "default"]),
  exportedName: z.string().min(1),
  localName: z.string().optional(),
  moduleSpecifier: z.string().optional(),
});

const SourceDeclarationFactSchema = SourceFactBaseSchema.extend({
  name: z.string().min(1),
  qualifiedName: z.string().min(1),
  kind: z.enum([
    "Function",
    "Class",
    "Interface",
    "TypeAlias",
    "VariableFunction",
    "ClassMethod",
    "Object",
    "ObjectMethod",
  ]),
  exported: z.boolean(),
  defaultExport: z.boolean(),
  parentName: z.string().optional(),
});

const SourceCallFactSchema = SourceFactBaseSchema.extend({
  name: z.string().min(1),
  memberPath: z.string().optional(),
  containingDeclarationName: z.string().optional(),
});

const SourceMemberAccessFactSchema = SourceFactBaseSchema.extend({
  path: z.string().min(1),
  propertyName: z.string().min(1),
  containingDeclarationName: z.string().optional(),
});

const SourceOwnershipFactSchema = z.object({
  idSuffix: z.string().min(1),
  ownerName: z.string().min(1),
  childName: z.string().min(1),
  relationship: z.literal("contains"),
  range: RangeSchema.required(),
  ownerFile: z.string().min(1),
});

const SourceTestCaseFactSchema = SourceFactBaseSchema.extend({
  kind: z.enum(["Suite", "Test"]),
  name: z.string().min(1),
  title: z.string().min(1),
  callee: z.enum(["describe", "it", "test"]),
  parentName: z.string().optional(),
});

const SourceCallbackFactSchema = SourceFactBaseSchema.extend({
  name: z.string().min(1),
  parentName: z.string().optional(),
});

const FileFactSchema = z.object({
  fingerprint: FileFingerprintSchema,
  chunks: z.array(ChunkFactSchema),
  imports: z.array(SourceImportFactSchema).default([]),
  exports: z.array(SourceExportFactSchema).default([]),
  declarations: z.array(SourceDeclarationFactSchema).default([]),
  calls: z.array(SourceCallFactSchema).default([]),
  memberAccesses: z.array(SourceMemberAccessFactSchema).default([]),
  ownerships: z.array(SourceOwnershipFactSchema).default([]),
  testCases: z.array(SourceTestCaseFactSchema).default([]),
  callbacks: z.array(SourceCallbackFactSchema).default([]),
});

const IndexFactsSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  workspace: z.string().min(1),
  generatedAt: z.string().datetime(),
  configHash: z.string().min(1),
  embedding: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    dimension: z.number().int().min(1),
  }),
  files: z.array(FileFactSchema),
});

export async function readActiveIndexFacts(indexPath: string): Promise<IndexFacts | undefined> {
  const generationPath = await resolveActiveGenerationPath(indexPath);
  if (!generationPath) {
    return undefined;
  }
  try {
    return IndexFactsSchema.parse(
      JSON.parse(await readFile(join(generationPath, "facts", "files.json"), "utf8")),
    );
  } catch {
    return undefined;
  }
}

export async function writeIndexFacts(generationPath: string, facts: IndexFacts): Promise<void> {
  const factsPath = join(generationPath, "facts");
  await mkdir(factsPath, { recursive: true });
  await writeJsonAtomically(join(factsPath, "files.json"), IndexFactsSchema.parse(facts));
}

export function filesByFingerprintKey(facts: IndexFacts | undefined): Map<string, FileFact> {
  return new Map((facts?.files ?? []).map((file) => [fingerprintKey(file.fingerprint), file]));
}

export function fingerprintsByKey(facts: IndexFacts | undefined): Map<string, FileFingerprint> {
  return new Map((facts?.files ?? []).map((file) => [fingerprintKey(file.fingerprint), file.fingerprint]));
}

export function createEmbeddingCache(
  facts: IndexFacts | undefined,
  embeddingProvider: EmbeddingProvider,
): Map<string, number[]> {
  if (
    !facts ||
    facts.embedding.provider !== embeddingProvider.provider ||
    facts.embedding.model !== embeddingProvider.model ||
    facts.embedding.dimension !== embeddingProvider.dimension
  ) {
    return new Map();
  }
  const cache = new Map<string, number[]>();
  for (const file of facts.files) {
    for (const chunk of file.chunks) {
      if (chunk.embedding?.length === embeddingProvider.dimension) {
        cache.set(chunk.embeddingInputHash, chunk.embedding);
      }
    }
  }
  return cache;
}
