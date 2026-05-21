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
  nodes: ReadonlyMap<string, CodeNode>;
  edges: ReadonlyMap<string, CodeEdge>;
  chunksById: ReadonlyMap<string, CodeNode & { content: string; embedding: number[] }>;
  embeddingDimension: number;
}

export interface GraphGeneration {
  generationId: string;
  generationPath: string;
  databasePath: string;
}

export interface LadybugRuntimeStats {
  lockWaitMs: number;
  openRetryCount: number;
  lockContentionCount: number;
}

interface LadybugGraphStoreOptions {
  databasePath?: string | Promise<string>;
  lockTimeoutMs?: number;
  lockRetryDelayMs?: number;
  openRetryLimit?: number;
  openRetryDelayMs?: number;
}

export interface VectorSearchRow {
  id: string;
  distance: number;
}

const activeIndexFile = "current.json";
const legacyDatabaseName = "code-intel.lbug";
const youngLockAgeMs = 30_000;
const staleLockAgeMs = 12 * 60 * 60 * 1000;
const symbolKinds = ["Function", "Class", "Interface", "TypeAlias", "Symbol", "Test"];
const findableSymbolKinds = [...symbolKinds, "Export"];
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
  private database?: Database;
  private connection?: Connection;
  private openPromise?: Promise<void>;
  private hasLock = false;
  private readonly runtimeStats: LadybugRuntimeStats = {
    lockWaitMs: 0,
    openRetryCount: 0,
    lockContentionCount: 0,
  };

  constructor(
    private readonly indexPath: string,
    private readonly options: LadybugGraphStoreOptions = {},
  ) {}

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
      await this.createNodes(input.nodes.values(), input.chunksById);
      await this.createEdges(input.edges.values());
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
    if (this.openPromise) {
      await this.openPromise;
      return;
    }
    this.openPromise = this.openInternal();
    try {
      await this.openPromise;
    } finally {
      this.openPromise = undefined;
    }
  }

  private async openInternal(): Promise<void> {
    await mkdir(this.indexPath, { recursive: true });
    this.databasePath ??= await this.resolveDatabasePath();
    await this.acquireProcessLock();
    try {
      this.connection = await this.openWithRetry();
    } catch (error) {
      await this.releaseProcessLock();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.openPromise) {
      await this.openPromise.catch(() => undefined);
    }
    try {
      if (this.connection) {
        await this.connection.close();
        this.connection = undefined;
      }
      if (this.database) {
        await this.database.close();
        this.database = undefined;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    } finally {
      await this.releaseProcessLock();
    }
  }

  getRuntimeStats(): LadybugRuntimeStats {
    return {
      lockWaitMs: Math.round(this.runtimeStats.lockWaitMs),
      openRetryCount: this.runtimeStats.openRetryCount,
      lockContentionCount: this.runtimeStats.lockContentionCount,
    };
  }

  async findSymbols(nameOrId: string, limit: number): Promise<StoredCodeNode[]> {
    await this.open();
    const needle = nameOrId.toLowerCase();
    const exactRows = await this.rows(`
      MATCH (n:CodeNode)
      WHERE n.id = ${cypherValue(nameOrId)}
      ${nodeReturnClause("n")}
      LIMIT ${limit}
    `);
    if (exactRows.length > 0) {
      return exactRows.map(rowToNode).slice(0, limit);
    }
    const exactQualifiedRows = await this.exactQualifiedSymbolRows(nameOrId, limit);
    if (exactQualifiedRows.length > 0) {
      return exactQualifiedRows.map(rowToNode).slice(0, limit);
    }
    const needles = symbolNeedles(nameOrId);
    const textMatches = symbolSearchClauses(needles, nameOrId)
      .join(" OR ");
    const rows = await this.rows(`
      MATCH (n:CodeNode)
      WHERE n.kind IN ${cypherValue(findableSymbolKinds)}
        AND (n.id = ${cypherValue(nameOrId)} OR ${textMatches})
      ${nodeReturnClause("n")}
      LIMIT ${Math.max(limit * 5, limit)}
    `);
    return dedupeSymbols(rows.map(rowToNode).sort((left, right) =>
      exactSeedRank(left, nameOrId) - exactSeedRank(right, nameOrId) ||
      compareSymbols(left, right, needle)
    )).slice(0, limit);
  }

  async getRelatedNodes(
    seed: string,
    edgeKind: CodeEdge["kind"],
    direction: "incoming" | "outgoing",
    limit: number,
  ): Promise<RelatedCodeNode[]> {
    const seeds = await this.resolveSeedNodes(seed, 50);
    const seedIds = edgeKind === "CALLS" && direction === "outgoing"
      ? await this.expandOutgoingCallSeedIds(seeds)
      : seeds.map((node) => node.id);
    if (seedIds.length === 0) {
      return [];
    }
    const candidateLimit = Math.max(limit * 20, 300);
    if (direction === "incoming") {
      const rows = rankRelatedRows(await this.relatedRows(`
        MATCH (node:CodeNode)-[edge:${edgeKind}]->(seed:CodeNode)
        WHERE seed.id IN ${cypherValue(seedIds)}
        ${nodeReturnClause("node")}, ${cypherValue(edgeKind)} AS edgeKind, edge.metadata AS edgeMetadata
        LIMIT ${candidateLimit}
      `), edgeKind, direction).slice(0, limit);
      if (edgeKind !== "CALLS" || seed.toLowerCase() !== "default") {
        return rows;
      }
      const exportReferenceRows = rankRelatedRows(await this.relatedRows(`
        MATCH (node:CodeNode)-[edge:RELATES]->(seed:CodeNode)
        WHERE seed.id IN ${cypherValue(seedIds)} AND edge.kind IN ['EXPORTS', 'REFERENCES']
        ${nodeReturnClause("node")}, edge.kind AS edgeKind, edge.metadata AS edgeMetadata
        LIMIT ${candidateLimit}
      `), edgeKind, direction);
      return mergeRelatedRows(rows, exportReferenceRows, limit);
    }
    return rankRelatedRows(await this.relatedRows(`
      MATCH (seed:CodeNode)-[edge:${edgeKind}]->(node:CodeNode)
      WHERE seed.id IN ${cypherValue(seedIds)}
      ${nodeReturnClause("node")}, ${cypherValue(edgeKind)} AS edgeKind, edge.metadata AS edgeMetadata
      LIMIT ${candidateLimit}
    `), edgeKind, direction).slice(0, limit);
  }

  private async expandOutgoingCallSeedIds(seeds: StoredCodeNode[]): Promise<string[]> {
    const seedIds = new Set(seeds.map((node) => node.id));
    const seedFiles = [...new Set(seeds.map((node) => node.file).filter((file): file is string => Boolean(file)))];
    if (seedFiles.length === 0) {
      return [...seedIds];
    }
    const fileRows = await this.rows(`
      MATCH (n:CodeNode)
      WHERE n.kind = 'File' AND n.file IN ${cypherValue(seedFiles)}
      RETURN n.id AS id
    `);
    for (const row of fileRows) {
      seedIds.add(String(row.id));
    }
    return [...seedIds];
  }

  async getAdjacentNodes(nodeIds: string[], limit: number): Promise<RelatedCodeNode[]> {
    if (nodeIds.length === 0 || limit <= 0) {
      return [];
    }
    const outgoing = await this.relatedRows(`
      MATCH (current:CodeNode)-[edge:RELATES]->(node:CodeNode)
      WHERE current.id IN ${cypherValue(nodeIds)}
      ${nodeReturnClause("node")}, edge.kind AS edgeKind, edge.metadata AS edgeMetadata
      LIMIT ${limit}
    `);
    const incoming = await this.relatedRows(`
      MATCH (node:CodeNode)-[edge:RELATES]->(current:CodeNode)
      WHERE current.id IN ${cypherValue(nodeIds)}
      ${nodeReturnClause("node")}, edge.kind AS edgeKind, edge.metadata AS edgeMetadata
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
    const rows: Record<string, unknown>[] = [];
    for (const edgeKind of edgeKinds) {
      const edgeRows = await this.rows(`
        MATCH (from:CodeNode)-[edge:${edgeKind}]->(to:CodeNode)
        RETURN edge.id AS id, ${cypherValue(edgeKind)} AS edgeKind, from.id AS fromId, to.id AS toId,
          from.workspace AS workspace, from.repo AS repo, edge.metadata AS metadata
      `);
      rows.push(...edgeRows);
    }
    return rows.map(rowToEdge).sort((left, right) => left.id.localeCompare(right.id));
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
    await this.createEdgeTables();
  }

  private async createEdgeTables(): Promise<void> {
    for (const edgeKind of edgeKinds) {
      await this.query(
        `CREATE REL TABLE IF NOT EXISTS ${edgeKind}(FROM CodeNode TO CodeNode, id STRING, metadata STRING)`,
      );
    }
  }

  private async createNodes(
    nodes: Iterable<CodeNode>,
    chunksById: ReadonlyMap<string, CodeNode & { content: string; embedding: number[] }>,
  ): Promise<void> {
    for (const batch of batched(nodes, 200)) {
      await this.query(`
        CREATE ${batch
          .map((node) => CodeNodeSchema.parse(node))
          .map((node) => `(:CodeNode ${cypherMap(nodeValues(node, chunksById.get(node.id)))})`)
          .join(", ")}
      `);
    }
  }

  private async createEdges(edges: Iterable<CodeEdge>): Promise<void> {
    for (const batch of batched(edges, 100)) {
      const parsedBatch = batch.map((edge) => CodeEdgeSchema.parse(edge));
      const matches = batch
        .map(
          (edge, index) =>
            `(from${index}:CodeNode {id: ${cypherValue(edge.fromId)}}), (to${index}:CodeNode {id: ${cypherValue(edge.toId)}})`,
        )
        .join(", ");
      const creates = parsedBatch
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
    const retryLimit = this.options.openRetryLimit ?? 300;
    const retryDelayMs = this.options.openRetryDelayMs ?? 100;
    for (let attempt = 0; attempt < retryLimit; attempt += 1) {
      let connection: Connection | undefined;
      let database: Database | undefined;
      try {
        database = new Database(this.databasePath);
        connection = new Connection(database);
        await connection.query("INSTALL vector; LOAD vector;");
        this.database = database;
        return connection;
      } catch (error) {
        await connection?.close().catch(() => undefined);
        await database?.close().catch(() => undefined);
        lastError = error;
        const message = String(error);
        if (
          !message.includes("Could not set lock") &&
          !message.includes("shadow file") &&
          !message.includes(".shadow")
        ) {
          throw error;
        }
        this.runtimeStats.openRetryCount += 1;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async rows(statement: string): Promise<Record<string, unknown>[]> {
    const result = await this.query(statement);
    const singleResult = Array.isArray(result) ? result[0] : result;
    try {
      return await singleResult.getAll() as Record<string, unknown>[];
    } finally {
      const results = Array.isArray(result) ? result : [result];
      for (const queryResult of results) {
        queryResult.close();
      }
    }
  }

  private async relatedRows(statement: string): Promise<RelatedCodeNode[]> {
    await this.open();
    const rows = await this.rows(statement);
    return rows.map((row) => ({
      node: rowToNode(row),
      edgeKind: CodeEdgeSchema.shape.kind.parse(row.edgeKind),
      edgeMetadata: parseMetadata(row.edgeMetadata),
    }));
  }

  private async resolveSeedNodes(
    seed: string,
    limit: number,
    includeContent = false,
  ): Promise<StoredCodeNode[]> {
    await this.open();
    const lowered = seed.toLowerCase();
    const exactRows = await this.rows(`
      MATCH (n:CodeNode)
      WHERE n.id = ${cypherValue(seed)}
      ${nodeReturnClause("n", includeContent)}
      LIMIT ${limit}
    `);
    if (exactRows.length > 0) {
      return exactRows.map(rowToNode).slice(0, limit);
    }
    const exactQualifiedRows = await this.exactQualifiedSymbolRows(seed, limit, includeContent);
    if (exactQualifiedRows.length > 0) {
      return exactQualifiedRows.map(rowToNode).slice(0, limit);
    }
    const needles = symbolNeedles(seed);
    const textMatches = symbolSearchClauses(needles, seed)
      .join(" OR ");
    const candidateLimit = Math.max(limit * 20, 300);
    const rows = await this.rows(`
      MATCH (n:CodeNode)
      WHERE n.id = ${cypherValue(seed)}
        OR (n.kind IN ${cypherValue(findableSymbolKinds)} AND (${textMatches}))
      ${nodeReturnClause("n", includeContent)}
      LIMIT ${candidateLimit}
    `);
    return dedupeSymbols(rows.map(rowToNode).sort((left, right) =>
      exactSeedRank(left, seed) - exactSeedRank(right, seed) ||
      compareSymbols(left, right, lowered)
    )).slice(0, limit);
  }

  private async exactQualifiedSymbolRows(
    seed: string,
    limit: number,
    includeContent = false,
  ): Promise<Record<string, unknown>[]> {
    if (!shouldSearchSymbolMetadata(seed)) {
      return [];
    }
    const qualifiedNeedle = `"qualifiedname":"${seed.toLowerCase()}"`;
    return this.rows(`
      MATCH (n:CodeNode)
      WHERE n.kind IN ${cypherValue(findableSymbolKinds)}
        AND lower(n.metadata) CONTAINS ${cypherValue(qualifiedNeedle)}
      ${nodeReturnClause("n", includeContent)}
      LIMIT ${limit}
    `);
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

  private async resolveDatabasePath(): Promise<string> {
    return this.options.databasePath
      ? await this.options.databasePath
      : this.resolveActiveDatabasePath();
  }

  private async acquireProcessLock(): Promise<void> {
    if (this.hasLock) {
      return;
    }
    const lockPath = this.processLockPath();
    const waitStart = performance.now();
    const timeoutMs = this.options.lockTimeoutMs ?? 30_000;
    const retryDelayMs = this.options.lockRetryDelayMs ?? 100;
    let lastError: unknown;
    while (performance.now() - waitStart <= timeoutMs) {
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
        this.runtimeStats.lockWaitMs += performance.now() - waitStart;
        return;
      } catch (error) {
        lastError = error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          throw error;
        }
        this.runtimeStats.lockContentionCount += 1;
        await recoverStaleProcessLock(lockPath);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelayMs));
      }
    }
    this.runtimeStats.lockWaitMs += performance.now() - waitStart;
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Timed out waiting for Ladybug process lock at ${lockPath}: ${reason}`);
  }

  private async releaseProcessLock(): Promise<void> {
    if (!this.hasLock) {
      return;
    }
    this.hasLock = false;
    await rm(this.processLockPath(), { recursive: true, force: true });
  }

  private processLockPath(): string {
    if (!this.databasePath) {
      throw new Error("Ladybug database path is not resolved");
    }
    return `${this.databasePath}.process.lock`;
  }
}

