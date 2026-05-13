import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createEdgeId, createStableId } from "../core/ids.js";
import { LadybugGraphStore } from "../graph/ladybug-store.js";
import {
  schemaVersion,
  type CodeEdge,
  type CodeNode,
  type IndexManifest,
} from "../schema/schemas.js";
import { ingestScipIndex } from "../scip/ingest.js";
import { runScipTypescript } from "../scip/runner.js";
import { chunkSourceFile } from "../treesitter/chunker.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
} from "../vectors/embedding.js";
import { discoverWorkspace, type DiscoveredFile } from "../workspace/discovery.js";

export interface IndexWorkspaceInput {
  workspaceRoot: string;
  repoPaths: string[];
  indexPath: string;
  embeddingProvider?: EmbeddingProvider;
  embeddingProviderName?: string;
  embeddingModel?: string;
  includeIgnored?: boolean;
  workspaceManifestPath?: string;
}

interface MutableGraph {
  nodes: Map<string, CodeNode>;
  edges: Map<string, CodeEdge>;
  chunks: Map<string, CodeNode & { content: string; embedding: number[] }>;
}

const youngLockAgeMs = 30_000;

export async function indexWorkspace(input: IndexWorkspaceInput): Promise<IndexManifest> {
  await mkdir(input.indexPath, { recursive: true });
  const releaseWriteLock = await acquireIndexWriteLock(input.indexPath);
  try {
    return await buildIndexWorkspace(input);
  } finally {
    await releaseWriteLock();
  }
}

