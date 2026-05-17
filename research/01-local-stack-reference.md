---
title: Local Stack Reference
feature: code-intelligence-graph
created: 2026-05-13
last_updated: 2026-05-13
status: draft
---

# Local Stack Reference

This note captures the current upstream usage references checked before the first feature spec was written. It should be refreshed before implementation if package versions or APIs change.

## SCIP

Source: [SCIP Code Intelligence Protocol](https://scip-code.org/)

Relevant definition:

- SCIP is a language-agnostic protocol for indexing source code.
- It powers code navigation functions such as go to definition and find references.
- It standardizes the index format emitted by language-specific indexers.

Role in this feature:

- SCIP is the precise code intelligence format.
- We ingest SCIP data into our graph.
- SCIP is not the graph database and not the MCP server.

## scip-typescript

Source: [sourcegraph/scip-typescript](https://github.com/sourcegraph/scip-typescript)

Current upstream usage:

```bash
npm install -g @sourcegraph/scip-typescript
scip-typescript index
scip-typescript index --infer-tsconfig
scip-typescript index --yarn-workspaces
scip-typescript index --pnpm-workspaces
```

Usage notes from upstream:

- Navigate to a TypeScript project root containing `tsconfig.json`, install dependencies, then run `scip-typescript index`.
- For JavaScript projects, navigate to a project root containing `package.json`, install dependencies, then run `scip-typescript index --infer-tsconfig`.
- Yarn workspaces can be indexed with `--yarn-workspaces`.
- pnpm workspaces can be indexed with `--pnpm-workspaces`.
- Current documented supported Node versions are Node 18 and Node 20.
- For large codebases, upstream documents `--no-global-caches` and `node --max-old-space-size=...` as OOM mitigations.

Feature usage:

- Run under Node 20 because the rest of the local toolchain and MCP runtime should standardize on a current Node LTS-compatible floor.
- Preserve raw `.scip` files under `.code-intel/scip/`.
- Parse definitions, references, occurrences, documents, symbols, and ranges into the graph schema.

## Tree-sitter

Sources:

- [Tree-sitter Introduction](https://tree-sitter.github.io/tree-sitter/)
- [node-tree-sitter](https://github.com/tree-sitter/node-tree-sitter)
- [tree-sitter-typescript](https://github.com/tree-sitter/tree-sitter-typescript)
- [tree-sitter-javascript](https://github.com/tree-sitter/tree-sitter-javascript)

Relevant definition:

- Tree-sitter is a parser generator and incremental parsing library.
- It builds concrete syntax trees and can update trees efficiently as source changes.
- It is designed to be fast, robust in the presence of syntax errors, and embeddable.

Current upstream Node usage:

```bash
npm install tree-sitter
npm install tree-sitter-javascript
npm install tree-sitter-typescript
```

Example shape:

```js
const Parser = require("tree-sitter");
const JavaScript = require("tree-sitter-javascript");

const parser = new Parser();
parser.setLanguage(JavaScript);
const tree = parser.parse("let x = 1;");
```

Feature usage:

- Use Tree-sitter for syntax-aware chunking and fallback structure.
- Use JavaScript grammar for `.js`, `.jsx`, `.mjs`, and `.cjs`.
- Use TypeScript grammar for `.ts`, `.tsx`, `.mts`, and `.cts`.
- Link chunks to SCIP symbols by overlapping file ranges.

## LadybugDB

Sources:

- [LadybugDB GitHub](https://github.com/LadybugDB/ladybug)
- [LadybugDB installation](https://docs.ladybugdb.com/installation/)
- [LadybugDB get started](https://docs.ladybugdb.com/get-started/)
- [LadybugDB Node.js API](https://docs.ladybugdb.com/client-apis/nodejs/)
- [LadybugDB extensions](https://docs.ladybugdb.com/extensions/)
- [LadybugDB vector extension](https://docs.ladybugdb.com/extensions/vector/)

Relevant definition:

- LadybugDB is an embedded graph database and the community-centric successor fork of Kuzu.
- LadybugDB is optimized for query speed and scalability over large graphs.
- It uses a property graph model and Cypher.
- It supports on-disk mode when a database path is provided.
- On-disk mode persists data to the path, uses a write-ahead log, and checkpoints updates into database files.
- The Node package is `@ladybugdb/core`.
- The Node API provides `Database` and `Connection`.
- The async Node API is the normal path for applications.
- The vector extension provides native disk-based HNSW vector indexes over 32-bit and 64-bit float arrays stored in Ladybug.
- Vector indexes are currently supported for vectors stored as node table properties.
- `QUERY_VECTOR_INDEX` returns a graph `node` plus `distance`, and Ladybug docs show continuing graph traversal from that result in the same Cypher query.

Current upstream usage:

```bash
npm install @ladybugdb/core
```

```js
const lbug = require("@ladybugdb/core");

const db = new lbug.Database(".code-intel/code-intel.lbug");
const conn = new lbug.Connection(db);

await conn.query("CREATE NODE TABLE Symbol(id STRING PRIMARY KEY, name STRING)");
await conn.query("CREATE NODE TABLE Chunk(id STRING PRIMARY KEY, embedding FLOAT[<embedding-dimension>])");

await conn.query("LOAD vector;");
await conn.query(`
  CALL CREATE_VECTOR_INDEX(
    'Chunk',
    'chunk_embedding_index',
    'embedding',
    metric := 'cosine'
  );
`);
```

License and package notes:

- LadybugDB repository is MIT licensed.
- `@ladybugdb/core` npm package reports MIT.
- Latest checked npm version: `0.16.1`.

Feature usage:

- Use as the first local graph and vector database.
- Store graph data under `.code-intel/code-intel.lbug`.
- Create typed node tables for repos, packages, files, symbols, chunks, and tests.
- Create typed relationship tables for imports, exports, definitions, references, calls, package dependencies, chunks, and test coverage.
- Store chunk embeddings as node properties.
- Use the native vector extension for semantic search.
- Use Cypher for graph traversal and for combining semantic search with graph expansion.

## CozoDB Rejection

Sources:

- [CozoDB docs](https://docs.cozodb.org/)
- [cozodb/cozo](https://github.com/cozodb/cozo)
- [cozo-node README](https://github.com/cozodb/cozo/blob/main/cozo-lib-nodejs/README.md)

Rejection reason:

- CozoDB was a reasonable replacement after FalkorDBLite was rejected because it is embedded, graph-capable, and permissively licensed enough for this local tool.
- CozoDB uses Datalog-style CozoScript rather than a property graph and Cypher model.
- The code intelligence domain maps more naturally to a property graph.
- LadybugDB is a better fit because it is the active Kuzu successor, MIT licensed, embedded, Node-compatible, Cypher-based, and has native vector search.
- CozoDB remains a possible fallback if LadybugDB fails local validation.

## FalkorDBLite Rejection

Sources:

- [FalkorDBLite TypeScript docs](https://docs.falkordb.com/operations/falkordblite/falkordblite-ts.html)
- [FalkorDB license docs](https://docs.falkordb.com/References/license.html)

Rejection reason:

- FalkorDBLite is technically attractive for a local Node graph store, but FalkorDB core is SSPLv1.
- SSPL is the wrong default for tooling that may become public or widely reusable.
- The feature now uses LadybugDB instead.

## LanceDB Fallback

Sources:

- [LanceDB Quickstart](https://docs.lancedb.com/quickstart)
- [LanceDB FAQ](https://docs.lancedb.com/faq/faq-oss)
- [LanceDB GitHub](https://github.com/lancedb/lancedb)

Relevant definition:

- LanceDB OSS is an embedded database that runs in process.
- It supports local filesystem paths.
- It supports vector search, full-text search, hybrid search, filtering, indexing, and metadata storage.
- LanceDB OSS is Apache 2.0.

Current TypeScript package:

```bash
npm install @lancedb/lancedb
```

Feature usage:

- LanceDB is not selected for the first implementation.
- Keep it as a fallback if LadybugDB vector search fails local validation.
- If fallback is required, store vector data under `.code-intel/lancedb`.
- If fallback is required, store node IDs, repo, package, file, range, symbol metadata, content hashes, and embedding model version with each vector.
- If fallback is required, semantic results join back to Ladybug graph nodes through stable node IDs.

## Transformers.js

Source: [Transformers.js docs](https://huggingface.co/docs/transformers.js/)

Relevant definition:

- Transformers.js runs Hugging Face transformer models in JavaScript using ONNX Runtime.
- It supports Node.js and browser usage.
- The `pipeline` API supports feature extraction.

Current usage shape:

```bash
npm install @huggingface/transformers
```

```ts
import { pipeline } from "@huggingface/transformers";

const extractor = await pipeline(
  "feature-extraction",
  "jinaai/jina-embeddings-v2-base-code",
);

const output = await extractor("function useWallet() {}", {
  pooling: "mean",
  normalize: true,
});
```

Feature usage:

- Use local model execution for embeddings.
- Cache model files locally where possible.
- Surface model-cache status in `code-intel health`.

## Jina Code Embedding Model

Source: [jinaai/jina-embeddings-v2-base-code](https://huggingface.co/jinaai/jina-embeddings-v2-base-code)

Relevant model facts from the model card:

- The model supports Transformers.js.
- License is Apache 2.0.
- It is a code embedding model intended for technical question answering and code search.
- It supports JavaScript and TypeScript among other languages.
- It supports long sequence lengths through the Jina embeddings v2 architecture.
- The model card recommends mean pooling when integrating manually.

Feature usage:

- Use as the first local embedding model.
- Use mean pooling and normalized vectors.
- Store model ID and embedding dimensions on Ladybug chunk nodes.

## ripgrep

Source: [BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep)

Feature usage:

- Use `rg --json` for exact text search.
- Do not replace system `grep`.
- Do not make MCP a grep wrapper.
- Use exact search results as structured pointers that can be combined with graph data.

Expected command shape:

```bash
rg --json --hidden --glob '!node_modules' --glob '!dist' "createWallet" <repo>
```

## Commander

Source: [tj/commander.js](https://github.com/tj/commander.js)

Relevant definition:

- Commander is a Node.js command-line interface framework.
- It supports options, arguments, subcommands, automated help, async parsing, and TypeScript usage.
- It can create a local `Command` instance instead of relying on a global command object.

Feature usage:

- Use Commander for the `code-intel` command tree.
- Keep command actions thin and delegate behavior to core modules.
- Create the command tree through a factory such as `createCliProgram()` for parser unit tests.
- Use async action handlers and parse with `parseAsync`.
- Keep output formatting in presenter functions so command tests can cover text, JSON, TTY, and non-TTY behavior separately.

## CLI Process Test Harness

Sources:

- [Vitest guide](https://vitest.dev/guide/)
- [sindresorhus/execa](https://github.com/sindresorhus/execa)
- [Node.js child_process documentation](https://nodejs.org/api/child_process.html)

Relevant definition:

- Vitest is the first test runner for the package.
- Execa is built on Node `child_process` and is designed for programmatic process execution.
- Node `spawn` supports stdio pipe, inherit, ignore, and stream configurations.

Feature usage:

- Use Vitest for unit tests, fixture tests, integration tests, query tests, CLI tests, MCP tests, and eval tests.
- Use Execa for normal CLI process tests where the test needs stdout, stderr, exit code, timeout, and environment control.
- Use lower-level Node `child_process` only when Execa hides behavior that a protocol or stdio test needs to assert directly.
- Run MCP validation with stdio pipes because MCP stdio clients launch the server as a child process and communicate over stdin/stdout.

## TTY Test Harness

Source: [microsoft/node-pty](https://github.com/microsoft/node-pty)

Relevant definition:

- `node-pty` provides pseudoterminal file descriptors for Node.js.
- It is useful when a child program must believe it is connected to a terminal.
- It supports macOS, Linux, and Windows through ConPTY on supported Windows versions.

Feature usage:

- Use `node-pty` as a dev-only dependency for TTY-specific CLI tests.
- Cover `process.stdout.isTTY`, terminal width handling, color/progress behavior, and signal behavior only when those behaviors exist.
- Do not use PTY for MCP tests. MCP stdio is protocol traffic over ordinary pipes, not terminal interaction.

## MCP TypeScript SDK

Sources:

- [MCP SDKs](https://modelcontextprotocol.io/docs/sdk)
- [Build an MCP server](https://modelcontextprotocol.io/docs/develop/build-server)
- [MCP TypeScript SDK server docs](https://ts.sdk.modelcontextprotocol.io/documents/server.html)

Relevant definition:

- MCP provides a standard way to expose tools, resources, and prompts to LLM clients.
- The TypeScript SDK is listed as a Tier 1 official SDK.
- The common TypeScript server shape uses `McpServer` and `StdioServerTransport`.

Current TypeScript setup shape:

```bash
npm install @modelcontextprotocol/sdk zod
npm install -D typescript @types/node
```

Server shape:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "code-intel",
  version: "0.1.0",
});

server.registerTool(
  "health",
  {
    description: "Return code intelligence index health.",
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: true }),
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

Operational note:

- In stdio mode, do not write logs to stdout because stdout carries JSON-RPC messages.
- Use stderr or log files for server diagnostics.

Feature usage:

- Implement `code-intel mcp`.
- Expose bounded structured tools.
- Return JSON payloads with stable schemas.
