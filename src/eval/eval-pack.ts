import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const execFileAsync = promisify(execFile);
const evalPackSchemaVersion = "code-intel.eval-pack.v1";
const defaultSuiteId = "js-ts-general";
const defaultEvalGate = {
  id: "default.required",
  status: "required" as const,
  capability: "unspecified",
  layer: "unspecified",
};

const EvalCorpusSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("local"),
    path: z.string().min(1),
    repoPaths: z.array(z.string().min(1)).default(["."]),
  }),
  z.object({
    type: z.literal("git"),
    url: z.string().url(),
    ref: z.string().min(1),
    repoPaths: z.array(z.string().min(1)).default(["."]),
    sparsePaths: z.array(z.string().min(1)).default([]),
  }),
]);

const EvalPackSchema = z.object({
  schemaVersion: z.literal(evalPackSchemaVersion),
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  kind: z.enum(["synthetic", "external-git"]),
  description: z.string().min(1),
  license: z.string().optional(),
  corpus: EvalCorpusSchema,
  caseFiles: z.array(z.string().min(1)).min(1),
  astCaseFiles: z.array(z.string().min(1)).default([]),
});

const EvalGateMetadataSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["required", "target", "scoreboard"]),
  capability: z.string().min(1),
  layer: z.string().min(1),
  description: z.string().optional(),
});

const EvalExpectationSchema = z.object({
  file: z.string().min(1),
  symbol: z.string().optional(),
  kind: z.string().optional(),
  maxRank: z.number().int().min(1).optional(),
});

const EvalCaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mode: z.enum(["find-symbol", "references", "callers", "callees", "semantic"]),
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10),
  gate: EvalGateMetadataSchema.default(defaultEvalGate),
  expected: z.array(EvalExpectationSchema).min(1),
  notExpected: z.array(EvalExpectationSchema).default([]),
  failureClassHint: z.enum([
    "discovery",
    "chunking",
    "scip",
    "fusion",
    "graph",
    "embedding",
    "query",
    "ranking",
    "app-flow",
  ]).optional(),
});

const AstFactExpectationSchema = z.record(z.string(), z.unknown());

const AstEvalCaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  file: z.string().min(1),
  gate: EvalGateMetadataSchema.default(defaultEvalGate),
  expected: z.object({
    imports: z.array(AstFactExpectationSchema).default([]),
    exports: z.array(AstFactExpectationSchema).default([]),
    declarations: z.array(AstFactExpectationSchema).default([]),
    calls: z.array(AstFactExpectationSchema).default([]),
    memberAccesses: z.array(AstFactExpectationSchema).default([]),
    ownerships: z.array(AstFactExpectationSchema).default([]),
    testCases: z.array(AstFactExpectationSchema).default([]),
    callbacks: z.array(AstFactExpectationSchema).default([]),
  }),
});

export type EvalCorpus = z.infer<typeof EvalCorpusSchema>;
export type EvalPack = z.infer<typeof EvalPackSchema>;
export type EvalGateMetadata = z.infer<typeof EvalGateMetadataSchema>;
export type EvalGateStatus = EvalGateMetadata["status"];
export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type EvalExpectation = z.infer<typeof EvalExpectationSchema>;
export type EvalFailureClass = NonNullable<EvalCase["failureClassHint"]> | "unknown";
export type AstEvalCase = z.infer<typeof AstEvalCaseSchema>;

export interface ResolveEvalPackInput {
  suite?: string;
  evalPackPath?: string;
  workspaceRoot: string;
}

export interface PreparedEvalCorpus {
  type: EvalCorpus["type"];
  path: string;
  repoPaths: string[];
  source?: {
    url: string;
    ref: string;
    resolvedRef?: string;
    sparsePaths: string[];
  };
}

export interface LoadedEvalPack {
  pack: EvalPack;
  packPath: string;
  packRoot: string;
  cases: EvalCase[];
  astCases: AstEvalCase[];
}

export interface PrepareEvalCorpusInput {
  loadedPack: LoadedEvalPack;
  workspaceRoot: string;
  evalCachePath?: string;
  fetch?: boolean;
}