async function buildIndexWorkspace(input: IndexWorkspaceInput): Promise<IndexManifest> {
  const embeddingProvider =
    input.embeddingProvider ??
    (await createEmbeddingProvider({
      provider: input.embeddingProviderName,
      model: input.embeddingModel,
      indexPath: input.indexPath,
    }));
  const workspace = await discoverWorkspace({
    workspaceRoot: input.workspaceRoot,
    repoPaths: input.repoPaths,
    includeIgnored: input.includeIgnored,
    workspaceManifestPath: input.workspaceManifestPath,
  });
  const graph: MutableGraph = {
    nodes: new Map(),
    edges: new Map(),
    chunks: new Map(),
  };
  const health: IndexManifest["health"] = [];
  const workspaceNode = addNode(graph, {
    id: createStableId({
      kind: "workspace",
      workspace: workspace.workspaceName,
      repo: "workspace",
      commit: "no-git",
      relativePath: ".",
      suffix: "root",
    }),
    kind: "Workspace",
    workspace: workspace.workspaceName,
    repo: "workspace",
    name: workspace.workspaceName,
    metadata: { workspaceRoot: workspace.workspaceRoot },
  });

  for (const repo of workspace.repos) {
    const repoNode = addNode(graph, {
      id: createStableId({
        kind: "repo",
        workspace: workspace.workspaceName,
        repo: repo.name,
        commit: repo.commit,
        relativePath: repo.relativePath,
        suffix: "repo",
      }),
      kind: "Repo",
      workspace: workspace.workspaceName,
      repo: repo.name,
      name: repo.name,
      metadata: { path: repo.path, packageManager: repo.packageManager },
    });
    addEdge(graph, "CONTAINS", workspaceNode.id, repoNode.id, workspace.workspaceName, repo.name);

    const packageNodes = new Map<string, CodeNode>();
    for (const pkg of repo.packages) {
      const packageNode = addNode(graph, {
        id: createStableId({
          kind: "package",
          workspace: workspace.workspaceName,
          repo: repo.name,
          commit: repo.commit,
          relativePath: pkg.relativePath,
          suffix: pkg.name,
        }),
        kind: "Package",
        workspace: workspace.workspaceName,
        repo: repo.name,
        packageName: pkg.name,
        name: pkg.name,
        metadata: {
          path: pkg.path,
          exports: pkg.exports,
          dependencies: pkg.dependencies,
        },
      });
      packageNodes.set(pkg.name, packageNode);
      addEdge(graph, "CONTAINS", repoNode.id, packageNode.id, workspace.workspaceName, repo.name);
    }

    for (const pkg of repo.packages) {
      const fromPackage = packageNodes.get(pkg.name);
      if (!fromPackage) continue;
      for (const dependencyName of Object.keys(pkg.dependencies)) {
        const targetPackage = packageNodes.get(dependencyName);
        if (targetPackage) {
          addEdge(graph, "DEPENDS_ON", fromPackage.id, targetPackage.id, workspace.workspaceName, repo.name);
        }
      }
    }

    const fileNodes = new Map<string, CodeNode>();
    const symbolNodesByName = new Map<string, CodeNode[]>();
    const fileChunks = new Map<string, Array<CodeNode & { sourceCalls: string[] }>>();

    for (const file of repo.files) {
      const fileNode = addFileNode(graph, workspace.workspaceName, repo, file, packageNodes);
      fileNodes.set(file.relativePath, fileNode);
      const content = await readFile(file.absolutePath, "utf8");
      const chunks = chunkSourceFile({ relativePath: file.relativePath, content });
      for (const chunk of chunks) {
        const symbolNode = addNode(graph, {
          id: createStableId({
            kind: chunk.kind === "Test" ? "test" : "symbol",
            workspace: workspace.workspaceName,
            repo: repo.name,
            commit: repo.commit,
            relativePath: file.relativePath,
            suffix: `${chunk.name}-${chunk.idSuffix}`,
          }),
          kind: chunk.kind,
          workspace: workspace.workspaceName,
          repo: repo.name,
          packageName: file.packageName,
          file: file.relativePath,
          name: chunk.name,
          language: file.language,
          range: chunk.range,
          textHash: chunk.contentHash,
          metadata: {
            absolutePath: file.absolutePath,
            fileKind: fileKindForPath(file.relativePath),
            symbolKind: chunk.kind,
          },
        });
        const chunkNode = addNode(graph, {
          id: createStableId({
            kind: "chunk",
            workspace: workspace.workspaceName,
            repo: repo.name,
            commit: repo.commit,
            relativePath: file.relativePath,
            suffix: chunk.idSuffix,
          }),
          kind: "Chunk",
          workspace: workspace.workspaceName,
          repo: repo.name,
          packageName: file.packageName,
          file: file.relativePath,
          name: chunk.name,
          language: file.language,
          range: chunk.range,
          textHash: chunk.contentHash,
          metadata: {
            absolutePath: file.absolutePath,
            fileKind: fileKindForPath(file.relativePath),
            symbolKind: chunk.kind,
            symbolId: symbolNode.id,
            embeddingModel: embeddingProvider.model,
            embeddingProvider: embeddingProvider.provider,
          },
        }) as CodeNode & { content: string; embedding: number[] };
        chunkNode.content = chunk.content;
        chunkNode.embedding = [];
        graph.chunks.set(chunkNode.id, chunkNode);
        addEdge(graph, "DEFINES", fileNode.id, symbolNode.id, workspace.workspaceName, repo.name);
        addEdge(graph, "HAS_CHUNK", fileNode.id, chunkNode.id, workspace.workspaceName, repo.name);
        addEdge(graph, "MENTIONS", chunkNode.id, symbolNode.id, workspace.workspaceName, repo.name);
        if (!symbolNodesByName.has(chunk.name)) {
          symbolNodesByName.set(chunk.name, []);
        }
        symbolNodesByName.get(chunk.name)?.push(symbolNode);
        const existingChunks = fileChunks.get(file.relativePath) ?? [];
        existingChunks.push({ ...chunkNode, sourceCalls: chunk.calls });
        fileChunks.set(file.relativePath, existingChunks);
      }
    }

    for (const chunks of fileChunks.values()) {
      for (const chunk of chunks) {
        for (const callName of chunk.sourceCalls) {
          for (const target of symbolNodesByName.get(callName) ?? []) {
            addEdge(graph, "CALLS", chunk.id, target.id, workspace.workspaceName, repo.name);
            const sourceSymbolId = String(chunk.metadata.symbolId ?? "");
            if (sourceSymbolId && sourceSymbolId !== target.id) {
              addEdge(graph, "CALLS", sourceSymbolId, target.id, workspace.workspaceName, repo.name);
            }
          }
        }
      }
    }

    if (repo.files.length <= 100) {
      addFallbackReferenceEdges(graph, symbolNodesByName, workspace.workspaceName, repo.name);
    } else {
      health.push({
        name: `tree-sitter-reference-fallback:${repo.name}`,
        status: "warn",
        message: "Skipped quadratic fallback reference scan for large repo; SCIP references remain canonical",
        details: { files: repo.files.length },
      });
    }

    const scipOutputPath = join(input.indexPath, "scip", `${repo.name}.scip`);
    const scipRun = await runScipTypescript({
      repoPath: repo.path,
      outputPath: scipOutputPath,
      inferTsconfig: true,
    });
    if (scipRun.ok) {
      const facts = await ingestScipIndex(scipOutputPath);
      const scipSymbolNodes = new Map<string, CodeNode>();
      for (const definition of facts.definitions) {
        const fileNode = fileNodes.get(definition.relativePath);
        const symbolNode = addNode(graph, {
          id: createStableId({
            kind: "symbol",
            workspace: workspace.workspaceName,
            repo: repo.name,
            commit: repo.commit,
            relativePath: definition.relativePath,
            suffix: `scip-${definition.name}-${hashShort(definition.symbol)}`,
          }),
          kind: "Symbol",
          workspace: workspace.workspaceName,
          repo: repo.name,
          file: definition.relativePath,
          name: definition.name,
          range: definition.range,
          metadata: {
            source: "scip-typescript",
            scipSymbol: definition.symbol,
            documentation: definition.documentation,
            fileKind: fileKindForPath(definition.relativePath),
            symbolKind: "Symbol",
          },
        });
        scipSymbolNodes.set(definition.symbol, symbolNode);
        if (fileNode) {
          addEdge(graph, "DEFINES", fileNode.id, symbolNode.id, workspace.workspaceName, repo.name);
        }
        if (definition.range) {
          for (const chunk of fileChunks.get(definition.relativePath) ?? []) {
            if (!chunk.range) continue;
            if (rangesOverlap(chunk.range, definition.range)) {
              addEdge(graph, "MENTIONS", chunk.id, symbolNode.id, workspace.workspaceName, repo.name);
            }
          }
        }
      }
      for (const reference of facts.references) {
        const fileNode = fileNodes.get(reference.relativePath);
        const symbolNode = scipSymbolNodes.get(reference.symbol);
        if (fileNode && symbolNode) {
          addEdge(graph, "REFERENCES", fileNode.id, symbolNode.id, workspace.workspaceName, repo.name);
        }
        if (symbolNode) {
          const containingChunk = findContainingChunk(
            fileChunks.get(reference.relativePath) ?? [],
            reference.range,
          );
          if (containingChunk) {
            addEdge(graph, "REFERENCES", containingChunk.id, symbolNode.id, workspace.workspaceName, repo.name);
            if (containingChunk.kind === "Test") {
              addEdge(graph, "TESTS", containingChunk.id, symbolNode.id, workspace.workspaceName, repo.name);
            }
          }
        }
      }
      health.push({
        name: `scip:${repo.name}`,
        status: "pass",
        message: `SCIP indexed ${facts.definitions.length} definitions and ${facts.references.length} references`,
        details: { outputPath: scipOutputPath },
      });
    } else {
      health.push({
        name: `scip:${repo.name}`,
        status: "warn",
        message: "SCIP indexing failed; Tree-sitter fallback graph was still written",
        details: {
          outputPath: scipOutputPath,
          exitCode: scipRun.exitCode,
          stderr: scipRun.stderr,
        },
      });
    }
  }

  await embedGraphChunks(graph, embeddingProvider);
  const manifest: IndexManifest = {
    schemaVersion,
    workspace: workspace.workspaceName,
    generatedAt: new Date().toISOString(),
    indexPath: input.indexPath,
    repos: workspace.repos.map((repo) => ({
      name: repo.name,
      path: repo.path,
      commit: repo.commit,
      packages: repo.packages.length,
      files: repo.files.length,
    })),
    stats: {
      nodes: graph.nodes.size,
      edges: graph.edges.size,
      chunks: graph.chunks.size,
    },
    embedding: {
      provider: embeddingProvider.provider,
      model: embeddingProvider.model,
      dimension: embeddingProvider.dimension,
    },
    health,
  };
  const store = new LadybugGraphStore(input.indexPath);
  const generation = await store.rebuild({
    nodes: [...graph.nodes.values()],
    edges: [...graph.edges.values()],
    chunks: [...graph.chunks.values()],
    embeddingDimension: embeddingProvider.dimension,
  });
  await writeJsonAtomically(join(generation.generationPath, "manifest.json"), manifest);
  await writeJsonAtomically(join(generation.generationPath, "workspace.json"), workspace);
  await store.publishGeneration(generation.generationId);
  await writeJsonAtomically(join(input.indexPath, "manifest.json"), manifest);
  await writeJsonAtomically(join(input.indexPath, "workspace.json"), workspace);
  return manifest;
}

