import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { indexWorkspace } from "../indexer/indexer.js";
import { createQueryEngine } from "../query/query-engine.js";
import { createEmbeddingProvider } from "../vectors/embedding.js";
import {
  schemaVersion,
  type IndexManifest,
} from "../schema/schemas.js";
import {
  defaultEvalSuiteId,
  loadEvalPack,
  prepareEvalCorpus,
  type EvalPack,
  type PreparedEvalCorpus,
} from "./eval-pack.js";
import { runAstEvalCase } from "./ast-case.js";
import { runGraphEvalCase } from "./graph-case.js";
import { runEvalCase } from "./query-case.js";
import type {
  AstEvalCaseResult,
  EvalCaseResult,
  GraphEvalCaseResult,
} from "./results.js";
import { summarizeEvalResults, type EvalReportSummary } from "./report-summary.js";

export interface EvalOptions {
  workspace?: string;
  suite?: string;
  evalPack?: string;
  evalCachePath?: string;
  fetch?: boolean;
  embeddingProvider?: string;
  embeddingModel?: string;
}

export interface EvalReport {
  schemaVersion: typeof schemaVersion;
  status: "pass" | "fail";
  blockingStatus: "pass" | "fail";
  qualityStatus: "pass" | "fail";
  suite: {
    id: string;
    name: string;
    version: string;
    kind: EvalPack["kind"];
    description: string;
    license?: string;
  };
  corpus: {
    type: PreparedEvalCorpus["type"];
    path: string;
    repoPaths: string[];
    source?: PreparedEvalCorpus["source"];
  };
  embedding: {
    provider: string;
    model: string;
    dimension: number;
  };
  index: {
    stats: IndexManifest["stats"];
    repos: IndexManifest["repos"];
  };
  summary: EvalReportSummary;
  cases: EvalCaseResult[];
  astCases: AstEvalCaseResult[];
  graphCases: GraphEvalCaseResult[];
}

export async function runEvalSuite(options: EvalOptions = {}): Promise<EvalReport> {
  const workspaceRoot = resolve(options.workspace ?? process.cwd());
  const loadedPack = await loadEvalPack({
    suite: options.evalPack ? options.suite : options.suite ?? defaultEvalSuiteId(),
    evalPackPath: options.evalPack,
    workspaceRoot,
  });
  const corpus = await prepareEvalCorpus({
    loadedPack,
    workspaceRoot,
    evalCachePath: options.evalCachePath,
    fetch: options.fetch,
  });
  const embeddingProvider = await createEmbeddingProvider({
    provider: options.embeddingProvider,
    model: options.embeddingModel,
    indexPath: resolve(
      workspaceRoot,
      options.evalCachePath ?? join(".code-intel", "eval-corpora"),
      "_embedding-cache",
    ),
  });
  const indexPath = await mkdtemp(join(tmpdir(), "code-intel-eval-"));
  try {
    const manifest = await indexWorkspace({
      workspaceRoot: corpus.path,
      repoPaths: corpus.repoPaths,
      indexPath,
      embeddingProvider,
    });
    const engine = createQueryEngine({ indexPath });
    try {
      const cases: EvalCaseResult[] = [];
      for (const testCase of loadedPack.cases) {
        cases.push(await runEvalCase(testCase, engine));
      }
      const astCases: AstEvalCaseResult[] = [];
      for (const testCase of loadedPack.astCases) {
        astCases.push(await runAstEvalCase(testCase, corpus));
      }
      const graphCases: GraphEvalCaseResult[] = [];
      for (const testCase of loadedPack.graphCases) {
        graphCases.push(await runGraphEvalCase(testCase, engine.getRepository()));
      }
      const summary = summarizeEvalResults([...cases, ...astCases, ...graphCases]);

      return {
        schemaVersion,
        status: summary.blockingStatus,
        blockingStatus: summary.blockingStatus,
        qualityStatus: summary.qualityStatus,
        suite: {
          id: loadedPack.pack.id,
          name: loadedPack.pack.name,
          version: loadedPack.pack.version,
          kind: loadedPack.pack.kind,
          description: loadedPack.pack.description,
          license: loadedPack.pack.license,
        },
        corpus,
        embedding: manifest.embedding,
        index: {
          stats: manifest.stats,
          repos: manifest.repos,
        },
        summary,
        cases,
        astCases,
        graphCases,
      };
    } finally {
      await engine.close();
    }
  } finally {
    await rm(indexPath, { recursive: true, force: true });
  }
}
