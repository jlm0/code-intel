import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { writeJsonAtomically, writeJsonObjectWithArrayEntriesAtomically } from "../core/index-artifacts.js";
import { schemaVersion } from "../schema/schemas.js";
import { mergeScipFacts, type ScipFacts } from "./ingest.js";

export const scipFactsSchemaVersion = "code-intel.scip-facts.v1";

export interface RepoScipFacts extends ScipFacts {
  name: string;
  outputPath: string;
  outputPaths?: string[];
  shardId?: string;
  shardKind?: string;
  projectPath?: string;
}

export interface IndexScipFacts {
  schemaVersion: typeof schemaVersion;
  factsSchemaVersion: typeof scipFactsSchemaVersion;
  workspace: string;
  generatedAt: string;
  repos: RepoScipFacts[];
}

const ScipRangeSchema = z.object({
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  startColumn: z.number().int().min(0),
  endColumn: z.number().int().min(0),
});

const ScipDefinitionSchema = z.object({
  symbol: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  relativePath: z.string().min(1),
  range: ScipRangeSchema.optional(),
  enclosingRange: ScipRangeSchema.optional(),
  documentation: z.array(z.string()),
});

const ScipOccurrenceRoleSchema = z.enum([
  "Definition",
  "Import",
  "WriteAccess",
  "ReadAccess",
  "Generated",
  "Test",
  "ForwardDefinition",
]);

const ScipReferenceSchema = z.object({
  symbol: z.string().min(1),
  symbolName: z.string().min(1),
  symbolKind: z.string().min(1),
  relativePath: z.string().min(1),
  range: ScipRangeSchema,
  enclosingRange: ScipRangeSchema.optional(),
  roles: z.array(ScipOccurrenceRoleSchema),
  isImport: z.boolean(),
  isWriteAccess: z.boolean(),
  isReadAccess: z.boolean(),
  isTest: z.boolean(),
});

const ScipOccurrenceSchema = ScipReferenceSchema.extend({
  isDefinition: z.boolean(),
  isReference: z.boolean(),
  isGenerated: z.boolean(),
  isForwardDefinition: z.boolean(),
  roleMask: z.number().int().min(0),
});

const RepoScipFactsSchema = z.object({
  name: z.string().min(1),
  outputPath: z.string().min(1),
  outputPaths: z.array(z.string().min(1)).optional(),
  shardId: z.string().min(1).optional(),
  shardKind: z.string().min(1).optional(),
  projectPath: z.string().min(1).optional(),
  definitions: z.array(ScipDefinitionSchema),
  references: z.array(ScipReferenceSchema),
  occurrences: z.array(ScipOccurrenceSchema),
});

const IndexScipFactsSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  factsSchemaVersion: z.literal(scipFactsSchemaVersion),
  workspace: z.string().min(1),
  generatedAt: z.string().datetime(),
  repos: z.array(RepoScipFactsSchema),
});

export async function writeScipFacts(generationPath: string, facts: IndexScipFacts): Promise<void> {
  const factsPath = join(generationPath, "facts");
  await mkdir(factsPath, { recursive: true });
  await writeJsonAtomically(join(factsPath, "scip.json"), IndexScipFactsSchema.parse(facts));
}

export async function writeScipFactsFromRepoFiles(
  generationPath: string,
  input: {
    workspace: string;
    generatedAt: string;
    repoFactPaths: string[];
  },
): Promise<void> {
  const factsPath = join(generationPath, "facts");
  await mkdir(factsPath, { recursive: true });
  await writeJsonObjectWithArrayEntriesAtomically(
    join(factsPath, "scip.json"),
    {
      schemaVersion,
      factsSchemaVersion: scipFactsSchemaVersion,
      workspace: input.workspace,
      generatedAt: input.generatedAt,
    },
    "repos",
    repoFactsFromFiles(input.repoFactPaths),
  );
}

async function* repoFactsFromFiles(paths: string[]): AsyncIterable<RepoScipFacts> {
  const factsByRepo = new Map<string, RepoScipFacts[]>();
  for (const path of paths) {
    const facts = RepoScipFactsSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const repoFacts = factsByRepo.get(facts.name) ?? [];
    repoFacts.push(facts);
    factsByRepo.set(facts.name, repoFacts);
  }
  for (const repoFacts of factsByRepo.values()) {
    yield mergeRepoScipFacts(repoFacts);
  }
}

function mergeRepoScipFacts(repoFacts: RepoScipFacts[]): RepoScipFacts {
  if (repoFacts.length === 1) {
    return repoFacts[0]!;
  }
  const first = repoFacts[0]!;
  return RepoScipFactsSchema.parse({
    name: first.name,
    outputPath: first.outputPath,
    outputPaths: repoFacts.map((facts) => facts.outputPath),
    ...mergeScipFacts(repoFacts),
  });
}
