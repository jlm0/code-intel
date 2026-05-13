import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { Connection, Database, type QueryResult as LadybugQueryResult } from "@ladybugdb/core";

import { CodeEdgeSchema, CodeNodeSchema, type CodeEdge, type CodeNode } from "../schema/schemas.js";
import { embeddingDimension } from "../vectors/embedding.js";
import { cypherAssignments, cypherValue } from "./cypher.js";

export interface GraphWriteInput {
  nodes: CodeNode[];
  edges: CodeEdge[];
  chunks: Array<CodeNode & { content: string; embedding: number[] }>;
}

export interface VectorSearchRow {
  id: string;
  distance: number;
}

export class LadybugGraphStore {
  private readonly databasePath: string;
  private connection?: Connection;

  constructor(private readonly indexPath: string) {
    this.databasePath = join(indexPath, "code-intel.lbug");
  }

  async rebuild(input: GraphWriteInput): Promise<void> {
    await rm(this.databasePath, { recursive: true, force: true });
    await mkdir(this.indexPath, { recursive: true });
    await this.open();
    await this.createSchema();
    for (const node of input.nodes) {
      await this.upsertNode(CodeNodeSchema.parse(node));
    }
    for (const chunk of input.chunks) {
      await this.upsertChunk(chunk);
    }
    for (const edge of input.edges) {
      await this.createEdge(CodeEdgeSchema.parse(edge));
    }
    await this.createVectorIndex();
  }

  async open(): Promise<void> {
    if (this.connection) {
      return;
    }
    await mkdir(this.indexPath, { recursive: true });
    const database = new Database(this.databasePath);
    this.connection = new Connection(database);
    await this.query("INSTALL vector; LOAD vector;");
  }

  async getNodes(): Promise<CodeNode[]> {
    await this.open();
    const rows = await this.rows(`
      MATCH (n:CodeNode)
      RETURN n.id AS id, n.kind AS kind, n.workspace AS workspace, n.repo AS repo,
        n.packageName AS packageName, n.file AS file, n.name AS name,
        n.language AS language, n.startLine AS startLine, n.endLine AS endLine,
        n.startColumn AS startColumn, n.endColumn AS endColumn,
        n.textHash AS textHash, n.content AS content, n.metadata AS metadata
      ORDER BY n.id
    `);
    return rows.map(rowToNode);
  }

  async getEdges(): Promise<CodeEdge[]> {
    await this.open();
    const rows = await this.rows(`
      MATCH (from:CodeNode)-[edge:RELATES]->(to:CodeNode)
      RETURN edge.id AS id, edge.kind AS kind, from.id AS fromId, to.id AS toId,
        from.workspace AS workspace, from.repo AS repo, edge.metadata AS metadata
      ORDER BY edge.id
    `);
    return rows.map(rowToEdge);
  }

  async vectorSearch(embedding: number[], limit: number): Promise<VectorSearchRow[]> {
    await this.open();
    const rows = await this.rows(`
      CALL QUERY_VECTOR_INDEX('Chunk', 'chunk_embedding_index', ${cypherValue(embedding)}, ${limit})
      RETURN node.id AS id, distance
      ORDER BY distance
    `);
    return rows.map((row) => ({ id: String(row.id), distance: Number(row.distance) }));
  }

  private async createSchema(): Promise<void> {
    await this.query(`
      CREATE NODE TABLE IF NOT EXISTS CodeNode(
        id STRING PRIMARY KEY,
        kind STRING,
        workspace STRING,
        repo STRING,
        packageName STRING,
        file STRING,
        name STRING,
        language STRING,
        startLine INT64,
        endLine INT64,
        startColumn INT64,
        endColumn INT64,
        textHash STRING,
        content STRING,
        metadata STRING
      )
    `);
    await this.query(`
      CREATE NODE TABLE IF NOT EXISTS Chunk(
        id STRING PRIMARY KEY,
        content STRING,
        embedding FLOAT[${embeddingDimension}]
      )
    `);
    await this.query("CREATE REL TABLE IF NOT EXISTS RELATES(FROM CodeNode TO CodeNode, id STRING, kind STRING, metadata STRING)");
    await this.createTypedTables();
  }

