import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { writeJsonAtomically } from "../core/index-artifacts.js";
import type { IndexProgressReporter, IndexProgressUpdate } from "../core/progress.js";
import { buildIndexDiagnostics, writeIndexDiagnostics } from "../diagnostics/index-diagnostics.js";
import { createEdgeId, createStableId } from "../core/ids.js";
import { LadybugGraphStore } from "../graph/ladybug-store.js";
import {
  schemaVersion,
  type CodeEdge,
  type CodeNode,
  type IncrementalStats,
  type IndexManifest,
} from "../schema/schemas.js";
import { scipFactsSchemaVersion, writeScipFacts, type RepoScipFacts } from "../scip/fact-cache.js";
import { ingestScipIndex } from "../scip/ingest.js";
import { runScipTypescript } from "../scip/runner.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
} from "../vectors/embedding.js";
import { discoverWorkspace, type DiscoveredFile } from "../workspace/discovery.js";
import { embedGraphChunks, type EmbeddableChunkNode } from "./chunk-embeddings.js";
import { applyFrameworkGraphFacts } from "./framework-graph.js";
import {
  factsSchemaVersion,
  readActiveIndexFacts,
  writeIndexFacts,
  type FileFact,
  type IndexFacts,
} from "./fact-cache.js";
import { prepareFileFacts } from "./file-facts.js";
import { applyResolvedModuleGraphFacts } from "./module-resolution-graph.js";
import {
  buildRepoResolvedModuleFacts,
  resolvedFactsSchemaVersion,
  writeResolvedModuleFacts,
  type RepoResolvedModuleFacts,
} from "./module-resolution.js";
import { applyRelationshipGraphFacts } from "./relationship-graph.js";
import { addTreeSitterFallbackRelationships, applyScipGraphFacts } from "./scip-fusion.js";
import { applyTestLinkingGraphFacts } from "./test-linking.js";
import { fingerprintKey, type IncrementalPlan } from "./update-planner.js";

export interface IndexWorkspaceInput {
  workspaceRoot: string;
  repoPaths: string[];
  indexPath: string;
  embeddingProvider?: EmbeddingProvider;
  embeddingProviderName?: string;
  embeddingModel?: string;
  includeIgnored?: boolean;
  workspaceManifestPath?: string;
  progress?: IndexProgressReporter;
}

interface MutableGraph {
  nodes: Map<string, CodeNode>;
  edges: Map<string, CodeEdge>;
  chunks: Map<string, GraphChunkNode>;
}

type GraphChunkNode = EmbeddableChunkNode;

interface BuildIndexWorkspaceOptions {
  mode: "index" | "update";
  previousFacts?: IndexFacts;
}

const youngLockAgeMs = 30_000;

