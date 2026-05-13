import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Connection, Database, type QueryResult as LadybugQueryResult } from "@ladybugdb/core";

import { CodeEdgeSchema, CodeNodeSchema, type CodeEdge, type CodeNode } from "../schema/schemas.js";
import { cypherValue } from "./cypher.js";
import type {
  CodeGraphRepository,
  RelatedCodeNode,
  SemanticCodeNode,
  SemanticSearchFilters,
  StoredCodeNode,
} from "./repository.js";

export interface GraphWriteInput {
  nodes: CodeNode[];
  edges: CodeEdge[];
  chunks: Array<CodeNode & { content: string; embedding: number[] }>;
  embeddingDimension: number;
}

export interface GraphGeneration {
  generationId: string;
  generationPath: string;
  databasePath: string;
}

export interface VectorSearchRow {
  id: string;
  distance: number;
}

const activeIndexFile = "current.json";
const legacyDatabaseName = "code-intel.lbug";
const youngLockAgeMs = 30_000;
const symbolKinds = ["Function", "Class", "Interface", "TypeAlias", "Symbol", "Test"];
const edgeKinds: CodeEdge["kind"][] = [
  "CONTAINS",
  "DEFINES",
  "IMPORTS",
  "EXPORTS",
  "REFERENCES",
  "CALLS",
  "EXTENDS",
  "IMPLEMENTS",
  "DEPENDS_ON",
  "HAS_CHUNK",
  "TESTS",
  "MENTIONS",
];

export class LadybugGraphStore implements CodeGraphRepository {
  private databasePath?: string;
  private connection?: Connection;
  private hasLock = false;

  constructor(private readonly indexPath: string) {}

  async rebuild(input: GraphWriteInput): Promise<GraphGeneration> {
    assertNoDanglingEdges(input);
    await mkdir(this.indexPath, { recursive: true });
    await this.close();
    const generationId = `${Date.now()}-${randomUUID()}`;
    const generationRoot = join(this.indexPath, "generations", generationId);
    this.databasePath = join(generationRoot, legacyDatabaseName);
    await mkdir(generationRoot, { recursive: true });
    await this.open();
    try {
      await this.createSchema(input.embeddingDimension);
      const chunksById = new Map(input.chunks.map((chunk) => [chunk.id, chunk]));
      await this.createNodes(input.nodes.map((node) => CodeNodeSchema.parse(node)), chunksById);
      await this.createNodeProjections(input.nodes.map((node) => CodeNodeSchema.parse(node)));
      await this.createEdges(input.edges.map((edge) => CodeEdgeSchema.parse(edge)));
      await this.createVectorIndex();
    } finally {
      await this.close();
    }
    this.databasePath = join(generationRoot, legacyDatabaseName);
    return {
      generationId,
      generationPath: generationRoot,
      databasePath: this.databasePath,
    };
  }

  async publishGeneration(generationId: string): Promise<void> {
    await this.writeActivePointer(generationId);
  }

  async open(): Promise<void> {
    if (this.connection) {
      return;
    }
    await mkdir(this.indexPath, { recursive: true });
    this.databasePath ??= await this.resolveActiveDatabasePath();
    await this.acquireProcessLock();
    try {
      this.connection = await this.openWithRetry();
    } catch (error) {
      await this.releaseProcessLock();
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      if (this.connection) {
        await this.connection.close();
        this.connection = undefined;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
      }
    } finally {
      await this.releaseProcessLock();
    }
  }

  async findSymbols(nameOrId: string, limit: number): Promise<StoredCodeNode[]> {
    await this.open();
    const needle = nameOrId.toLowerCase();
    const rows = await this.rows(`
      MATCH (n:CodeNode)
      WHERE n.kind IN ${cypherValue(symbolKinds)}
        AND (n.id = ${cypherValue(nameOrId)} OR lower(n.name) CONTAINS ${cypherValue(needle)})
      ${nodeReturnClause("n")}
      LIMIT ${Math.max(limit * 5, limit)}
    `);
    return rows.map(rowToNode).sort((left, right) => symbolRank(left, needle) - symbolRank(right, needle)).slice(0, limit);
  }

