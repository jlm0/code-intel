import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

import { Connection, Database } from "@ladybugdb/core";

import { LadybugGraphStore } from "../graph/ladybug-store.js";
import { HealthCheckSchema, IndexManifestSchema, schemaVersion, type HealthCheck } from "../schema/schemas.js";
import { createEmbeddingProvider } from "../vectors/embedding.js";
import { createRuntimeContext, type RuntimeOptions } from "./context.js";

const require = createRequire(import.meta.url);

export async function runHealth(options: RuntimeOptions): Promise<unknown> {
  const context = createRuntimeContext(options);
  const checks = await Promise.all([
    checkNodeVersion(),
    checkExecutable("rg", ["--version"], "ripgrep is available"),
    checkScipTypescript(),
    checkTreeSitter(),
    checkLadybugVector(),
    checkTransformersModelCache(context.indexPath),
    checkEmbeddingProvider(context),
    checkIndexEmbeddingProvider(context.indexPath),
    checkIndexIntegrity(context.indexPath),
    checkMcpSdk(),
  ]);
  const parsedChecks = checks.map((check) => HealthCheckSchema.parse(check));
  const status = parsedChecks.some((check) => check.status === "fail")
    ? "fail"
    : parsedChecks.some((check) => check.status === "warn")
      ? "warn"
      : "ok";

  return {
    schemaVersion,
    status,
    indexPath: context.indexPath,
    checks: parsedChecks,
  };
}

async function checkIndexIntegrity(indexPath: string): Promise<HealthCheck> {
  const manifestPath = join(indexPath, "manifest.json");
  if (!existsSync(manifestPath)) {
    return {
      name: "index-integrity",
      status: "warn",
      message: "No index manifest exists yet",
      details: { manifestPath },
    };
  }

  const store = new LadybugGraphStore(indexPath);
  try {
    JSON.parse(readFileSync(manifestPath, "utf8"));
    const nodes = await store.getNodes();
    const edges = await store.getEdges();
    const nodeIds = new Set(nodes.map((node) => node.id));
    const danglingEdge = edges.find((edge) => !nodeIds.has(edge.fromId) || !nodeIds.has(edge.toId));
    return {
      name: "index-integrity",
      status: danglingEdge ? "fail" : "pass",
      message: danglingEdge
        ? `Dangling edge ${danglingEdge.id} references a missing node`
        : `Index graph has ${nodes.length} nodes and ${edges.length} relationships`,
      details: danglingEdge ? { edgeId: danglingEdge.id } : { nodes: nodes.length, edges: edges.length },
    };
  } catch (error) {
    return {
      name: "index-integrity",
      status: "fail",
      message: "Existing index integrity check failed",
      details: { error: error instanceof Error ? error.message : String(error), manifestPath },
    };
  } finally {
    await store.close();
  }
}

function checkIndexEmbeddingProvider(indexPath: string): HealthCheck {
  const manifestPath = join(indexPath, "manifest.json");
  if (!existsSync(manifestPath)) {
    return {
      name: "index-embedding-provider",
      status: "warn",
      message: "No index manifest exists yet",
      details: { manifestPath },
    };
  }

  try {
    const manifest = IndexManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    if (manifest.embedding.provider === "jina") {
      return {
        name: "index-embedding-provider",
        status: "pass",
        message: "Existing index uses Jina embeddings",
        details: manifest.embedding,
      };
    }
    if (manifest.embedding.provider === "hash") {
      return {
        name: "index-embedding-provider",
        status: "warn",
        message: "Existing index uses deterministic hash embeddings; rebuild without --embedding-provider hash to create Jina embeddings",
        details: manifest.embedding,
      };
    }
    return {
      name: "index-embedding-provider",
      status: "warn",
      message: `Existing index uses unrecognized embedding provider ${manifest.embedding.provider}`,
      details: manifest.embedding,
    };
  } catch (error) {
    return {
      name: "index-embedding-provider",
      status: "fail",
      message: "Existing index embedding metadata could not be read",
      details: { error: error instanceof Error ? error.message : String(error), manifestPath },
    };
  }
}