export async function indexWorkspace(input: IndexWorkspaceInput): Promise<IndexManifest> {
  await mkdir(input.indexPath, { recursive: true });
  const releaseWriteLock = await acquireIndexWriteLock(input.indexPath);
  try {
    return await buildIndexWorkspace(input, { mode: "index" });
  } catch (error) {
    await reportProgress(input.progress, {
      status: "failed",
      phase: "failed",
      message: "Indexing failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await releaseWriteLock();
  }
}

export async function updateWorkspace(input: IndexWorkspaceInput): Promise<IndexManifest> {
  await mkdir(input.indexPath, { recursive: true });
  const releaseWriteLock = await acquireIndexWriteLock(input.indexPath);
  try {
    return await buildIndexWorkspace(input, {
      mode: "update",
      previousFacts: await readActiveIndexFacts(input.indexPath),
    });
  } catch (error) {
    await reportProgress(input.progress, {
      status: "failed",
      phase: "failed",
      message: "Index update failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await releaseWriteLock();
  }
}

async function buildIndexWorkspace(
  input: IndexWorkspaceInput,
  options: BuildIndexWorkspaceOptions,
): Promise<IndexManifest> {
  await reportProgress(input.progress, {
    phase: "starting",
    message: `${options.mode === "index" ? "Starting index" : "Starting update"}`,
  });
  const embeddingProvider =
    input.embeddingProvider ??
    (await createEmbeddingProvider({
      provider: input.embeddingProviderName,
      model: input.embeddingModel,
      indexPath: input.indexPath,
    }));
  await reportProgress(input.progress, {
    phase: "discovering",
    message: "Discovering repositories and source files",
  });
  const workspace = await discoverWorkspace({
    workspaceRoot: input.workspaceRoot,
    repoPaths: input.repoPaths,
    includeIgnored: input.includeIgnored,
    workspaceManifestPath: input.workspaceManifestPath,
  });
  const discoveredFileCount = workspace.repos.reduce((sum, repo) => sum + repo.files.length, 0);
  await reportProgress(input.progress, {
    phase: "planning",
    message: "Planning index facts",
    counters: {
      filesDiscovered: discoveredFileCount,
    },
  });
  const fileFactPlan = await prepareFileFacts({
    workspace,
    previousFacts: options.previousFacts,
    embeddingProvider,
    mode: options.mode,
    includeIgnored: input.includeIgnored,
    workspaceManifestPath: input.workspaceManifestPath,
  });
  await reportProgress(input.progress, {
    phase: "facts",
    message: "Building graph facts",
    counters: {
      filesParsed: fileFactPlan.fileFactsByKey.size,
    },
  });
  const graph: MutableGraph = {
    nodes: new Map(),
    edges: new Map(),
    chunks: new Map(),
  };
  const health: IndexManifest["health"] = [];
  const scipFactsByRepo: RepoScipFacts[] = [];
  const resolvedFactsByRepo: RepoResolvedModuleFacts[] = [];
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
    metadata: { workspaceRoot: workspace.workspaceRoot, origin: "workspace-discovery" },
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
      metadata: {
        path: repo.path,
        packageManager: repo.packageManager,
        ownerRepo: repo.name,
        origin: "workspace-discovery",
      },
    });
    addEdge(graph, "CONTAINS", workspaceNode.id, repoNode.id, workspace.workspaceName, repo.name, {
      ownerRepo: repo.name,
      origin: "workspace-discovery",
    });

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
          ownerRepo: repo.name,
          origin: "workspace-discovery",
        },
      });
      packageNodes.set(pkg.name, packageNode);
      addEdge(graph, "CONTAINS", repoNode.id, packageNode.id, workspace.workspaceName, repo.name, {
        ownerRepo: repo.name,
        origin: "workspace-discovery",
      });
    }

    for (const pkg of repo.packages) {
      const fromPackage = packageNodes.get(pkg.name);
      if (!fromPackage) continue;
      for (const dependencyName of Object.keys(pkg.dependencies)) {
        const targetPackage = packageNodes.get(dependencyName);
        if (targetPackage) {
          addEdge(graph, "DEPENDS_ON", fromPackage.id, targetPackage.id, workspace.workspaceName, repo.name, {
            ownerRepo: repo.name,
            origin: "package-json",
          });
        }
      }
    }

    const fileNodes = new Map<string, CodeNode>();
    const symbolNodesByName = new Map<string, CodeNode[]>();
    const astSymbolsByFile = new Map<string, CodeNode[]>();
    const fileFactsByRelativePath = new Map<string, FileFact>();
    const fileChunks = new Map<string, Array<CodeNode & { sourceCalls: string[] }>>();

    for (const file of repo.files) {
      const fileNode = addFileNode(graph, workspace.workspaceName, repo, file, packageNodes);
      fileNodes.set(file.relativePath, fileNode);
      const fileFact = fileFactPlan.fileFactsByKey.get(fingerprintKey({ repo: repo.name, relativePath: file.relativePath }));
      if (!fileFact) {
        continue;
      }
      fileFactsByRelativePath.set(file.relativePath, fileFact);
      addAstBoundaryNodes(graph, workspace.workspaceName, repo, file, fileNode, fileFact);
      const chunks = fileFact.chunks;
      for (const chunk of chunks) {
        const declaration = declarationForChunk(fileFact, chunk.idSuffix);
        const qualifiedName = declaration?.qualifiedName;
        const identityName = qualifiedName ?? chunk.name;
        const symbolNode = addNode(graph, {
          id: createStableId({
            kind: chunk.kind === "Test" ? "test" : "symbol",
            workspace: workspace.workspaceName,
            repo: repo.name,
            commit: repo.commit,
            relativePath: file.relativePath,
            suffix: `${identityName}-${chunk.idSuffix}`,
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
            displayName: chunk.name,
            qualifiedName,
            declarationKind: declaration?.kind,
            ownerRepo: repo.name,
            ownerFile: file.relativePath,
            origin: "tree-sitter",
            derivedFrom: chunk.contentHash,
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
            displayName: chunk.name,
            qualifiedName,
            declarationKind: declaration?.kind,
            embeddingModel: embeddingProvider.model,
            embeddingProvider: embeddingProvider.provider,
            embeddingInputHash: chunk.embeddingInputHash,
            ownerRepo: repo.name,
            ownerFile: file.relativePath,
            origin: "tree-sitter",
            derivedFrom: chunk.contentHash,
          },
        }) as GraphChunkNode;
        chunkNode.content = chunk.content;
        chunkNode.embedding = chunk.embedding ?? [];
        chunkNode.embeddingInputHash = chunk.embeddingInputHash;
        chunkNode.fact = chunk;
        graph.chunks.set(chunkNode.id, chunkNode);
        const ownerMetadata = ownerFileMetadata(repo.name, file.relativePath, "tree-sitter");
        addEdge(graph, "DEFINES", fileNode.id, symbolNode.id, workspace.workspaceName, repo.name, ownerMetadata);
        addEdge(graph, "HAS_CHUNK", fileNode.id, chunkNode.id, workspace.workspaceName, repo.name, ownerMetadata);
        addEdge(graph, "MENTIONS", chunkNode.id, symbolNode.id, workspace.workspaceName, repo.name, ownerMetadata);
        if (!symbolNodesByName.has(chunk.name)) {
          symbolNodesByName.set(chunk.name, []);
        }
        symbolNodesByName.get(chunk.name)?.push(symbolNode);
        const fileSymbols = astSymbolsByFile.get(file.relativePath) ?? [];
        fileSymbols.push(symbolNode);
        astSymbolsByFile.set(file.relativePath, fileSymbols);
        const existingChunks = fileChunks.get(file.relativePath) ?? [];
        existingChunks.push({ ...chunkNode, sourceCalls: chunk.calls });
        fileChunks.set(file.relativePath, existingChunks);
      }
      addDeclarationSymbolNodes({
        graph,
        workspaceName: workspace.workspaceName,
        repo,
        file,
        fileNode,
        fileFact,
        symbolNodesByName,
        astSymbolsByFile,
        fileChunks,
      });
    }

    await reportProgress(input.progress, {
      phase: "scip",
      message: `Running SCIP for ${repo.name}`,
    });
    const scipOutputPath = join(input.indexPath, "scip", `${repo.name}.scip`);
    const scipRun = await runScipTypescript({
      repoPath: repo.path,
      outputPath: scipOutputPath,
      inferTsconfig: true,
    });
    let scipSymbolNodes = new Map<string, CodeNode>();
    if (scipRun.ok) {
      const facts = await ingestScipIndex(scipOutputPath);
      scipFactsByRepo.push({
        name: repo.name,
        outputPath: scipOutputPath,
        ...facts,
      });
      const fusion = applyScipGraphFacts({
        facts,
        workspaceName: workspace.workspaceName,
        repo,
        fileNodes,
        fileChunks,
        astSymbolsByFile,
        fileFactsByRelativePath,
        addNode: (node) => addNode(graph, node),
        addEdge: (kind, fromId, toId, edgeWorkspace, edgeRepo, metadata) =>
          addEdge(graph, kind, fromId, toId, edgeWorkspace, edgeRepo, metadata),
      });
      scipSymbolNodes = fusion.scipSymbolNodes;
      health.push({
        name: `scip:${repo.name}`,
        status: "pass",
        message: `SCIP indexed ${facts.definitions.length} definitions, ${facts.references.length} references, and ${facts.occurrences.length} occurrences`,
        details: { outputPath: scipOutputPath },
      });
    } else {
      health.push(
        ...addTreeSitterFallbackRelationships({
          graph,
          fileChunks,
          symbolNodesByName,
          workspaceName: workspace.workspaceName,
          repoName: repo.name,
          fileCount: repo.files.length,
          addEdge: (kind, fromId, toId, edgeWorkspace, edgeRepo, metadata) =>
            addEdge(graph, kind, fromId, toId, edgeWorkspace, edgeRepo, metadata),
        }),
      );
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
    const resolvedModuleFacts = await buildRepoResolvedModuleFacts({
      repo,
      fileFactsByRelativePath,
      astSymbolsByFile,
      scipSymbolNodes,
    });
    resolvedFactsByRepo.push(resolvedModuleFacts);
    applyResolvedModuleGraphFacts({
      workspaceName: workspace.workspaceName,
      repo,
      facts: resolvedModuleFacts,
      fileNodes,
      packageNodes,
      fileChunks,
      astSymbolsByFile,
      scipSymbolNodes,
      fileFactsByRelativePath,
      addEdge: (kind, fromId, toId, edgeWorkspace, edgeRepo, metadata) =>
        addEdge(graph, kind, fromId, toId, edgeWorkspace, edgeRepo, metadata),
    });
    applyFrameworkGraphFacts({
      workspaceName: workspace.workspaceName,
      repo,
      fileNodes,
      astSymbolsByFile,
      addEdge: (kind, fromId, toId, edgeWorkspace, edgeRepo, metadata) =>
        addEdge(graph, kind, fromId, toId, edgeWorkspace, edgeRepo, metadata),
    });
    applyRelationshipGraphFacts({
      workspaceName: workspace.workspaceName,
      repo,
      nodes: graph.nodes,
      edges: graph.edges,
      fileNodes,
      astSymbolsByFile,
      fileFactsByRelativePath,
      addNode: (node) => addNode(graph, node),
      addEdge: (kind, fromId, toId, edgeWorkspace, edgeRepo, metadata) =>
        addEdge(graph, kind, fromId, toId, edgeWorkspace, edgeRepo, metadata),
    });
    applyTestLinkingGraphFacts({
      workspaceName: workspace.workspaceName,
      repo,
      nodes: graph.nodes,
      edges: graph.edges,
      fileNodes,
      astSymbolsByFile,
      fileFactsByRelativePath,
      addEdge: (kind, fromId, toId, edgeWorkspace, edgeRepo, metadata) =>
        addEdge(graph, kind, fromId, toId, edgeWorkspace, edgeRepo, metadata),
    });
    promoteFinalCallEvidenceEdges(graph, workspace.workspaceName, repo.name);
  }

  await reportProgress(input.progress, {
    phase: "embeddings",
    message: "Embedding chunks",
    counters: {
      chunksTotal: graph.chunks.size,
    },
  });
  const embedStats = await embedGraphChunks(graph.chunks, embeddingProvider, fileFactPlan.embeddingCache);
  await reportProgress(input.progress, {
    phase: "embeddings",
    message: "Embedded chunks",
    counters: {
      chunksEmbedded: embedStats.embedded,
      chunksReused: embedStats.reused,
    },
  });
  const generatedAt = new Date().toISOString();
  const incrementalStats = createIncrementalStats({
    mode: options.mode,
    plan: fileFactPlan.incrementalPlan,
    embeddedChunks: embedStats.embedded,
    reusedChunks: embedStats.reused,
    previousFacts: options.previousFacts,
    configHash: fileFactPlan.configHash,
  });
  const manifest: IndexManifest = {
    schemaVersion,
    workspace: workspace.workspaceName,
    generatedAt,
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
    incremental: incrementalStats,
    health,
  };
  const facts: IndexFacts = {
    schemaVersion,
    factsSchemaVersion,
    workspace: workspace.workspaceName,
    generatedAt,
    configHash: fileFactPlan.configHash,
    embedding: manifest.embedding,
    files: [...fileFactPlan.fileFactsByKey.values()].sort((left, right) =>
      fingerprintKey(left.fingerprint).localeCompare(fingerprintKey(right.fingerprint)),
    ),
  };
  await reportProgress(input.progress, {
    phase: "graph",
    message: "Writing graph generation",
    counters: {
      nodesWritten: graph.nodes.size,
      edgesWritten: graph.edges.size,
      chunksTotal: graph.chunks.size,
    },
  });
  const store = new LadybugGraphStore(input.indexPath);
  const generation = await store.rebuild({
    nodes: [...graph.nodes.values()],
    edges: [...graph.edges.values()],
    chunks: [...graph.chunks.values()],
    embeddingDimension: embeddingProvider.dimension,
  });
  await reportProgress(input.progress, {
    phase: "publishing",
    message: "Publishing active generation",
    counters: {
      nodesWritten: graph.nodes.size,
      edgesWritten: graph.edges.size,
      chunksTotal: graph.chunks.size,
    },
  });
  await writeJsonAtomically(join(generation.generationPath, "manifest.json"), manifest);
  await writeJsonAtomically(join(generation.generationPath, "workspace.json"), workspace);
  await writeIndexFacts(generation.generationPath, facts);
  await writeScipFacts(generation.generationPath, {
    schemaVersion,
    factsSchemaVersion: scipFactsSchemaVersion,
    workspace: workspace.workspaceName,
    generatedAt,
    repos: scipFactsByRepo,
  });
  await writeResolvedModuleFacts(generation.generationPath, {
    schemaVersion,
    factsSchemaVersion: resolvedFactsSchemaVersion,
    workspace: workspace.workspaceName,
    generatedAt,
    repos: resolvedFactsByRepo,
  });
  await writeIndexDiagnostics(
    generation.generationPath,
    buildIndexDiagnostics({
      workspace,
      generatedAt,
      fileFactsByKey: fileFactPlan.fileFactsByKey,
      scipFactsByRepo,
      nodes: graph.nodes.values(),
      edges: graph.edges.values(),
    }),
  );
  await store.publishGeneration(generation.generationId);
  await writeJsonAtomically(join(input.indexPath, "manifest.json"), manifest);
  await writeJsonAtomically(join(input.indexPath, "workspace.json"), workspace);
  await reportProgress(input.progress, {
    status: "succeeded",
    phase: "succeeded",
    message: `${options.mode === "index" ? "Index" : "Update"} succeeded`,
    counters: {
      chunksTotal: graph.chunks.size,
      chunksEmbedded: embedStats.embedded,
      chunksReused: embedStats.reused,
      nodesWritten: graph.nodes.size,
      edgesWritten: graph.edges.size,
    },
  });
  return manifest;
}

