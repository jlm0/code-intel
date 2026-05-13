import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { resolveActiveGenerationPath, writeJsonAtomically } from "../core/index-artifacts.js";
import {
  FileFingerprintSchema,
  NodeKindSchema,
  RangeSchema,
  schemaVersion,
  type FileFingerprint,
} from "../schema/schemas.js";
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
  kind: NodeKindSchema.extract(["Function", "Class", "Interface", "TypeAlias", "Chunk", "Test"]),
  range: RangeSchema.required(),
  content: z.string(),
  contentHash: z.string().min(1),
  calls: z.array(z.string()),
  embeddingInputHash: z.string().min(1),
  embedding: z.array(z.number()).optional(),
});

const FileFactSchema = z.object({
  fingerprint: FileFingerprintSchema,
  chunks: z.array(ChunkFactSchema),
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
