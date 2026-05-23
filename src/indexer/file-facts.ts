import {
  extractSourceFileFacts,
  type SourceChunk,
} from "../treesitter/chunker.js";
import type { EmbeddingProvider } from "../vectors/embedding.js";
import type { DiscoveredWorkspace } from "../workspace/discovery.js";
import type { IndexPolicy } from "../core/index-policy.js";
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
import {
  chunkEmbeddingInput,
  defaultEmbeddingInputTokenBudget,
  normalizeTokenBudget,
} from "./embedding-input.js";
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
  allowedHiddenDirectories?: string[];
  workspaceManifestPath?: string;
  policy?: IndexPolicy;
}): Promise<FileFactPlan> {
  const configHash = await calculateConfigHash({
    workspace: input.workspace,
    includeIgnored: input.includeIgnored,
    allowedHiddenDirectories: input.allowedHiddenDirectories,
    workspaceManifestPath: input.workspaceManifestPath,
    embeddingProvider: input.embeddingProvider,
    policy: input.policy,
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
        hasParseError: previousFact.hasParseError,
        chunks: previousFact.chunks.map(cloneChunkFact),
        imports: cloneFacts(previousFact.imports),
        exports: cloneFacts(previousFact.exports),
        declarations: cloneFacts(previousFact.declarations),
        calls: cloneFacts(previousFact.calls),
        memberAccesses: cloneFacts(previousFact.memberAccesses),
        typeReferences: cloneFacts(previousFact.typeReferences ?? []),
        ownerships: cloneFacts(previousFact.ownerships),
        testCases: cloneFacts(previousFact.testCases),
        callbacks: cloneFacts(previousFact.callbacks),
      });
    } else {
      const astFacts = extractSourceFileFacts({
        relativePath: file.discoveredFile.relativePath,
        content: file.content,
        policy: {
          semanticChunkMode: input.policy?.chunks.semanticChunkMode,
          maxSmallObjectProperties: input.policy?.chunks.maxSmallObjectProperties,
        },
      });
      const chunks = await prepareEmbeddingInputChunks(astFacts.chunks, input.embeddingProvider, {
        inputMode: input.policy?.embedding.inputMode ?? "semantic-header",
        tokenBudget: input.policy?.embedding.tokenBudget,
        repo: file.fingerprint.repo,
        packageName: file.fingerprint.packageName,
        relativePath: file.fingerprint.relativePath,
        language: file.fingerprint.language,
        sourceRoot: sourceRootForFile(input.workspace, file.fingerprint.repo, file.fingerprint.relativePath),
      });
      fileFactsByKey.set(key, {
        fingerprint: file.fingerprint,
        hasParseError: astFacts.hasParseError,
        chunks: chunks.map(sourceChunkToFact),
        imports: cloneFacts(astFacts.imports),
        exports: cloneFacts(astFacts.exports),
        declarations: cloneFacts(astFacts.declarations),
        calls: cloneFacts(astFacts.calls),
        memberAccesses: cloneFacts(astFacts.memberAccesses),
        typeReferences: cloneFacts(astFacts.typeReferences),
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
    const fingerprintedFiles = await mapWithConcurrency(
      repo.files,
      16,
      (file) => fingerprintDiscoveredFile(repo, file),
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
    embeddingInputHash: sha256(sourceChunkEmbeddingInput(chunk)),
    embeddingInputMode: chunk.embeddingInput?.mode,
    embeddingInputHeader: cleanHeader(chunk.embeddingInput?.header),
    embeddingInputTokenCount: chunk.embeddingInput?.tokenCount,
    embeddingInputTokenBudget: chunk.embeddingInput?.tokenBudget,
    embeddingInputOversized: chunk.embeddingInput?.oversized,
    embeddingInputSplitFromIdSuffix: chunk.embeddingInput?.splitFromIdSuffix,
    embeddingInputSplitPart: chunk.embeddingInput?.splitPart,
    embeddingInputSplitTotal: chunk.embeddingInput?.splitTotal,
    embeddingInputTruncated: chunk.embeddingInput?.truncated,
  };
}

async function prepareEmbeddingInputChunks(
  chunks: SourceChunk[],
  embeddingProvider: EmbeddingProvider,
  context: {
    inputMode: "minimal" | "semantic-header";
    tokenBudget?: number;
    repo: string;
    packageName?: string;
    relativePath: string;
    language: string;
    sourceRoot?: string;
  },
): Promise<SourceChunk[]> {
  const tokenBudget = normalizeTokenBudget(
    Math.min(embeddingProvider.maxInputTokens, context.tokenBudget ?? defaultEmbeddingInputTokenBudget),
  );
  const headeredChunks = chunks.map((chunk) => withEmbeddingInput(chunk, {
    mode: context.inputMode,
    header: embeddingHeader(chunk, context),
  }));
  const tokenCounts = await embeddingProvider.countTokens(headeredChunks.map(sourceChunkEmbeddingInput));
  const prepared: SourceChunk[] = [];

  for (const [index, chunk] of headeredChunks.entries()) {
    const tokenCount = tokenCounts[index] ?? 0;
    if (tokenCount <= tokenBudget) {
      prepared.push(withEmbeddingInput(chunk, {
        tokenCount,
        tokenBudget,
        oversized: false,
      }));
      continue;
    }
    prepared.push(...await splitOversizedChunk(chunk, embeddingProvider, tokenBudget));
  }

  return prepared;
}

async function splitOversizedChunk(
  chunk: SourceChunk,
  embeddingProvider: EmbeddingProvider,
  tokenBudget: number,
): Promise<SourceChunk[]> {
  const pieces = await splitContentByTokenBudget(chunk, embeddingProvider, tokenBudget);
  if (pieces.length <= 1) {
    const tokenCount = (await embeddingProvider.countTokens([sourceChunkEmbeddingInput(chunk)]))[0] ?? 0;
    return [withEmbeddingInput(chunk, {
      tokenCount,
      tokenBudget,
      oversized: tokenCount > tokenBudget,
      truncated: false,
    })];
  }
  return pieces.map((piece, index) => withEmbeddingInput({
    ...chunk,
    idSuffix: `${chunk.idSuffix}:part-${index + 1}`,
    name: `${chunk.name} part ${index + 1}`,
    kind: index === 0 ? chunk.kind : "Chunk",
    range: piece.range,
    content: piece.content,
    contentHash: sha256(piece.content),
  }, {
    tokenCount: piece.tokenCount,
    tokenBudget,
    oversized: piece.tokenCount > tokenBudget,
    splitFromIdSuffix: chunk.idSuffix,
    splitPart: index + 1,
    splitTotal: pieces.length,
    truncated: false,
  }));
}

async function splitContentByTokenBudget(
  chunk: SourceChunk,
  embeddingProvider: EmbeddingProvider,
  tokenBudget: number,
): Promise<Array<{ content: string; range: SourceChunk["range"]; tokenCount: number }>> {
  const lines = chunk.content.split(/\r?\n/);
  const pieces: Array<{ content: string; range: SourceChunk["range"]; tokenCount: number }> = [];
  let start = 0;

  while (start < lines.length) {
    let low = start + 1;
    let high = lines.length;
    let bestEnd = start;
    let bestTokenCount = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const content = lines.slice(start, mid).join("\n");
      const tokenCount = (await embeddingProvider.countTokens([sourceChunkEmbeddingInput({ ...chunk, content })]))[0] ?? 0;
      if (tokenCount <= tokenBudget) {
        bestEnd = mid;
        bestTokenCount = tokenCount;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (bestEnd === start) {
      pieces.push(
        ...await splitLongLineByTokenBudget(
          chunk,
          lines[start] ?? "",
          chunk.range.startLine + start,
          embeddingProvider,
          tokenBudget,
        ),
      );
      start += 1;
      continue;
    }

    const adjustedEnd = await preferredBoundaryEnd(lines, start, bestEnd, chunk, embeddingProvider, tokenBudget);
    const content = lines.slice(start, adjustedEnd).join("\n");
    const tokenCount = adjustedEnd === bestEnd
      ? bestTokenCount
      : (await embeddingProvider.countTokens([sourceChunkEmbeddingInput({ ...chunk, content })]))[0] ?? 0;
    pieces.push({
      content,
      range: {
        startLine: chunk.range.startLine + start,
        endLine: chunk.range.startLine + adjustedEnd - 1,
        startColumn: start === 0 ? chunk.range.startColumn : 0,
        endColumn: adjustedEnd === lines.length ? chunk.range.endColumn : lines[adjustedEnd - 1]?.length ?? 0,
      },
      tokenCount,
    });
    start = adjustedEnd;
  }

  return pieces;
}

async function preferredBoundaryEnd(
  lines: string[],
  start: number,
  bestEnd: number,
  chunk: SourceChunk,
  embeddingProvider: EmbeddingProvider,
  tokenBudget: number,
): Promise<number> {
  for (let end = bestEnd; end > start + 1; end -= 1) {
    if (!lineLooksLikeStatementBoundary(lines[end - 1] ?? "")) {
      continue;
    }
    const content = lines.slice(start, end).join("\n");
    const tokenCount = (await embeddingProvider.countTokens([sourceChunkEmbeddingInput({ ...chunk, content })]))[0] ?? 0;
    if (tokenCount <= tokenBudget) {
      return end;
    }
  }
  return bestEnd;
}

function lineLooksLikeStatementBoundary(line: string): boolean {
  return /(?:[;{}]|\],?|\),?)\s*$/.test(line);
}

async function splitLongLineByTokenBudget(
  chunk: SourceChunk,
  line: string,
  lineNumber: number,
  embeddingProvider: EmbeddingProvider,
  tokenBudget: number,
): Promise<Array<{ content: string; range: SourceChunk["range"]; tokenCount: number }>> {
  const pieces: Array<{ content: string; range: SourceChunk["range"]; tokenCount: number }> = [];
  let start = 0;
  while (start < line.length) {
    let low = start + 1;
    let high = line.length;
    let bestEnd = start + 1;
    let bestTokenCount = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const content = line.slice(start, mid);
      const tokenCount = (await embeddingProvider.countTokens([sourceChunkEmbeddingInput({ ...chunk, content })]))[0] ?? 0;
      if (tokenCount <= tokenBudget || mid === start + 1) {
        bestEnd = mid;
        bestTokenCount = tokenCount;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const content = line.slice(start, bestEnd);
    pieces.push({
      content,
      range: {
        startLine: lineNumber,
        endLine: lineNumber,
        startColumn: start,
        endColumn: bestEnd,
      },
      tokenCount: bestTokenCount,
    });
    start = bestEnd;
  }
  return pieces;
}

function withEmbeddingInput(
  chunk: SourceChunk,
  embeddingInput: NonNullable<SourceChunk["embeddingInput"]>,
): SourceChunk {
  return {
    ...chunk,
    embeddingInput: {
      ...chunk.embeddingInput,
      ...embeddingInput,
    },
  };
}

function sourceChunkEmbeddingInput(chunk: SourceChunk): string {
  return chunkEmbeddingInput({
    name: chunk.name,
    kind: chunk.kind,
    content: chunk.content,
    fact: {
      embeddingInputMode: chunk.embeddingInput?.mode,
      embeddingInputHeader: cleanHeader(chunk.embeddingInput?.header),
    },
  });
}

function embeddingHeader(
  chunk: SourceChunk,
  context: {
    inputMode: "minimal" | "semantic-header";
    repo: string;
    packageName?: string;
    relativePath: string;
    language: string;
    sourceRoot?: string;
  },
): NonNullable<SourceChunk["embeddingInput"]>["header"] {
  return {
    repo: context.repo,
    packageName: context.packageName,
    path: context.relativePath,
    qualifiedName: chunk.name,
    kind: chunk.kind,
    exported: /^export\s/.test(chunk.content.trim()),
    test: /\.(test|spec)\.[cm]?[jt]sx?$/.test(context.relativePath),
    sourceRoot: context.sourceRoot,
  };
}

function cleanHeader(
  header: Record<string, string | boolean | undefined> | undefined,
): Record<string, string | boolean> | undefined {
  if (!header) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(header).filter((entry): entry is [string, string | boolean] =>
      typeof entry[1] === "string" || typeof entry[1] === "boolean"
    ),
  );
}

function sourceRootForFile(
  workspace: DiscoveredWorkspace,
  repoName: string,
  relativePath: string,
): string | undefined {
  const repo = workspace.repos.find((candidate) => candidate.name === repoName);
  const file = repo?.files.find((candidate) => candidate.relativePath === relativePath);
  const pkg = repo?.packages.find((candidate) => candidate.name === file?.packageName);
  if (!pkg) {
    return undefined;
  }
  const root = pkg.sourceRoots.find((candidate) => file?.absolutePath.startsWith(`${candidate.replace(/\/$/, "")}/`));
  return root ? root.slice(repo!.path.length + 1) : undefined;
}

function cloneChunkFact(chunk: ChunkFact): ChunkFact {
  return {
    ...chunk,
    range: { ...chunk.range },
    calls: [...chunk.calls],
    embeddingInputMode: chunk.embeddingInputMode,
    embeddingInputHeader: chunk.embeddingInputHeader ? { ...chunk.embeddingInputHeader } : undefined,
    embedding: chunk.embedding ? [...chunk.embedding] : undefined,
  };
}

function cloneFacts<T>(facts: T[]): T[] {
  return facts.map((fact) => JSON.parse(JSON.stringify(fact)) as T);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex]!);
      }
    }),
  );
  return results;
}