async function reportProgress(
  reporter: IndexProgressReporter | undefined,
  update: IndexProgressUpdate,
): Promise<void> {
  if (!reporter) {
    return;
  }
  await reporter.report(update);
}

function addAstBoundaryNodes(
  graph: MutableGraph,
  workspaceName: string,
  repo: { name: string; commit: string },
  file: DiscoveredFile,
  fileNode: CodeNode,
  fileFact: FileFact,
): void {
  for (const importFact of fileFact.imports) {
    const importNode = addNode(graph, {
      id: createStableId({
        kind: "import",
        workspace: workspaceName,
        repo: repo.name,
        commit: repo.commit,
        relativePath: file.relativePath,
        suffix: importFact.idSuffix,
      }),
      kind: "Import",
      workspace: workspaceName,
      repo: repo.name,
      packageName: file.packageName,
      file: file.relativePath,
      name: importFact.localName ?? importFact.importedName ?? importFact.moduleSpecifier,
      language: file.language,
      range: importFact.range,
      textHash: importFact.contentHash,
      metadata: {
        absolutePath: file.absolutePath,
        fileKind: fileKindForPath(file.relativePath),
        symbolKind: "Import",
        moduleSpecifier: importFact.moduleSpecifier,
        importKind: importFact.importKind,
        importedName: importFact.importedName,
        localName: importFact.localName,
        isDefault: importFact.isDefault,
        isNamespace: importFact.isNamespace,
        ownerRepo: repo.name,
        ownerFile: file.relativePath,
        origin: "tree-sitter-import",
        derivedFrom: importFact.contentHash,
      },
    });
    addEdge(
      graph,
      "IMPORTS",
      fileNode.id,
      importNode.id,
      workspaceName,
      repo.name,
      ownerFileMetadata(repo.name, file.relativePath, "tree-sitter-import"),
    );
  }

  for (const exportFact of fileFact.exports) {
    const exportNode = addNode(graph, {
      id: createStableId({
        kind: "export",
        workspace: workspaceName,
        repo: repo.name,
        commit: repo.commit,
        relativePath: file.relativePath,
        suffix: exportFact.idSuffix,
      }),
      kind: "Export",
      workspace: workspaceName,
      repo: repo.name,
      packageName: file.packageName,
      file: file.relativePath,
      name: exportFact.exportedName,
      language: file.language,
      range: exportFact.range,
      textHash: exportFact.contentHash,
      metadata: {
        absolutePath: file.absolutePath,
        fileKind: fileKindForPath(file.relativePath),
        symbolKind: "Export",
        exportKind: exportFact.exportKind,
        exportedName: exportFact.exportedName,
        localName: exportFact.localName,
        moduleSpecifier: exportFact.moduleSpecifier,
        ownerRepo: repo.name,
        ownerFile: file.relativePath,
        origin: "tree-sitter-export",
        derivedFrom: exportFact.contentHash,
      },
    });
    addEdge(
      graph,
      "EXPORTS",
      fileNode.id,
      exportNode.id,
      workspaceName,
      repo.name,
      ownerFileMetadata(repo.name, file.relativePath, "tree-sitter-export"),
    );
  }
}

