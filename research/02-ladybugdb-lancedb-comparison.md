---
title: LadybugDB And LanceDB Comparison
feature: code-intelligence-graph
created: 2026-05-13
last_updated: 2026-05-13
status: draft
---

# LadybugDB And LanceDB Comparison

This note compares LadybugDB native vector search with LanceDB for the local JS/TS code intelligence graph.

## Decision

Use **LadybugDB as the single local graph and vector database** for the first implementation.

Use **LanceDB as a fallback only** if local validation proves LadybugDB vector search is insufficient for performance, filtering, metadata storage, or Node API ergonomics.

## Why Single Database Wins

The code intelligence model is naturally graph-first:

```text
(:Package)-[:EXPORTS]->(:Symbol)
(:File)-[:DEFINES]->(:Symbol)
(:Symbol)-[:CALLS]->(:Symbol)
(:Test)-[:TESTS]->(:Symbol)
(:Chunk {embedding})-[:DESCRIBES]->(:Symbol)
```

Semantic search should return graph nodes that can immediately expand to callers, callees, imports, exports, tests, and packages. LadybugDB supports this directly because vector search returns `node` and `distance`, and the result can continue through graph traversal in the same Cypher query.

Keeping vectors in LanceDB would require a join layer:

```text
LanceDB result node_id
  -> query graph DB for node
  -> expand graph neighbors
  -> fetch source context
```

That split is workable, but it adds synchronization, duplicated metadata, stale-record risk, and more code paths for MCP tools.

## LadybugDB Findings

Sources:

- [LadybugDB GitHub](https://github.com/LadybugDB/ladybug)
- [LadybugDB Node.js API](https://docs.ladybugdb.com/client-apis/nodejs/)
- [LadybugDB get started](https://docs.ladybugdb.com/get-started/)
- [LadybugDB extensions](https://docs.ladybugdb.com/extensions/)
- [LadybugDB vector extension](https://docs.ladybugdb.com/extensions/vector/)

Relevant facts:

- LadybugDB is an embedded graph database and the active community successor fork of Kuzu.
- It is MIT licensed.
- It has a Node package: `@ladybugdb/core`.
- It supports on-disk databases when a path is passed to `new lbug.Database("example.lbug")`.
- It uses a property graph model with typed node and relationship tables.
- It uses Cypher.
- The vector extension provides native disk-based HNSW vector indexes.
- Vector indexes are currently supported for vectors stored as node table properties.
- Vector properties must be an array of `FLOAT` or `DOUBLE`.
- `CREATE_VECTOR_INDEX` creates the index.
- `QUERY_VECTOR_INDEX` returns `node` and `distance`.
- Ladybug docs show continuing graph traversal from the vector-search result node in the same query.
- The `vector` extension is listed as a commonly used official extension and must be loaded for the session when needed.

Implementation shape:

```ts
const lbug = require("@ladybugdb/core");

const db = new lbug.Database(".code-intel/code-intel.lbug");
const conn = new lbug.Connection(db);

await conn.query("LOAD vector;");
await conn.query(`
  CREATE NODE TABLE Chunk(
    id STRING PRIMARY KEY,
    repo STRING,
    packageName STRING,
    file STRING,
    startLine INT64,
    endLine INT64,
    kind STRING,
    textHash STRING,
    embeddingModel STRING,
    embedding FLOAT[<embedding-dimension>]
  )
`);

await conn.query(`
  CALL CREATE_VECTOR_INDEX(
    'Chunk',
    'chunk_embedding_index',
    'embedding',
    metric := 'cosine'
  );
`);
```

Semantic search shape:

```cypher
CALL QUERY_VECTOR_INDEX(
  'Chunk',
  'chunk_embedding_index',
  $query_vector,
  $limit,
  efs := 200
)
WITH node AS chunk, distance
MATCH (chunk)-[:DESCRIBES]->(symbol:Symbol)
RETURN chunk.id, symbol.id, distance
ORDER BY distance;
```

## LanceDB Findings

Sources:

- [LanceDB Quickstart](https://docs.lancedb.com/quickstart)
- [LanceDB FAQ](https://docs.lancedb.com/faq/faq-oss)
- [LanceDB GitHub](https://github.com/lancedb/lancedb)

Relevant facts:

- LanceDB OSS is Apache 2.0.
- It is embedded and runs in process.
- It has a TypeScript package: `@lancedb/lancedb`.
- It supports local filesystem paths.
- It supports vector search, full-text search, hybrid search, filtering, indexing, and metadata storage.
- It is purpose-built for vector retrieval and is likely stronger than Ladybug if vector-only performance or query ergonomics become the bottleneck.

Why it is not selected first:

- It would be a second local database.
- It would duplicate chunk metadata that already belongs on graph nodes.
- It would require a join from vector result IDs into the graph database.
- It adds freshness and cleanup complexity during reindexing.
- It weakens the clean MCP flow where semantic search returns expandable graph nodes directly.

## Comparison

| Criterion | LadybugDB | LanceDB |
| --- | --- | --- |
| Local embedded | Yes | Yes |
| Node package | `@ladybugdb/core` | `@lancedb/lancedb` |
| License | MIT | Apache 2.0 |
| Graph model | Native property graph | No |
| Query language | Cypher | Vector/table API |
| On-disk persistence | Yes | Yes |
| Vector search | Native disk-based HNSW extension | Core strength |
| Full-text search | Official `fts` extension | Supported |
| One DB for graph and vector | Yes | No |
| Best role | Code graph plus semantic search | Dedicated vector fallback |
| First implementation | Selected | Not selected |

## Validation Required

Before implementation confidence, verify:

- `@ladybugdb/core` installs cleanly on local macOS arm64 and GitHub Actions Ubuntu.
- On-disk `.lbug` databases persist and reopen cleanly.
- The `vector` extension loads from Node.
- The selected embedding dimension is accepted in Ladybug node-table array types.
- `CREATE_VECTOR_INDEX` works against `Chunk.embedding`.
- `QUERY_VECTOR_INDEX` returns correct ranked chunk nodes.
- Vector results can continue into graph traversal in the same query.
- Reindexing can upsert changed chunks without stale duplicates.
- Performance is acceptable on fixture repos and selected `js-monorepo` packages as the first real proof-of-concept corpus.

## Fallback Rule

Do not introduce LanceDB unless at least one of these fails in a way we cannot reasonably work around:

- Ladybug vector extension cannot run reliably in Node or CI.
- Ladybug vector search is materially too slow on the indexed code corpus.
- Ladybug cannot support the embedding dimension we need.
- Ladybug cannot support required filtering or graph expansion from semantic results.
- Ladybug reindexing or cleanup is too brittle for local agent workflows.

If fallback is needed, use LanceDB only for vectors and keep LadybugDB as the graph source of truth. Stable node IDs remain the join contract.