  async getRelatedNodes(
    seed: string,
    edgeKind: CodeEdge["kind"],
    direction: "incoming" | "outgoing",
    limit: number,
  ): Promise<RelatedCodeNode[]> {
    const seeds = await this.resolveSeedNodes(seed, 50);
    const seedIds = seeds.map((node) => node.id);
    if (seedIds.length === 0) {
      return [];
    }
    if (direction === "incoming") {
      return this.relatedRows(`
        MATCH (node:CodeNode)-[edge:RELATES]->(seed:CodeNode)
        WHERE seed.id IN ${cypherValue(seedIds)} AND edge.kind = ${cypherValue(edgeKind)}
        ${nodeReturnClause("node")}, edge.kind AS edgeKind
        LIMIT ${limit}
      `);
    }
    return this.relatedRows(`
      MATCH (seed:CodeNode)-[edge:RELATES]->(node:CodeNode)
      WHERE seed.id IN ${cypherValue(seedIds)} AND edge.kind = ${cypherValue(edgeKind)}
      ${nodeReturnClause("node")}, edge.kind AS edgeKind
      LIMIT ${limit}
    `);
  }

  async getAdjacentNodes(nodeIds: string[], limit: number): Promise<RelatedCodeNode[]> {
    if (nodeIds.length === 0 || limit <= 0) {
      return [];
    }
    const outgoing = await this.relatedRows(`
      MATCH (current:CodeNode)-[edge:RELATES]->(node:CodeNode)
      WHERE current.id IN ${cypherValue(nodeIds)}
      ${nodeReturnClause("node")}, edge.kind AS edgeKind
      LIMIT ${limit}
    `);
    const incoming = await this.relatedRows(`
      MATCH (node:CodeNode)-[edge:RELATES]->(current:CodeNode)
      WHERE current.id IN ${cypherValue(nodeIds)}
      ${nodeReturnClause("node")}, edge.kind AS edgeKind
      LIMIT ${limit}
    `);
    return mergeRelatedRows(outgoing, incoming, limit);
  }

  async getContextNodes(seed: string, limit: number): Promise<StoredCodeNode[]> {
    const seeds = await this.resolveSeedNodes(seed, Math.max(limit, 20), true);
    const direct = seeds.filter((node) => node.kind === "Chunk" || node.content);
    if (direct.length >= limit) {
      return direct.slice(0, limit);
    }
    const seedIds = seeds.map((node) => node.id);
    if (seedIds.length === 0) {
      return [];
    }
    const mentionedChunks = await this.rows(`
      MATCH (node:CodeNode)-[edge:RELATES]->(seed:CodeNode)
      WHERE node.kind = 'Chunk' AND edge.kind = 'MENTIONS' AND seed.id IN ${cypherValue(seedIds)}
      ${nodeReturnClause("node", true)}
      LIMIT ${limit - direct.length}
    `);
    return [...direct, ...mentionedChunks.map(rowToNode)].slice(0, limit);
  }

  async semanticSearch(
    embedding: number[],
    limit: number,
    filters: SemanticSearchFilters = {},
  ): Promise<SemanticCodeNode[]> {
    await this.open();
    const whereClause = semanticFilterWhereClause(filters);
    const candidateLimit = whereClause ? Math.max(limit * 50, 200) : limit;
    const rows = await this.rows(`
      CALL QUERY_VECTOR_INDEX('CodeNode', 'chunk_embedding_index', ${cypherValue(embedding)}, ${candidateLimit})
      ${whereClause}
      ${nodeReturnClause("node", true)}, distance
      ORDER BY distance
      LIMIT ${limit}
    `);
    return rows.map((row) => ({ node: rowToNode(row), distance: Number(row.distance) }));
  }