function declarationForChunk(fileFact: FileFact, chunkIdSuffix: string): FileFact["declarations"][number] | undefined {
  return fileFact.declarations.find((declaration) => declaration.containingChunkIdSuffix === chunkIdSuffix);
}

function addDeclarationSymbolNodes(input: {
  graph: MutableGraph;
  workspaceName: string;
  repo: { name: string; commit: string };
  file: DiscoveredFile;
  fileNode: CodeNode;
  fileFact: FileFact;
  symbolNodesByName: Map<string, CodeNode[]>;
  astSymbolsByFile: Map<string, CodeNode[]>;
  fileChunks: Map<string, Array<CodeNode & { sourceCalls: string[] }>>;
}): void {
  const chunkIds = new Set(input.fileFact.chunks.map((chunk) => chunk.idSuffix));
  for (const declaration of input.fileFact.declarations) {
    if (declaration.containingChunkIdSuffix && chunkIds.has(declaration.containingChunkIdSuffix)) {
      continue;
    }
    const symbolNode = addNode(input.graph, {
      id: createStableId({
        kind: "symbol",
        workspace: input.workspaceName,
        repo: input.repo.name,
        commit: input.repo.commit,
        relativePath: input.file.relativePath,
        suffix: `${declaration.qualifiedName}-${declaration.idSuffix}`,
      }),
      kind: nodeKindForDeclaration(declaration.kind),
      workspace: input.workspaceName,
      repo: input.repo.name,
      packageName: input.file.packageName,
      file: input.file.relativePath,
      name: declaration.name,
      language: input.file.language,
      range: declaration.range,
      textHash: declaration.contentHash,
      metadata: {
        absolutePath: input.file.absolutePath,
        fileKind: fileKindForPath(input.file.relativePath),
        symbolKind: nodeKindForDeclaration(declaration.kind),
        displayName: declaration.name,
        qualifiedName: declaration.qualifiedName,
        declarationKind: declaration.kind,
        exported: declaration.exported,
        defaultExport: declaration.defaultExport,
        decorators: declaration.decorators,
        parentName: declaration.parentName,
        ownerRepo: input.repo.name,
        ownerFile: input.file.relativePath,
        origin: "tree-sitter-declaration",
        derivedFrom: declaration.contentHash,
      },
    });
    const ownerMetadata = ownerFileMetadata(input.repo.name, input.file.relativePath, "tree-sitter-declaration");
    addEdge(input.graph, "DEFINES", input.fileNode.id, symbolNode.id, input.workspaceName, input.repo.name, ownerMetadata);
    for (const chunk of input.fileChunks.get(input.file.relativePath) ?? []) {
      if (chunk.range && rangesOverlap(chunk.range, declaration.range)) {
        addEdge(input.graph, "MENTIONS", chunk.id, symbolNode.id, input.workspaceName, input.repo.name, ownerMetadata);
      }
    }
    const symbolsByName = input.symbolNodesByName.get(declaration.name) ?? [];
    symbolsByName.push(symbolNode);
    input.symbolNodesByName.set(declaration.name, symbolsByName);
    const fileSymbols = input.astSymbolsByFile.get(input.file.relativePath) ?? [];
    fileSymbols.push(symbolNode);
    input.astSymbolsByFile.set(input.file.relativePath, fileSymbols);
  }
}