async function embedGraphChunks(
  graph: MutableGraph,
  embeddingProvider: EmbeddingProvider,
): Promise<void> {
  const chunks = [...graph.chunks.values()].sort((left, right) => left.id.localeCompare(right.id));
  for (const batch of chunkArray(chunks, 16)) {
    const embeddings = await embeddingProvider.embedBatch(
      batch.map((chunk) => `${chunk.name}\n${chunk.content}`),
    );
    batch.forEach((chunk, index) => {
      chunk.embedding = embeddings[index] ?? [];
    });
  }
}

function hashShort(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function rangesOverlap(
  left: { startLine: number; endLine: number },
  right: { startLine: number; endLine: number },
): boolean {
  return left.startLine <= right.endLine && right.startLine <= left.endLine;
}

function findContainingChunk<T extends { range?: { startLine: number; endLine: number } }>(
  chunks: T[],
  range: { startLine: number; endLine: number },
): T | undefined {
  return chunks
    .filter((chunk) => chunk.range && chunk.range.startLine <= range.startLine && chunk.range.endLine >= range.endLine)
    .sort((left, right) => {
      const leftSize = (left.range?.endLine ?? 0) - (left.range?.startLine ?? 0);
      const rightSize = (right.range?.endLine ?? 0) - (right.range?.startLine ?? 0);
      return leftSize - rightSize;
    })[0];
}

function addFallbackReferenceEdges(
  graph: MutableGraph,
  symbolNodesByName: Map<string, CodeNode[]>,
  workspaceName: string,
  repoName: string,
): void {
  for (const chunk of graph.chunks.values()) {
    if (chunk.repo !== repoName || !chunk.file) continue;
    for (const [symbolName, symbols] of symbolNodesByName) {
      if (!chunk.content.includes(symbolName)) continue;
      for (const symbol of symbols) {
        if (symbol.file !== chunk.file) continue;
        if (String(chunk.metadata.symbolId) === symbol.id) continue;
        addEdge(
          graph,
          chunk.kind === "Test" ? "TESTS" : "REFERENCES",
          chunk.id,
          symbol.id,
          workspaceName,
          repoName,
        );
      }
    }
  }
}

function addFileNode(
  graph: MutableGraph,
  workspaceName: string,
  repo: { name: string; commit: string },
  file: DiscoveredFile,
  packageNodes: Map<string, CodeNode>,
): CodeNode {
  const fileNode = addNode(graph, {
    id: createStableId({
      kind: "file",
      workspace: workspaceName,
      repo: repo.name,
      commit: repo.commit,
      relativePath: file.relativePath,
      suffix: "file",
    }),
    kind: "File",
    workspace: workspaceName,
    repo: repo.name,
    packageName: file.packageName,
    file: file.relativePath,
    name: file.relativePath,
    language: file.language,
    metadata: { absolutePath: file.absolutePath, fileKind: fileKindForPath(file.relativePath) },
  });
  const packageNode = file.packageName ? packageNodes.get(file.packageName) : undefined;
  if (packageNode) {
    addEdge(graph, "CONTAINS", packageNode.id, fileNode.id, workspaceName, repo.name);
  }
  return fileNode;
}

function addNode(graph: MutableGraph, node: Omit<CodeNode, "schemaVersion">): CodeNode {
  const parsed: CodeNode = { schemaVersion, ...node };
  graph.nodes.set(parsed.id, parsed);
  return parsed;
}

function addEdge(
  graph: MutableGraph,
  kind: CodeEdge["kind"],
  fromId: string,
  toId: string,
  workspace: string,
  repo: string,
): void {
  const edge: CodeEdge = {
    schemaVersion,
    id: createEdgeId(kind, fromId, toId),
    kind,
    fromId,
    toId,
    workspace,
    repo,
    metadata: {},
  };
  graph.edges.set(edge.id, edge);
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function fileKindForPath(relativePath: string): string {
  return /(^|\/)(__tests__|tests?)\//.test(relativePath) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath)
    ? "test"
    : "source";
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tempPath, path);
}

async function acquireIndexWriteLock(indexPath: string): Promise<() => Promise<void>> {
  const lockPath = join(indexPath, ".index-write.lock");
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      await mkdir(lockPath);
      try {
        await writeJsonAtomically(join(lockPath, "owner.json"), {
          pid: process.pid,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        throw error;
      }
      return async () => {
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
      await recoverStaleLock(lockPath);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for index write lock at ${lockPath}`);
}

async function recoverStaleLock(lockPath: string): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as {
      pid?: unknown;
    };
    if (typeof owner.pid === "number" && processIsAlive(owner.pid)) {
      return;
    }
  } catch {
    if (await isYoungLock(lockPath)) {
      return;
    }
  }
  await rm(lockPath, { recursive: true, force: true });
}

async function isYoungLock(lockPath: string): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath);
    return Date.now() - lockStat.mtimeMs < youngLockAgeMs;
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