export async function loadEvalPack(input: ResolveEvalPackInput): Promise<LoadedEvalPack> {
  const packPath = resolveEvalPackPath(input);
  const packRoot = dirname(packPath);
  const pack = EvalPackSchema.parse(JSON.parse(await readFile(packPath, "utf8")));
  const caseGroups = await Promise.all(
    pack.caseFiles.map(async (caseFile) =>
      z.array(EvalCaseSchema).parse(JSON.parse(await readFile(resolve(packRoot, caseFile), "utf8"))),
    ),
  );
  const astCaseGroups = await Promise.all(
    pack.astCaseFiles.map(async (caseFile) =>
      z.array(AstEvalCaseSchema).parse(JSON.parse(await readFile(resolve(packRoot, caseFile), "utf8"))),
    ),
  );
  return {
    pack,
    packPath,
    packRoot,
    cases: caseGroups.flat(),
    astCases: astCaseGroups.flat(),
  };
}

export async function prepareEvalCorpus(input: PrepareEvalCorpusInput): Promise<PreparedEvalCorpus> {
  const { pack, packRoot } = input.loadedPack;
  if (pack.corpus.type === "local") {
    const corpusPath = resolve(packRoot, pack.corpus.path);
    await ensureDirectory(corpusPath, `Eval corpus for ${pack.id}`);
    return {
      type: "local",
      path: corpusPath,
      repoPaths: pack.corpus.repoPaths.map((repoPath) => resolve(corpusPath, repoPath)),
    };
  }

  const evalCachePath = resolve(
    input.workspaceRoot,
    input.evalCachePath ?? join(".code-intel", "eval-corpora"),
  );
  const checkoutPath = join(evalCachePath, pack.id, pack.corpus.ref.slice(0, 12));
  const cachedRef = await readGitHead(checkoutPath);
  if (cachedRef !== pack.corpus.ref) {
    if (!input.fetch) {
      throw new Error(
        `Eval pack ${pack.id} requires --fetch because no cached checkout exists at ${checkoutPath}`,
      );
    }
    await checkoutGitCorpus(pack.corpus, checkoutPath);
  }

  return {
    type: "git",
    path: checkoutPath,
    repoPaths: pack.corpus.repoPaths.map((repoPath) => resolve(checkoutPath, repoPath)),
    source: {
      url: pack.corpus.url,
      ref: pack.corpus.ref,
      resolvedRef: await readGitHead(checkoutPath),
      sparsePaths: pack.corpus.sparsePaths,
    },
  };
}

export function defaultEvalSuiteId(): string {
  return defaultSuiteId;
}

function resolveEvalPackPath(input: ResolveEvalPackInput): string {
  if (input.suite && input.evalPackPath) {
    throw new Error("Use either --suite or --eval-pack, not both");
  }
  if (input.evalPackPath) {
    const resolvedPath = resolve(input.workspaceRoot, input.evalPackPath);
    return resolvedPath.endsWith(".json") ? resolvedPath : join(resolvedPath, "pack.json");
  }
  const suite = input.suite ?? defaultSuiteId;
  if (!["js-ts-general", "oss-rallly-app-flow"].includes(suite)) {
    throw new Error(`Unknown eval suite: ${suite}`);
  }
  return join(builtInEvalPackRoot(), suite, "pack.json");
}

function builtInEvalPackRoot(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return join(currentDir, "..", "..", "eval-packs");
}

async function ensureDirectory(path: string, label: string): Promise<void> {
  try {
    const stats = await stat(path);
    if (!stats.isDirectory()) {
      throw new Error(`${label} is not a directory: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${label} does not exist: ${path}`);
    }
    throw error;
  }
}

async function checkoutGitCorpus(corpus: Extract<EvalCorpus, { type: "git" }>, checkoutPath: string): Promise<void> {
  await rm(checkoutPath, { recursive: true, force: true });
  await mkdir(dirname(checkoutPath), { recursive: true });
  await runGit(["clone", "--filter=blob:none", "--no-checkout", corpus.url, checkoutPath]);
  if (corpus.sparsePaths.length > 0) {
    await runGit(["sparse-checkout", "init", "--no-cone"], checkoutPath);
    await runGit(
      ["sparse-checkout", "set", "--no-cone", ...corpus.sparsePaths.map(escapeSparsePath)],
      checkoutPath,
    );
  }
  await runGit(["checkout", corpus.ref], checkoutPath);
}

async function readGitHead(path: string): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(["rev-parse", "HEAD"], path);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function runGit(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function escapeSparsePath(path: string): string {
  return path.replaceAll("[", "\\[").replaceAll("]", "\\]");
}