function nodeKindForDeclaration(kind: FileFact["declarations"][number]["kind"]): CodeNode["kind"] {
  switch (kind) {
    case "Function":
    case "VariableFunction":
    case "ClassMethod":
    case "ObjectMethod":
      return "Function";
    case "Class":
      return "Class";
    case "Interface":
      return "Interface";
    case "TypeAlias":
      return "TypeAlias";
    default:
      return "Symbol";
  }
}

function rangesOverlap(
  left: { startLine: number; endLine: number },
  right: { startLine: number; endLine: number },
): boolean {
  return left.startLine <= right.endLine && right.startLine <= left.endLine;
}

function createIncrementalStats(input: {
  mode: "index" | "update";
  plan: IncrementalPlan | undefined;
  embeddedChunks: number;
  reusedChunks: number;
  previousFacts: IndexFacts | undefined;
  configHash: string;
}): IncrementalStats | undefined {
  if (input.mode !== "update" || !input.plan) {
    return undefined;
  }
  const reason = !input.previousFacts
    ? "missing previous facts"
    : input.previousFacts.configHash !== input.configHash
      ? "config changed"
      : undefined;
  return {
    mode: input.plan.fullRebuild ? "full" : "incremental",
    reason,
    files: {
      added: input.plan.added.length,
      changed: input.plan.changed.length,
      deleted: input.plan.deleted.length,
      unchanged: input.plan.unchanged.length,
    },
    chunks: {
      reused: input.reusedChunks,
      embedded: input.embeddedChunks,
    },
  };
}

