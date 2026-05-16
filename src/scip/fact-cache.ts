import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { writeJsonAtomically } from "../core/index-artifacts.js";
import { RangeSchema, schemaVersion } from "../schema/schemas.js";
import type { ScipFacts } from "./ingest.js";

export const scipFactsSchemaVersion = "code-intel.scip-facts.v1";

export interface RepoScipFacts extends ScipFacts {
  name: string;
  outputPath: string;
}

export interface IndexScipFacts {
  schemaVersion: typeof schemaVersion;
  factsSchemaVersion: typeof scipFactsSchemaVersion;
  workspace: string;
  generatedAt: string;
  repos: RepoScipFacts[];
}

const ScipDefinitionSchema = z.object({
  symbol: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  relativePath: z.string().min(1),
  range: RangeSchema.optional(),
  enclosingRange: RangeSchema.optional(),
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
  range: RangeSchema,
  enclosingRange: RangeSchema.optional(),
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
