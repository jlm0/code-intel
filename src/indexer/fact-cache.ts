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

export const factsSchemaVersion = "code-intel.facts.v2";
const embeddingFactsSchemaVersion = "code-intel.embeddings.v1";

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
  hasParseError?: boolean;
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
  factsSchemaVersion: typeof factsSchemaVersion;
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

interface IndexEmbeddingFacts {
  schemaVersion: typeof schemaVersion;
  factsSchemaVersion: typeof embeddingFactsSchemaVersion;
  workspace: string;
  generatedAt: string;
  embedding: IndexFacts["embedding"];
  chunks: Array<{
    repo: string;
    relativePath: string;
    idSuffix: string;
    embeddingInputHash: string;
    embedding: number[];
  }>;
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
  importKind: z.enum(["value", "type", "side-effect", "dynamic", "commonjs"]),
  importedName: z.string().optional(),
  localName: z.string().optional(),
  isDefault: z.boolean(),
  isNamespace: z.boolean(),
});

const SourceExportFactSchema = SourceFactBaseSchema.extend({
  exportKind: z.enum(["local", "re-export", "default", "commonjs", "type"]),
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
    "Namespace",
    "Enum",
    "Variable",
    "VariableFunction",
    "ClassMethod",
    "ClassField",
    "ClassAccessor",
    "Object",
    "ObjectMethod",
    "AmbientModule",
  ]),
  exported: z.boolean(),
  defaultExport: z.boolean(),
  decorators: z.array(z.string()).default([]),
  parentName: z.string().optional(),
});

const SourceCallFactSchema = SourceFactBaseSchema.extend({
  name: z.string().min(1),
  callKind: z.enum(["function", "member", "constructor", "dynamic-import", "jsx", "tagged-template"]).default("function"),
  memberPath: z.string().optional(),
  receiver: z.string().optional(),
  propertyName: z.string().optional(),
  optionalChain: z.boolean().default(false),
  argumentSpecifier: z.string().optional(),
  containingDeclarationName: z.string().optional(),
});

const SourceMemberAccessFactSchema = SourceFactBaseSchema.extend({
  path: z.string().min(1),
  propertyName: z.string().min(1),
  optionalChain: z.boolean().default(false),
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
  hasParseError: z.boolean().optional(),
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
  factsSchemaVersion: z.literal(factsSchemaVersion).default(factsSchemaVersion),
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

const IndexEmbeddingFactsSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  factsSchemaVersion: z.literal(embeddingFactsSchemaVersion),
  workspace: z.string().min(1),
  generatedAt: z.string().datetime(),
  embedding: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    dimension: z.number().int().min(1),
  }),
  chunks: z.array(
    z.object({
      repo: z.string().min(1),
      relativePath: z.string().min(1),
      idSuffix: z.string().min(1),
      embeddingInputHash: z.string().min(1),
      embedding: z.array(z.number()),
    }),
  ),
});

export async function readActiveIndexFacts(indexPath: string): Promise<IndexFacts | undefined> {
  const generationPath = await resolveActiveGenerationPath(indexPath);
  if (!generationPath) {
    return undefined;
  }
  try {
    const facts = IndexFactsSchema.parse(
      JSON.parse(await readFile(join(generationPath, "facts", "files.json"), "utf8")),
    );
    const embeddings = await readIndexEmbeddingFacts(generationPath);
    return mergeEmbeddingFacts(facts, embeddings);
  } catch {
    return undefined;
  }
}

export async function writeIndexFacts(generationPath: string, facts: IndexFacts): Promise<void> {
  const factsPath = join(generationPath, "facts");
  await mkdir(factsPath, { recursive: true });
  const parsed = IndexFactsSchema.parse({ ...facts, factsSchemaVersion });
  const embeddingFacts = extractEmbeddingFacts(parsed);
  await writeJsonAtomically(join(factsPath, "files.json"), stripEmbeddings(parsed));
  await writeJsonAtomically(join(factsPath, "embeddings.json"), IndexEmbeddingFactsSchema.parse(embeddingFacts));
}

async function readIndexEmbeddingFacts(generationPath: string): Promise<IndexEmbeddingFacts | undefined> {
  try {
    return IndexEmbeddingFactsSchema.parse(
      JSON.parse(await readFile(join(generationPath, "facts", "embeddings.json"), "utf8")),
    );
  } catch {
    return undefined;
  }
}

function mergeEmbeddingFacts(facts: IndexFacts, embeddingFacts: IndexEmbeddingFacts | undefined): IndexFacts {
  if (
    !embeddingFacts ||
    embeddingFacts.embedding.provider !== facts.embedding.provider ||
    embeddingFacts.embedding.model !== facts.embedding.model ||
    embeddingFacts.embedding.dimension !== facts.embedding.dimension
  ) {
    return facts;
  }
  const embeddings = new Map(
    embeddingFacts.chunks.map((chunk) => [embeddingKey(chunk), chunk.embedding]),
  );
  return {
    ...facts,
    files: facts.files.map((file) => ({
      ...file,
      chunks: file.chunks.map((chunk) => ({
        ...chunk,
        embedding: chunk.embedding ?? embeddings.get(
          embeddingKey({
            repo: file.fingerprint.repo,
            relativePath: file.fingerprint.relativePath,
            idSuffix: chunk.idSuffix,
            embeddingInputHash: chunk.embeddingInputHash,
          }),
        ),
      })),
    })),
  };
}

function extractEmbeddingFacts(facts: IndexFacts): IndexEmbeddingFacts {
  return {
    schemaVersion,
    factsSchemaVersion: embeddingFactsSchemaVersion,
    workspace: facts.workspace,
    generatedAt: facts.generatedAt,
    embedding: facts.embedding,
    chunks: facts.files.flatMap((file) =>
      file.chunks.flatMap((chunk) =>
        chunk.embedding
          ? [
              {
                repo: file.fingerprint.repo,
                relativePath: file.fingerprint.relativePath,
                idSuffix: chunk.idSuffix,
                embeddingInputHash: chunk.embeddingInputHash,
                embedding: chunk.embedding,
              },
            ]
          : [],
      ),
    ),
  };
}

function stripEmbeddings(facts: IndexFacts): IndexFacts {
  return {
    ...facts,
    factsSchemaVersion,
    files: facts.files.map((file) => ({
      ...file,
      chunks: file.chunks.map((chunk) => {
        const { embedding, ...chunkWithoutEmbedding } = chunk;
        return chunkWithoutEmbedding;
      }),
    })),
  };
}

function embeddingKey(input: {
  repo: string;
  relativePath: string;
  idSuffix: string;
  embeddingInputHash: string;
}): string {
  return `${input.repo}\0${input.relativePath}\0${input.idSuffix}\0${input.embeddingInputHash}`;
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