function mergeMetadata(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...current };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) {
      continue;
    }
    if (key === "evidenceSources") {
      merged.evidenceSources = mergeStringArrays(merged.evidenceSources, value);
    } else if (key === "relationshipTags") {
      merged.relationshipTags = mergeStringArrays(merged.relationshipTags, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function mergeEdgeMetadata(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const merged = mergeMetadata(current, next);
  merged.evidenceSources = mergeStringArrays(current.evidenceSources, next.evidenceSources ?? next.origin);
  if (current.roles || next.roles) {
    merged.roles = mergeStringArrays(current.roles, next.roles);
  }
  return merged;
}

function promoteFinalCallEvidenceEdges(graph: MutableGraph, workspaceName: string, repoName: string): void {
  const evidenceEdges = [...graph.edges.values()].filter((edge) =>
    (edge.kind === "REFERENCES" || edge.kind === "MENTIONS") &&
    metadataArrayIncludes(edge.metadata.roles, "Call") &&
    (metadataArrayIncludes(edge.metadata.evidenceSources, "tree-sitter-call") ||
      metadataArrayIncludes(edge.metadata.evidenceSources, "tree-sitter-member-call"))
  );
  for (const edge of evidenceEdges) {
    const fromNode = graph.nodes.get(edge.fromId);
    for (const sourceId of callEvidenceSourceIds(fromNode)) {
      if (sourceId === edge.toId) {
        continue;
      }
      const metadata = {
        ...edge.metadata,
        origin: "graph-call-evidence-promotion",
        source: "graph-call-evidence-promotion",
        evidenceSources: mergeStringArrays(edge.metadata.evidenceSources, "call-evidence-promotion"),
      };
      const edgeId = createEdgeId("CALLS", sourceId, edge.toId);
      const existing = graph.edges.get(edgeId);
      if (existing) {
        existing.metadata = mergeEdgeMetadata(existing.metadata, metadata);
        ensureEvidenceCallEdge(graph, sourceId, edge.toId, workspaceName, repoName, metadata);
        continue;
      }
      addEdge(graph, "CALLS", sourceId, edge.toId, workspaceName, repoName, metadata);
      ensureEvidenceCallEdge(graph, sourceId, edge.toId, workspaceName, repoName, metadata);
    }
  }
}

function callEvidenceSourceIds(node: CodeNode | undefined): string[] {
  if (!node) {
    return [];
  }
  const symbolId = typeof node.metadata.symbolId === "string" ? node.metadata.symbolId : undefined;
  return symbolId && symbolId !== node.id ? [node.id, symbolId] : [node.id];
}

function metadataArrayIncludes(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.includes(expected);
}

function mergeStringArrays(left: unknown, right: unknown): string[] {
  return [...new Set([...toStringArray(left), ...toStringArray(right)])].sort();
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }
  return typeof value === "string" && value.length > 0 ? [value] : [];
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
    metadata: {
      absolutePath: file.absolutePath,
      fileKind: fileKindForPath(file.relativePath),
      ownerRepo: repo.name,
      ownerFile: file.relativePath,
      origin: "workspace-discovery",
    },
  });
  const packageNode = file.packageName ? packageNodes.get(file.packageName) : undefined;
  if (packageNode) {
    addEdge(
      graph,
      "CONTAINS",
      packageNode.id,
      fileNode.id,
      workspaceName,
      repo.name,
      ownerFileMetadata(repo.name, file.relativePath, "workspace-discovery"),
    );
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
  metadata: Record<string, unknown> = { ownerRepo: repo, origin: "graph-builder" },
): void {
  if (kind === "REFERENCES" && fromId === toId) {
    return;
  }
  if (kind === "REFERENCES") {
    const fromNode = graph.nodes.get(fromId);
    const toNode = graph.nodes.get(toId);
    const fromQualifiedName = typeof fromNode?.metadata.qualifiedName === "string" ? fromNode.metadata.qualifiedName : undefined;
    const toQualifiedName = typeof toNode?.metadata.qualifiedName === "string" ? toNode.metadata.qualifiedName : undefined;
    if (
      fromNode?.file &&
      fromNode.file === toNode?.file &&
      ((fromNode.name && fromNode.name === toNode.name) ||
        (fromQualifiedName && fromQualifiedName === toQualifiedName))
    ) {
      return;
    }
  }
  const edge: CodeEdge = {
    schemaVersion,
    id: createEdgeId(kind, fromId, toId),
    kind,
    fromId,
    toId,
    workspace,
    repo,
    metadata,
  };
  const existing = graph.edges.get(edge.id);
  if (existing) {
    existing.metadata = mergeEdgeMetadata(existing.metadata, metadata);
    promoteCallEvidenceEdge(graph, kind, fromId, toId, workspace, repo, existing.metadata);
    return;
  }
  graph.edges.set(edge.id, edge);
  promoteCallEvidenceEdge(graph, kind, fromId, toId, workspace, repo, edge.metadata);
}