async function checkEmbeddingProvider(context: ReturnType<typeof createRuntimeContext>): Promise<HealthCheck> {
  try {
    const provider = await createEmbeddingProvider({
      provider: context.embeddingProvider,
      model: context.embeddingModel,
      indexPath: context.indexPath,
    });
    if (provider.provider === "jina") {
      const vector = await provider.embed("function healthCheck() { return true; }");
      return {
        name: "embedding-provider",
        status: vector.length === provider.dimension ? "pass" : "fail",
        message: vector.length === provider.dimension
          ? "Configured Jina embedding provider loads and embeds locally"
          : "Configured Jina embedding provider returned an unexpected vector dimension",
        details: { provider: provider.provider, model: provider.model, dimension: vector.length },
      };
    }
    return {
      name: "embedding-provider",
      status: "warn",
      message: "Using deterministic local hash embeddings; set --embedding-provider jina to validate semantic embeddings",
      details: { provider: provider.provider, model: provider.model, dimension: provider.dimension },
    };
  } catch (error) {
    return {
      name: "embedding-provider",
      status: "fail",
      message: "Embedding provider validation failed",
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function checkNodeVersion(): HealthCheck {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  return {
    name: "node",
    status: major >= 20 ? "pass" : "fail",
    message: major >= 20 ? `Node ${process.versions.node} is supported` : "Node 20 or newer is required",
    details: { version: process.versions.node },
  };
}

function checkExecutable(name: string, args: string[], passMessage: string): HealthCheck {
  const result = spawnSync(name, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return {
      name,
      status: "fail",
      message: `${name} is not available on PATH`,
      details: { error: result.error?.message, status: result.status },
    };
  }

  return {
    name,
    status: "pass",
    message: passMessage,
    details: { version: result.stdout.split("\n")[0] },
  };
}

function checkScipTypescript(): HealthCheck {
  try {
    const packagePath = require.resolve("@sourcegraph/scip-typescript/package.json");
    return {
      name: "scip-typescript",
      status: "pass",
      message: "scip-typescript package is installed",
      details: { packagePath },
    };
  } catch (error) {
    return {
      name: "scip-typescript",
      status: "fail",
      message: "scip-typescript package cannot be resolved",
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function checkTreeSitter(): HealthCheck {
  try {
    const Parser = require("tree-sitter");
    const JavaScript = require("tree-sitter-javascript");
    const TypeScript = require("tree-sitter-typescript");
    const parser = new Parser();
    parser.setLanguage(JavaScript);
    parser.parse("const value = 1;");
    parser.setLanguage(TypeScript.typescript);
    parser.parse("const value: number = 1;");
    parser.setLanguage(TypeScript.tsx);
    parser.parse("export function Component() { return <div />; }");
    return {
      name: "tree-sitter",
      status: "pass",
      message: "Tree-sitter JS, TS, and TSX parsers load",
    };
  } catch (error) {
    return {
      name: "tree-sitter",
      status: "fail",
      message: "Tree-sitter parser loading failed",
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

async function checkLadybugVector(): Promise<HealthCheck> {
  const tempRoot = mkdtempSync(join(tmpdir(), "code-intel-lbug-health-"));
  let connection: Connection | undefined;
  try {
    const db = new Database(join(tempRoot, "health.lbug"));
    connection = new Connection(db);
    await connection.query("INSTALL vector; LOAD vector;");
    await connection.query("CREATE NODE TABLE CodeNode(id STRING PRIMARY KEY, kind STRING, embedding FLOAT[3])");
    await connection.query("CREATE (:CodeNode {id: 'health', kind: 'Chunk', embedding: [0.1, 0.2, 0.3]})");
    await connection.query("CALL CREATE_VECTOR_INDEX('CodeNode', 'health_idx', 'embedding', metric := 'cosine')");
    const result = await connection.query("CALL QUERY_VECTOR_INDEX('CodeNode', 'health_idx', [0.1, 0.2, 0.3], 1) RETURN node.id AS id");
    const singleResult = Array.isArray(result) ? result[0] : result;
    const rows = await singleResult.getAll();

    return {
      name: "ladybug-vector",
      status: rows[0]?.id === "health" ? "pass" : "fail",
      message: rows[0]?.id === "health" ? "LadybugDB vector extension works" : "LadybugDB vector query returned no row",
    };
  } catch (error) {
    return {
      name: "ladybug-vector",
      status: "fail",
      message: "LadybugDB vector extension failed",
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  } finally {
    await connection?.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function checkTransformersModelCache(indexPath: string): HealthCheck {
  try {
    require.resolve("@huggingface/transformers");
    const modelPath = resolve(indexPath, "models", "jinaai", "jina-embeddings-v2-base-code");
    return {
      name: "transformers",
      status: existsSync(modelPath) ? "pass" : "warn",
      message: existsSync(modelPath)
        ? "Configured embedding model cache exists"
        : "Transformers.js is installed, but the configured model cache is not preseeded",
      details: { model: "jinaai/jina-embeddings-v2-base-code", modelPath },
    };
  } catch (error) {
    return {
      name: "transformers",
      status: "fail",
      message: "Transformers.js cannot be resolved",
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function checkMcpSdk(): HealthCheck {
  try {
    require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
    require.resolve("@modelcontextprotocol/sdk/server/stdio.js");
    return {
      name: "mcp-sdk",
      status: "pass",
      message: "MCP TypeScript SDK server and stdio transport are available",
    };
  } catch (error) {
    return {
      name: "mcp-sdk",
      status: "fail",
      message: "MCP TypeScript SDK cannot be resolved",
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}
