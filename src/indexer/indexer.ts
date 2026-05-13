import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { embeddingModel, embedText } from "../vectors/embedding.js";
import { discoverWorkspace, type DiscoveredFile } from "../workspace/discovery.js";

export interface IndexWorkspaceInput {
  workspaceRoot: string;
  repoPaths: string[];
  indexPath: string;
}

interface MutableGraph {
  nodes: Map<string, CodeNode>;
  edges: Map<string, CodeEdge>;
  chunks: Map<string, CodeNode & { content: string; embedding: number[] }>;
}

export async function indexWorkspace(input: IndexWorkspaceInput): Promise<IndexManifest> {
  await mkdir(input.indexPath, { recursive: true });
  const workspace = await discoverWorkspace({
    workspaceRoot: input.workspaceRoot,
    repoPaths: input.repoPaths,
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
            suffix: chunk.name,
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
          metadata: { absolutePath: file.absolutePath },
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
            symbolId: symbolNode.id,
            embeddingModel,
          },
        }) as CodeNode & { content: string; embedding: number[] };
        chunkNode.content = chunk.content;
        chunkNode.embedding = embedText(`${chunk.name}\n${chunk.content}`);
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

    for (const chunk of graph.chunks.values()) {
      if (chunk.repo !== repo.name || !chunk.file) continue;
      for (const [symbolName, symbols] of symbolNodesByName) {
        if (!chunk.content.includes(symbolName)) continue;
        for (const symbol of symbols) {
          if (String(chunk.metadata.symbolId) === symbol.id) continue;
          addEdge(graph, chunk.kind === "Test" ? "TESTS" : "REFERENCES", chunk.id, symbol.id, workspace.workspaceName, repo.name);
        }
      }
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
          },
        });
        scipSymbolNodes.set(definition.symbol, symbolNode);
        if (fileNode) {
          addEdge(graph, "DEFINES", fileNode.id, symbolNode.id, workspace.workspaceName, repo.name);
        }
      }
      for (const reference of facts.references) {
        const fileNode = fileNodes.get(reference.relativePath);
        const symbolNode = scipSymbolNodes.get(reference.symbol);
        if (fileNode && symbolNode) {
          addEdge(graph, "REFERENCES", fileNode.id, symbolNode.id, workspace.workspaceName, repo.name);
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

  const store = new LadybugGraphStore(input.indexPath);
  await store.rebuild({
    nodes: [...graph.nodes.values()],
    edges: [...graph.edges.values()],
    chunks: [...graph.chunks.values()],
  });

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
    health,
  };
  await writeFile(join(input.indexPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(input.indexPath, "workspace.json"), `${JSON.stringify(workspace, null, 2)}\n`);
  return manifest;
}

function hashShort(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
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
    metadata: { absolutePath: file.absolutePath },
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