function promoteCallEvidenceEdge(
  graph: MutableGraph,
  kind: CodeEdge["kind"],
  fromId: string,
  toId: string,
  workspace: string,
  repo: string,
  metadata: Record<string, unknown>,
): void {
  if (
    kind !== "REFERENCES" && kind !== "MENTIONS" ||
    !metadataArrayIncludes(metadata.roles, "Call") ||
    (!metadataArrayIncludes(metadata.evidenceSources, "tree-sitter-call") &&
      !metadataArrayIncludes(metadata.evidenceSources, "tree-sitter-member-call"))
  ) {
    return;
  }
  const fromNode = graph.nodes.get(fromId);
  for (const sourceId of callEvidenceSourceIds(fromNode)) {
    if (sourceId === toId) {
      continue;
    }
    const callMetadata = {
      ...metadata,
      origin: "graph-call-evidence-promotion",
      source: "graph-call-evidence-promotion",
      evidenceSources: mergeStringArrays(metadata.evidenceSources, "call-evidence-promotion"),
    };
    addEdge(graph, "CALLS", sourceId, toId, workspace, repo, callMetadata);
    ensureEvidenceCallEdge(graph, sourceId, toId, workspace, repo, callMetadata);
  }
}

function ensureEvidenceCallEdge(
  graph: MutableGraph,
  fromId: string,
  toId: string,
  workspace: string,
  repo: string,
  metadata: Record<string, unknown>,
): void {
  if (
    !metadataArrayIncludes(metadata.evidenceSources, "tree-sitter-call") &&
    !metadataArrayIncludes(metadata.evidenceSources, "tree-sitter-member-call")
  ) {
    return;
  }
  const evidenceHash = createHash("sha256")
    .update(JSON.stringify({
      fromId,
      toId,
      ownerFile: metadata.ownerFile,
      range: metadata.range,
      evidenceSources: metadata.evidenceSources,
    }))
    .digest("hex")
    .slice(0, 12);
  graph.edges.set(`edge:CALLS:${fromId}->${toId}:evidence:${evidenceHash}`, {
    schemaVersion,
    id: `edge:CALLS:${fromId}->${toId}:evidence:${evidenceHash}`,
    kind: "CALLS",
    fromId,
    toId,
    workspace,
    repo,
    metadata,
  });
}

function ownerFileMetadata(repo: string, file: string, origin: string): Record<string, unknown> {
  return {
    ownerRepo: repo,
    ...(file ? { ownerFile: file } : {}),
    origin,
  };
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