  async tracePath(fromId: string, toId: string, limit: number): Promise<StoredCodeNode[]> {
    const queue: Array<{ id: string; path: StoredCodeNode[] }> = [{ id: fromId, path: [] }];
    const seen = new Set([fromId]);

    while (queue.length > 0 && seen.size <= Math.max(limit * 20, limit)) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      if (current.id === toId) {
        return current.path;
      }
      for (const row of await this.getAdjacentNodes([current.id], limit)) {
        if (seen.has(row.node.id)) {
          continue;
        }
        const nextPath = [...current.path, row.node].slice(0, limit);
        if (row.node.id === toId) {
          return nextPath;
        }
        seen.add(row.node.id);
        queue.push({ id: row.node.id, path: nextPath });
      }
    }
    return [];
  }

  async getNodes(): Promise<StoredCodeNode[]> {
    await this.open();
    const rows = await this.rows(`
      MATCH (n:CodeNode)
      ${nodeReturnClause("n")}
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
      CALL QUERY_VECTOR_INDEX('CodeNode', 'chunk_embedding_index', ${cypherValue(embedding)}, ${limit})
      RETURN node.id AS id, distance
      ORDER BY distance
    `);
    return rows.map((row) => ({ id: String(row.id), distance: Number(row.distance) }));
  }

  private async createSchema(embeddingDimension: number): Promise<void> {
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
        fileKind STRING,
        symbolKind STRING,
        startLine INT64,
        endLine INT64,
        startColumn INT64,
        endColumn INT64,
        textHash STRING,
        content STRING,
        embedding FLOAT[${embeddingDimension}],
        metadata STRING
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
    await this.query("CREATE NODE TABLE IF NOT EXISTS Chunk(id STRING PRIMARY KEY, name STRING, file STRING)");
    for (const edgeKind of edgeKinds) {
      await this.query(
        `CREATE REL TABLE IF NOT EXISTS ${edgeKind}(FROM CodeNode TO CodeNode, id STRING, metadata STRING)`,
      );
    }
  }

  private async createNodes(
    nodes: CodeNode[],
    chunksById: Map<string, CodeNode & { content: string; embedding: number[] }>,
  ): Promise<void> {
    for (const batch of chunkArray(nodes, 200)) {
      await this.query(`
        CREATE ${batch
          .map((node) => `(:CodeNode ${cypherMap(nodeValues(node, chunksById.get(node.id)))})`)
          .join(", ")}
      `);
    }
  }

  private async createNodeProjections(nodes: CodeNode[]): Promise<void> {
    const projections = new Map<string, Record<string, unknown>[]>();
    for (const node of nodes) {
      const projection = typedNodeProjection(node);
      if (!projection) continue;
      const rows = projections.get(projection.table) ?? [];
      rows.push(projection.values);
      projections.set(projection.table, rows);
    }

    for (const [table, rows] of projections) {
      for (const batch of chunkArray(rows, 200)) {
        await this.query(`
          CREATE ${batch.map((row) => `(:${table} ${cypherMap(row)})`).join(", ")}
        `);
      }
    }
  }

  private async createEdges(edges: CodeEdge[]): Promise<void> {
    for (const batch of chunkArray(edges, 100)) {
      const matches = batch
        .map(
          (edge, index) =>
            `(from${index}:CodeNode {id: ${cypherValue(edge.fromId)}}), (to${index}:CodeNode {id: ${cypherValue(edge.toId)}})`,
        )
        .join(", ");
      const creates = batch
        .flatMap((edge, index) => {
          const properties = {
            id: edge.id,
            metadata: JSON.stringify(edge.metadata),
          };
          return [
            `(from${index})-[:RELATES ${cypherMap({
              id: edge.id,
              kind: edge.kind,
              metadata: JSON.stringify(edge.metadata),
            })}]->(to${index})`,
            `(from${index})-[:${edge.kind} ${cypherMap(properties)}]->(to${index})`,
          ];
        })
        .join(", ");
      await this.query(`MATCH ${matches} CREATE ${creates}`);
    }
  }

  private async createVectorIndex(): Promise<void> {
    try {
      await this.query("CALL CREATE_VECTOR_INDEX('CodeNode', 'chunk_embedding_index', 'embedding', metric := 'cosine')");
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

  private async openWithRetry(): Promise<Connection> {
    let lastError: unknown;
    if (!this.databasePath) {
      throw new Error("Ladybug database path is not resolved");
    }
    for (let attempt = 0; attempt < 300; attempt += 1) {
      let connection: Connection | undefined;
      try {
        const database = new Database(this.databasePath);
        connection = new Connection(database);
        await connection.query("INSTALL vector; LOAD vector;");
        return connection;
      } catch (error) {
        await connection?.close().catch(() => undefined);
        lastError = error;
        const message = String(error);
        if (
          !message.includes("Could not set lock") &&
          !message.includes("shadow file") &&
          !message.includes(".shadow")
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async rows(statement: string): Promise<Record<string, unknown>[]> {
    const result = await this.query(statement);
    const singleResult = Array.isArray(result) ? result[0] : result;
    return singleResult.getAll() as Promise<Record<string, unknown>[]>;
  }

  private async relatedRows(statement: string): Promise<RelatedCodeNode[]> {
    await this.open();
    const rows = await this.rows(statement);
    return rows.map((row) => ({
      node: rowToNode(row),
      edgeKind: CodeEdgeSchema.shape.kind.parse(row.edgeKind),
    }));
  }

  private async resolveSeedNodes(
    seed: string,
    limit: number,
    includeContent = false,
  ): Promise<StoredCodeNode[]> {
    await this.open();
    const lowered = seed.toLowerCase();
    const rows = await this.rows(`
      MATCH (n:CodeNode)
      WHERE n.id = ${cypherValue(seed)}
        OR (n.kind IN ${cypherValue(symbolKinds)} AND lower(n.name) = ${cypherValue(lowered)})
        OR (n.kind IN ${cypherValue(symbolKinds)} AND lower(n.name) CONTAINS ${cypherValue(lowered)})
      ${nodeReturnClause("n", includeContent)}
      LIMIT ${limit}
    `);
    return rows.map(rowToNode).sort((left, right) => symbolRank(left, lowered) - symbolRank(right, lowered));
  }

  private async writeActivePointer(generationId: string): Promise<void> {
    const pointer = {
      generationId,
      databasePath: `generations/${generationId}/${legacyDatabaseName}`,
    };
    const pointerPath = join(this.indexPath, activeIndexFile);
    const tempPointerPath = join(this.indexPath, `${activeIndexFile}.tmp`);
    await writeFile(tempPointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
    await rename(tempPointerPath, pointerPath);
  }

  private async resolveActiveDatabasePath(): Promise<string> {
    try {
      const pointer = JSON.parse(await readFile(join(this.indexPath, activeIndexFile), "utf8")) as {
        databasePath?: unknown;
      };
      if (typeof pointer.databasePath === "string" && pointer.databasePath.length > 0) {
        return resolve(this.indexPath, pointer.databasePath);
      }
    } catch {
      return join(this.indexPath, legacyDatabaseName);
    }
    return join(this.indexPath, legacyDatabaseName);
  }

  private async acquireProcessLock(): Promise<void> {
    const lockPath = join(this.indexPath, ".ladybug.lock");
    let lastError: unknown;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      try {
        await mkdir(lockPath);
        try {
          await writeFile(
            join(lockPath, "owner.json"),
            `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2)}\n`,
          );
        } catch (error) {
          await rm(lockPath, { recursive: true, force: true });
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            lastError = error;
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
            continue;
          }
          throw error;
        }
        this.hasLock = true;
        return;
      } catch (error) {
        lastError = error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          throw error;
        }
        await recoverStaleProcessLock(lockPath);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async releaseProcessLock(): Promise<void> {
    if (!this.hasLock) {
      return;
    }
    this.hasLock = false;
    await rm(join(this.indexPath, ".ladybug.lock"), { recursive: true, force: true });
  }
}

async function recoverStaleProcessLock(lockPath: string): Promise<void> {
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

function assertNoDanglingEdges(input: GraphWriteInput): void {
  const nodeIds = new Set(input.nodes.map((node) => node.id));
  const danglingEdge = input.edges.find(
    (edge) => !nodeIds.has(edge.fromId) || !nodeIds.has(edge.toId),
  );
  if (danglingEdge) {
    throw new Error(
      `Dangling edge ${danglingEdge.id} references ${danglingEdge.fromId} -> ${danglingEdge.toId}`,
    );
  }
}

function rowToNode(row: Record<string, unknown>): StoredCodeNode {
  const startLine = numberOrUndefined(row.startLine);
  const endLine = numberOrUndefined(row.endLine);
  const node = CodeNodeSchema.parse({
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
  const content = stringOrUndefined(row.content);
  return content ? { ...node, content } : node;
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

function nodeReturnClause(alias: string, includeContent = false): string {
  return `
    RETURN ${alias}.id AS id, ${alias}.kind AS kind, ${alias}.workspace AS workspace,
      ${alias}.repo AS repo, ${alias}.packageName AS packageName, ${alias}.file AS file,
      ${alias}.name AS name, ${alias}.language AS language, ${alias}.startLine AS startLine,
      ${alias}.endLine AS endLine, ${alias}.startColumn AS startColumn,
      ${alias}.endColumn AS endColumn, ${alias}.textHash AS textHash,
      ${includeContent ? `${alias}.content AS content,` : ""}
      ${alias}.metadata AS metadata
  `;
}

function symbolRank(node: CodeNode, needle: string): number {
  const name = node.name?.toLowerCase() ?? "";
  if (node.id.toLowerCase() === needle) return 0;
  if (name === needle) return 1;
  if (node.kind === "Function" && name.includes(needle)) return 2;
  if (name.startsWith(needle)) return 3;
  return 4;
}

function nodeValues(node: CodeNode, chunk?: CodeNode & { content: string; embedding: number[] }): Record<string, unknown> {
  return {
    id: node.id,
    kind: node.kind,
    workspace: node.workspace,
    repo: node.repo,
    packageName: node.packageName,
    file: node.file,
    name: node.name,
    language: node.language,
    fileKind: stringMetadata(node, "fileKind"),
    symbolKind: stringMetadata(node, "symbolKind") ?? (symbolKinds.includes(node.kind) ? node.kind : undefined),
    startLine: node.range?.startLine,
    endLine: node.range?.endLine,
    startColumn: node.range?.startColumn,
    endColumn: node.range?.endColumn,
    textHash: node.textHash,
    content: chunk?.content,
    embedding: chunk?.embedding,
    metadata: JSON.stringify(node.metadata),
  };
}

function stringMetadata(node: CodeNode, key: string): string | undefined {
  const value = node.metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function semanticFilterWhereClause(filters: SemanticSearchFilters): string {
  const clauses = [
    filters.repo ? `node.repo = ${cypherValue(filters.repo)}` : undefined,
    filters.packageName ? `node.packageName = ${cypherValue(filters.packageName)}` : undefined,
    filters.fileKind ? `node.fileKind = ${cypherValue(filters.fileKind.toLowerCase())}` : undefined,
    filters.symbolKind ? `node.symbolKind = ${cypherValue(filters.symbolKind)}` : undefined,
  ].filter(Boolean);
  return clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
}

function cypherMap(values: Record<string, unknown>): string {
  return `{${Object.entries(values)
    .map(([key, value]) => `${key}: ${cypherValue(value)}`)
    .join(", ")}}`;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function mergeRelatedRows(
  first: RelatedCodeNode[],
  second: RelatedCodeNode[],
  limit: number,
): RelatedCodeNode[] {
  const rows: RelatedCodeNode[] = [];
  const seen = new Set<string>();
  const push = (row: RelatedCodeNode | undefined) => {
    if (!row || seen.has(row.node.id) || rows.length >= limit) {
      return;
    }
    seen.add(row.node.id);
    rows.push(row);
  };

  for (let index = 0; rows.length < limit && (index < first.length || index < second.length); index += 1) {
    push(first[index]);
    push(second[index]);
  }
  return rows;
}

function typedNodeProjection(node: CodeNode): { table: string; values: Record<string, unknown> } | undefined {
  switch (node.kind) {
    case "Workspace":
      return { table: "Workspace", values: { id: node.id, name: node.name } };
    case "Repo":
      return { table: "Repo", values: { id: node.id, name: node.name } };
    case "Package":
      return { table: "Package", values: { id: node.id, name: node.name } };
    case "File":
      return { table: "File", values: { id: node.id, path: node.file } };
    case "Symbol":
    case "Function":
    case "Class":
    case "Interface":
    case "TypeAlias":
      return { table: "Symbol", values: { id: node.id, name: node.name } };
    case "Test":
      return { table: "Test", values: { id: node.id, name: node.name } };
    case "Chunk":
      return { table: "Chunk", values: { id: node.id, name: node.name, file: node.file } };
    default:
      return undefined;
  }
}
