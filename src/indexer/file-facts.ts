import {
  extractSourceFileFacts,
  type SourceChunk,
} from "../treesitter/chunker.js";
import type { EmbeddingProvider } from "../vectors/embedding.js";
import type { DiscoveredWorkspace } from "../workspace/discovery.js";
import {
  createEmbeddingCache,
  filesByFingerprintKey,
  fingerprintsByKey,
  type ChunkFact,
  type FileFact,
  type IndexFacts,
} from "./fact-cache.js";
import {
  calculateConfigHash,
  fingerprintDiscoveredFile,
  sha256,
  type FingerprintedFile,
} from "./fingerprints.js";
import { fingerprintKey, planIncrementalUpdate, type IncrementalPlan } from "./update-planner.js";

export interface FileFactPlan {
  fileFactsByKey: Map<string, FileFact>;
  incrementalPlan?: IncrementalPlan;
  configHash: string;
  embeddingCache: Map<string, number[]>;
}

export async function prepareFileFacts(input: {
  workspace: DiscoveredWorkspace;
  previousFacts?: IndexFacts;
  embeddingProvider: EmbeddingProvider;
  mode: "index" | "update";
  includeIgnored?: boolean;
  workspaceManifestPath?: string;
}): Promise<FileFactPlan> {
  const configHash = await calculateConfigHash({
    workspace: input.workspace,
    includeIgnored: input.includeIgnored,
    workspaceManifestPath: input.workspaceManifestPath,
    embeddingProvider: input.embeddingProvider,
  });
  const fingerprintedFiles = await fingerprintWorkspaceFiles(input.workspace);
  const currentFingerprints = new Map(
    [...fingerprintedFiles.values()].map((file) => [fingerprintKey(file.fingerprint), file.fingerprint]),
  );
  const previousFingerprints = fingerprintsByKey(input.previousFacts);
  const previousFileFacts = filesByFingerprintKey(input.previousFacts);
  const hasReusablePreviousFacts = input.mode === "update" && input.previousFacts !== undefined;
  const configChanged = !hasReusablePreviousFacts || input.previousFacts?.configHash !== configHash;
  const incrementalPlan = input.mode === "update"
    ? planIncrementalUpdate({
        previous: previousFingerprints,
        current: currentFingerprints,
        configChanged,
      })
    : undefined;
  const reusableFileKeys = new Set(
    incrementalPlan && !incrementalPlan.fullRebuild
      ? incrementalPlan.unchanged.map((fingerprint) => fingerprintKey(fingerprint))
      : [],
  );
  const fileFactsByKey = new Map<string, FileFact>();

  for (const [key, file] of fingerprintedFiles) {
    const previousFact = previousFileFacts.get(key);
    if (previousFact && reusableFileKeys.has(key)) {
      fileFactsByKey.set(key, {
        fingerprint: file.fingerprint,
        chunks: previousFact.chunks.map(cloneChunkFact),
        imports: cloneFacts(previousFact.imports),
        exports: cloneFacts(previousFact.exports),
        declarations: cloneFacts(previousFact.declarations),
        calls: cloneFacts(previousFact.calls),
        memberAccesses: cloneFacts(previousFact.memberAccesses),
        ownerships: cloneFacts(previousFact.ownerships),
        testCases: cloneFacts(previousFact.testCases),
        callbacks: cloneFacts(previousFact.callbacks),
      });
    } else {
      const astFacts = extractSourceFileFacts({
        relativePath: file.discoveredFile.relativePath,
        content: file.content,
      });
      fileFactsByKey.set(key, {
        fingerprint: file.fingerprint,
        chunks: astFacts.chunks.map(sourceChunkToFact),
        imports: cloneFacts(astFacts.imports),
        exports: cloneFacts(astFacts.exports),
        declarations: cloneFacts(astFacts.declarations),
        calls: cloneFacts(astFacts.calls),
        memberAccesses: cloneFacts(astFacts.memberAccesses),
        ownerships: cloneFacts(astFacts.ownerships),
        testCases: cloneFacts(astFacts.testCases),
        callbacks: cloneFacts(astFacts.callbacks),
      });
    }
  }

  return {
    fileFactsByKey,
    incrementalPlan,
    configHash,
    embeddingCache: incrementalPlan && !incrementalPlan.fullRebuild
      ? createEmbeddingCache(input.previousFacts, input.embeddingProvider)
      : new Map(),
  };
}

async function fingerprintWorkspaceFiles(workspace: DiscoveredWorkspace): Promise<Map<string, FingerprintedFile>> {
  const files = new Map<string, FingerprintedFile>();
  for (const repo of workspace.repos) {
    const fingerprintedFiles = await Promise.all(
      repo.files.map((file) => fingerprintDiscoveredFile(repo, file)),
    );
    for (const file of fingerprintedFiles) {
      files.set(fingerprintKey(file.fingerprint), file);
    }
  }
  return files;
}

function sourceChunkToFact(chunk: SourceChunk): ChunkFact {
  return {
    idSuffix: chunk.idSuffix,
    name: chunk.name,
    kind: chunk.kind,
    range: chunk.range,
    content: chunk.content,
    contentHash: chunk.contentHash,
    calls: chunk.calls,
    embeddingInputHash: sha256(`${chunk.name}\n${chunk.content}`),
  };
}

function cloneChunkFact(chunk: ChunkFact): ChunkFact {
  return {
    ...chunk,
    range: { ...chunk.range },
    calls: [...chunk.calls],
    embedding: chunk.embedding ? [...chunk.embedding] : undefined,
  };
}

function cloneFacts<T>(facts: T[]): T[] {
  return facts.map((fact) => JSON.parse(JSON.stringify(fact)) as T);
}