  private async createTypedTables(): Promise<void> {
    await this.query("CREATE NODE TABLE IF NOT EXISTS Workspace(id STRING PRIMARY KEY, name STRING)");
    await this.query("CREATE NODE TABLE IF NOT EXISTS Repo(id STRING PRIMARY KEY, name STRING)");
    await this.query("CREATE NODE TABLE IF NOT EXISTS Package(id STRING PRIMARY KEY, name STRING)");
    await this.query("CREATE NODE TABLE IF NOT EXISTS File(id STRING PRIMARY KEY, path STRING)");
    await this.query("CREATE NODE TABLE IF NOT EXISTS Symbol(id STRING PRIMARY KEY, name STRING)");
    await this.query("CREATE NODE TABLE IF NOT EXISTS Test(id STRING PRIMARY KEY, name STRING)");
  }

  private async upsertNode(node: CodeNode): Promise<void> {
    const values = {
      kind: node.kind,
      workspace: node.workspace,
      repo: node.repo,
      packageName: node.packageName,
      file: node.file,
      name: node.name,
      language: node.language,
      startLine: node.range?.startLine,
      endLine: node.range?.endLine,
      startColumn: node.range?.startColumn,
      endColumn: node.range?.endColumn,
      textHash: node.textHash,
      content: "content" in node ? (node as { content?: string }).content : undefined,
      metadata: JSON.stringify(node.metadata),
    };
    const assignments = cypherAssignments("n", values);
    await this.query(`
      MERGE (n:CodeNode {id: ${cypherValue(node.id)}})
      ON CREATE SET ${assignments}
      ON MATCH SET ${assignments}
    `);
  }

  private async upsertChunk(chunk: CodeNode & { content: string; embedding: number[] }): Promise<void> {
    await this.query(`
      MERGE (chunk:Chunk {id: ${cypherValue(chunk.id)}})
      ON CREATE SET chunk.content = ${cypherValue(chunk.content)}, chunk.embedding = ${cypherValue(chunk.embedding)}
      ON MATCH SET chunk.content = ${cypherValue(chunk.content)}, chunk.embedding = ${cypherValue(chunk.embedding)}
    `);
  }

  private async createEdge(edge: CodeEdge): Promise<void> {
    await this.query(`
      MATCH (from:CodeNode {id: ${cypherValue(edge.fromId)}}), (to:CodeNode {id: ${cypherValue(edge.toId)}})
      CREATE (from)-[:RELATES {
        id: ${cypherValue(edge.id)},
        kind: ${cypherValue(edge.kind)},
        metadata: ${cypherValue(JSON.stringify(edge.metadata))}
      }]->(to)
    `);
  }

  private async createVectorIndex(): Promise<void> {
    try {
      await this.query("CALL CREATE_VECTOR_INDEX('Chunk', 'chunk_embedding_index', 'embedding', metric := 'cosine')");
    } catch (error) {
      if (!String(error).includes("already exists")) {
        throw error;
      }
    }
  }

  private async query(statement: string): Promise<LadybugQueryResult | LadybugQueryResult[]> {
    if (!this.connection) {
      throw new Error("Ladybug connection is not open");
    }
    return this.connection.query(statement);
  }

  private async rows(statement: string): Promise<Record<string, unknown>[]> {
    const result = await this.query(statement);
    const singleResult = Array.isArray(result) ? result[0] : result;
    return singleResult.getAll() as Promise<Record<string, unknown>[]>;
  }
}

function rowToNode(row: Record<string, unknown>): CodeNode {
  const startLine = numberOrUndefined(row.startLine);
  const endLine = numberOrUndefined(row.endLine);
  return CodeNodeSchema.parse({
    schemaVersion: "code-intel.v1",
    id: String(row.id),
    kind: String(row.kind),
    workspace: String(row.workspace),
    repo: String(row.repo),
    packageName: stringOrUndefined(row.packageName),
    file: stringOrUndefined(row.file),
    name: stringOrUndefined(row.name),
    language: stringOrUndefined(row.language),
    range: startLine && endLine
      ? {
          startLine,
          endLine,
          startColumn: numberOrUndefined(row.startColumn) ?? 0,
          endColumn: numberOrUndefined(row.endColumn) ?? 0,
        }
      : undefined,
    textHash: stringOrUndefined(row.textHash),
    metadata: parseMetadata(row.metadata),
  });
}

function rowToEdge(row: Record<string, unknown>): CodeEdge {
  return CodeEdgeSchema.parse({
    schemaVersion: "code-intel.v1",
    id: String(row.id),
    kind: String(row.kind),
    fromId: String(row.fromId),
    toId: String(row.toId),
    workspace: String(row.workspace),
    repo: String(row.repo),
    metadata: parseMetadata(row.metadata),
  });
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) {
    return {};
  }
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