async function recoverStaleProcessLock(lockPath: string): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as {
      pid?: unknown;
      createdAt?: unknown;
    };
    const createdAt = typeof owner.createdAt === "string" ? Date.parse(owner.createdAt) : Number.NaN;
    const fresh = Number.isFinite(createdAt) ? Date.now() - createdAt <= staleLockAgeMs : true;
    if (typeof owner.pid === "number" && fresh && processIsAlive(owner.pid)) {
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    return false;
  }
}

function assertNoDanglingEdges(input: GraphWriteInput): void {
  for (const edge of input.edges.values()) {
    if (!input.nodes.has(edge.fromId) || !input.nodes.has(edge.toId)) {
      throw new Error(
        `Dangling edge ${edge.id} references ${edge.fromId} -> ${edge.toId}`,
      );
    }
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
    kind: String(row.edgeKind ?? row.kind),
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
  const qualifiedName = stringMetadata(node, "qualifiedName")?.toLowerCase() ?? "";
  const parentName = stringMetadata(node, "parentName")?.toLowerCase() ?? "";
  const scipBacked = node.metadata.sourcePriority === "canonical" || node.metadata.origin === "scip-typescript";
  if (qualifiedName === needle) return 0;
  if (parentName && `${parentName}.${name}` === needle) return 0;
  if (node.id.toLowerCase() === needle) return 0;
  if (name === needle && scipBacked) return 1;
  if (name === needle) return 2;
  if (qualifiedName.endsWith(`.${needle}`)) return 3;
  if (node.kind === "Function" && (name.includes(needle) || qualifiedName.includes(needle)) && scipBacked) return 4;
  if (node.kind === "Function" && (name.includes(needle) || qualifiedName.includes(needle))) return 5;
  if (name.startsWith(needle) || qualifiedName.includes(needle)) return 6;
  return 6;
}

function compareSymbols(left: CodeNode, right: CodeNode, needle: string): number {
  return symbolRank(left, needle) - symbolRank(right, needle) ||
    symbolTieRank(left) - symbolTieRank(right) ||
    (left.file ?? "").localeCompare(right.file ?? "") ||
    (left.name ?? "").localeCompare(right.name ?? "") ||
    left.id.localeCompare(right.id);
}

function exactSeedRank(node: CodeNode, seed: string): number {
  return node.id === seed ? 0 : 1;
}

function symbolTieRank(node: CodeNode): number {
  let rank = 100;
  if (node.metadata.fileKind === "source") rank -= 20;
  if (node.metadata.fileKind === "test") rank += 20;
  if (node.metadata.sourcePriority === "canonical") rank -= 15;
  if (node.metadata.exported === true) rank -= 10;
  const scipSymbol = stringMetadata(node, "scipSymbol");
  if (scipSymbol?.startsWith("scip-typescript npm ")) rank -= 8;
  if (scipSymbol?.startsWith("local ")) rank += 8;
  if (node.kind === "Function" || node.kind === "Class") rank -= 4;
  if (node.kind === "Symbol") rank -= 2;
  if (node.kind === "Export") rank += 4;
  return rank;
}

function symbolNeedles(value: string): string[] {
  const lowered = value.toLowerCase();
  const parts = lowered
    .split(/[^a-z0-9_$]+/)
    .filter((part) => part.length > 0);
  return [...new Set([lowered, ...parts, parts.at(-1) ?? ""])].filter((part) => part.length > 0);
}

function symbolSearchClauses(needles: string[], raw: string): string[] {
  const includeMetadata = shouldSearchSymbolMetadata(raw);
  return needles.map((term) =>
    includeMetadata
      ? `(lower(n.name) CONTAINS ${cypherValue(term)} OR lower(n.metadata) CONTAINS ${cypherValue(term)})`
      : `lower(n.name) CONTAINS ${cypherValue(term)}`
  );
}

function shouldSearchSymbolMetadata(value: string): boolean {
  const lowered = value.toLowerCase();
  return /[./:@#`]/.test(lowered);
}

function dedupeSymbols(nodes: CodeNode[]): CodeNode[] {
  const seen = new Set<string>();
  const deduped: CodeNode[] = [];
  for (const node of nodes) {
    const key = [
      node.file ?? "",
      node.name ?? "",
      stringMetadata(node, "qualifiedName") ?? node.name ?? "",
    ].join("\0");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(node);
  }
  return deduped;
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

function stringMetadataValue(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
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

function* batched<T>(items: Iterable<T>, size: number): Iterable<T[]> {
  let batch: T[] = [];
  for (const item of items) {
    batch.push(item);
    if (batch.length >= size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) {
    yield batch;
  }
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

function rankRelatedRows(
  rows: RelatedCodeNode[],
  edgeKind: CodeEdge["kind"],
  direction: "incoming" | "outgoing",
): RelatedCodeNode[] {
  const ranked = [...rows].sort((left, right) =>
    relatedRowRank(left, edgeKind, direction) - relatedRowRank(right, edgeKind, direction) ||
    (left.node.file ?? "").localeCompare(right.node.file ?? "") ||
    (left.node.name ?? "").localeCompare(right.node.name ?? ""),
  );
  const deduped: RelatedCodeNode[] = [];
  const seen = new Set<string>();
  for (const row of ranked) {
    const dedupeKey = relatedRowDedupeKey(row, edgeKind, direction);
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    deduped.push(row);
  }
  return deduped;
}

function relatedRowDedupeKey(
  row: RelatedCodeNode,
  edgeKind: CodeEdge["kind"],
  direction: "incoming" | "outgoing",
): string {
  if (edgeKind === "CALLS" && direction === "incoming" && row.node.file && row.node.name) {
    return `symbol:${row.node.file}:${row.node.name}`;
  }
  if (edgeKind === "REFERENCES" && direction === "incoming" && row.node.file) {
    return `file:${row.node.file}`;
  }
  return row.node.id;
}

function relatedRowRank(
  row: RelatedCodeNode,
  edgeKind: CodeEdge["kind"],
  direction: "incoming" | "outgoing",
): number {
  let rank = 100;
  if (edgeKind === "CALLS" && direction === "outgoing") {
    const moduleSpecifier = stringMetadataValue(row.edgeMetadata, "moduleSpecifier");
    if (moduleSpecifier && !moduleSpecifier.startsWith(".")) rank -= 40;
    if (row.node.kind === "Function" || row.node.kind === "Class") rank -= 20;
    if (row.node.kind === "Symbol") rank -= 10;
    if (row.edgeMetadata.confidence === "high") rank -= 8;
    if (Array.isArray(row.edgeMetadata.evidenceSources) && row.edgeMetadata.evidenceSources.includes("scip-typescript")) {
      rank -= 5;
    }
    if (
      row.edgeMetadata.relationship === "transitive-call" ||
      metadataArrayIncludes(row.edgeMetadata.evidenceSources, "transitive-call")
    ) {
      rank += 25;
    }
    if (moduleSpecifier?.startsWith(".")) rank += 10;
  }
  if (edgeKind === "CALLS" && direction === "incoming") {
    const path = row.node.file ?? "";
    if (row.node.metadata.fileKind === "source") rank -= 18;
    if (row.node.metadata.fileKind === "test") rank += 18;
    if (row.node.kind === "Function" || row.node.kind === "Chunk") rank -= 16;
    if (row.node.kind === "File") rank += 4;
    if (path.includes("/api-core/")) rank -= 16;
    if (path.includes("/routes/")) rank -= 12;
    if (path.includes("/database/")) rank -= 10;
    if (path.includes("/scripts/")) rank += 28;
    if (path.includes("/billing/")) rank += 24;
    if (row.edgeMetadata.confidence === "high") rank -= 8;
    if (metadataArrayIncludes(row.edgeMetadata.evidenceSources, "module-resolution")) rank -= 10;
    if (metadataArrayIncludes(row.edgeMetadata.evidenceSources, "scip-typescript")) rank -= 6;
    if (metadataArrayIncludes(row.edgeMetadata.evidenceSources, "mutation-to-database")) rank -= 12;
    if (metadataArrayIncludes(row.edgeMetadata.evidenceSources, "graph-transitive-call")) rank -= 4;
  }
  if (edgeKind === "REFERENCES" && direction === "incoming") {
    const path = row.node.file ?? "";
    const isCallUsage = metadataArrayIncludes(row.edgeMetadata.roles, "Call");
    if (row.node.metadata.fileKind === "source") rank -= 18;
    if (row.node.metadata.fileKind === "test") rank += 18;
    if (row.node.kind === "Function" || row.node.kind === "Chunk") rank -= 14;
    if (row.node.kind === "File") rank += isCallUsage ? -10 : 18;
    if (isCallUsage) rank -= 18;
    if (row.edgeMetadata.confidence === "high") rank -= 8;
    if (metadataArrayIncludes(row.edgeMetadata.evidenceSources, "scip-typescript")) rank -= 6;
    if (metadataArrayIncludes(row.edgeMetadata.evidenceSources, "module-resolution")) rank -= 22;
    if (metadataArrayIncludes(row.edgeMetadata.evidenceSources, "tree-sitter-import")) rank -= 6;
    if (metadataArrayIncludes(row.edgeMetadata.roles, "Import") && !isCallUsage) rank += 4;
    if (row.edgeMetadata.scipRange) rank -= 4;
    if (path.includes("/api-core/")) rank -= 10;
    if (path.includes("/routes/")) rank -= 6;
    if (path.includes("/scripts/")) rank += 28;
    if (path.includes("/billing/")) rank += 24;
  }
  return rank;
}

function metadataArrayIncludes(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.includes(expected);
}
