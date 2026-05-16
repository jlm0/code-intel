---
title: Code Intelligence Graph Feature Spec
feature: code-intelligence-graph
created: 2026-05-13
last_updated: 2026-05-16
status: active
---

# Code Intelligence Graph Feature Spec

## Purpose

Build a local-first JavaScript and TypeScript code intelligence CLI with a built-in MCP server. The tool should index one or more local JS/TS repositories, persist a code relationship graph, persist a semantic vector index, and expose structured query tools that LLM agents can consume.

The product direction is general-purpose JS/TS repository intelligence. The first proof-of-concept consumer is our local Codex workflow over Para repositories, but the tool should be designed so it can later move into its own dedicated repository and be reused across other JS/TS workspaces.

The purpose is broader than docs accuracy and broader than Para: improve agent search, repo orientation, debugging, impact analysis, context gathering, and eventually docs validation by giving agents a durable map of symbols, packages, files, imports, exports, references, chunks, tests, and semantic entrypoints.

## Product Boundary

This is a JS/TS-only tool. It is not a general multi-language indexer in the first version.

Supported source surfaces:

- `.ts`
- `.tsx`
- `.js`
- `.jsx`
- `.mts`
- `.cts`
- `.mjs`
- `.cjs`
- `package.json`
- `tsconfig.json`
- `jsconfig.json`

First proof-of-concept workspace:

```text
/Users/jordy/Documents/GitHub/capsule-org
```

First proof-of-concept validation repos:

- `js-monorepo`
- `user-management`
- later `docs-mintlify` only as a consumer surface, not as the first target

These repos validate the first implementation against real Para code. They are not the product boundary.

## Exact Stack

The stack is locked for the first design iteration.

| Layer | Tool | Role |
| --- | --- | --- |
| Runtime | Node.js 20+ and TypeScript | CLI, orchestrator, MCP server, parsers, and storage clients. |
| Build output | TypeScript compiler to `dist/` | Keep the first package build simple and avoid bundling native database, parser, or PTY bindings. |
| CLI command framework | `commander` | Subcommands, help output, async action handlers, strict option parsing, and a testable command factory. |
| Precise code index | `@sourcegraph/scip-typescript` | Compiler-aware JS/TS definitions, references, and symbol occurrence index. |
| Syntax parser | `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-javascript` | Syntax-aware chunks, fallback structure, function/class/component ranges, and robust parsing of partially broken code. |
| Graph and vector database | `@ladybugdb/core` | Embedded local property graph database with Cypher, on-disk persistence, full-text search, and native disk-based HNSW vector indexes. |
| Embeddings | `@huggingface/transformers` with `jinaai/jina-embeddings-v2-base-code` | Local code embeddings for natural-language-to-code retrieval. |
| Exact search | `ripgrep` via `rg --json` | Deterministic lexical search used by CLI commands and as a query-engine fallback. |
| Agent interface | `@modelcontextprotocol/sdk` | MCP stdio server exposing bounded structured code intelligence tools. |
| Schema validation | `zod` | Runtime validation for index records, MCP inputs, MCP outputs, and artifact versions. |
| Test runner | `vitest` | Unit, fixture, integration, schema, CLI, MCP, and eval tests. |
| Process test harness | `execa` plus Node `child_process` where lower-level control is needed | Spawn the CLI with stdio pipes, assert exit codes, stdout, stderr, timeouts, and MCP JSON-RPC behavior. |
| TTY test harness | `node-pty` as a dev dependency | Validate TTY-only CLI behavior such as `isTTY`, color, progress rendering, width handling, and signal behavior. |

## Why These Tools

`scip-typescript` is the precise layer. It uses TypeScript project understanding to produce SCIP code navigation data. It should own definition, reference, and symbol occurrence facts.

Tree-sitter is the syntax layer. It should own chunk boundaries and structural extraction where exact compiler indexing is too narrow or unavailable.

LadybugDB through `@ladybugdb/core` is the graph and vector database. It gives a local embedded property graph with Cypher, strongly typed node and relationship tables, on-disk persistence, full-text search, and native disk-based HNSW vector indexes over node properties. SQLite is intentionally not part of the first stack because this feature is testing a graph database, not relational tables shaped like a graph. LanceDB is not selected for the first implementation because keeping graph and vector data in one local database is simpler and maps naturally to code chunks as graph nodes with embedding properties.

Jina code embeddings through Transformers.js provide local semantic retrieval without calling a hosted embedding API. The model can be cached locally after first download.

MCP is the agent interface. It is not the intelligence layer. It exposes the query engine to Codex, Claude Code, Cursor, or any other MCP-compatible agent.

Commander is the human CLI command framework. Command actions should be thin adapters that parse options and call the core library. The command tree should be created through a factory such as `createCliProgram()` so tests can exercise parsing without invoking process globals.

The package should emit compiled JavaScript with `tsc` and expose `code-intel` through the `package.json` `bin` field. Avoid bundling in the first implementation because LadybugDB, Tree-sitter, and PTY dependencies may rely on native bindings or runtime file layout.

Vitest is the primary test runner. Use Execa for normal CLI process tests because those tests need pipes, exit codes, stdout, stderr, and timeouts. Use `node-pty` only for TTY-specific CLI behavior. Do not run MCP stdio tests through a PTY.

## Non-Goals

- Do not support Go, Swift, Dart, Python, Rust, or Java in the first version.
- Do not build a hosted service.
- Do not require a hosted vector database or graph database.
- Do not call OpenAI, Anthropic, Jina API, or any remote embedding API during normal indexing.
- Do not replace `rg` globally or symlink `grep` to `rg`.
- Do not make MCP a wrapper around grep.
- Do not make docs accuracy the first implementation target.
- Do not build custom parsers, custom vector storage, or custom graph storage.

## Local Artifact Layout

Generated files should live outside child repos:

```text
/Users/jordy/Documents/GitHub/capsule-org/.code-intel/
  manifest.json
  workspace.json
  scip/
    <repo>.scip
  code-intel.lbug/
  generations/
    <generation-id>/
      manifest.json
      workspace.json
      facts/
        files.json
        embeddings.json
        scip.json
        resolution.json
      code-intel.lbug/
  current.json
  models/
  cache/
  logs/
  eval/
```

The tool source should live outside child repos while this remains local operator tooling:

```text
/Users/jordy/Documents/GitHub/capsule-org/local-tools/code-intel/
```

If the proof of concept is successful, this source should move into a dedicated code intelligence repository so it can be maintained and reused across non-Para projects.

## Core Data Model

The graph model should use stable IDs that are portable across CLI, graph DB, vector DB, and MCP responses.

Stable ID format:

```text
<kind>:<workspace>:<repo>@<commit>:<relative-path>#<symbol-or-range>
```

Primary node kinds:

- `Workspace`
- `Repo`
- `Package`
- `File`
- `Module`
- `Symbol`
- `Function`
- `Class`
- `Interface`
- `TypeAlias`
- `Import`
- `Export`
- `Callsite`
- `Chunk`
- `Test`

Primary edge kinds:

- `CONTAINS`
- `DEFINES`
- `IMPORTS`
- `EXPORTS`
- `REFERENCES`
- `CALLS`
- `EXTENDS`
- `IMPLEMENTS`
- `DEPENDS_ON`
- `HAS_CHUNK`
- `TESTS`
- `MENTIONS`

LadybugDB owns relationship traversal, full-text lookup, and vector similarity over code chunk nodes. The CLI and MCP layer use the same stable node IDs for graph and semantic results.

Tree-sitter file facts are generation-local and reusable by incremental indexing. Each file fact now carries chunks plus structured static imports, dynamic imports, CommonJS imports, exports, CommonJS exports, re-exports, declarations, decorators, constructor calls, function calls, member calls, JSX component usage, member accesses, parent/child ownerships, test cases, callbacks, stable ranges, source hashes, owner file, and containing chunk provenance. Structural facts are persisted in `facts/files.json` with their own facts schema version. Chunk vectors are persisted separately in `facts/embeddings.json` so the structural fact cache stays readable and does not grow around embedded vector arrays.

SCIP facts are also generation-local. Normalized compiler facts are persisted in `facts/scip.json` with `factsSchemaVersion: code-intel.scip-facts.v1`. The raw SCIP role mask is preserved, unmarked references from `scip-typescript` are normalized as read references, and import/test role evidence is derived during AST/SCIP fusion when the syntax facts provide the missing source context. SCIP-backed definitions promote matching Tree-sitter declaration nodes into canonical symbols instead of duplicating a second AST and SCIP symbol for the same definition. SCIP-backed `REFERENCES`, `CALLS`, `IMPORTS`, `EXPORTS`, `TESTS`, and `MENTIONS` edges carry relationship evidence metadata. Tree-sitter name matching is now a labeled fallback path when SCIP fails or when SCIP succeeds but omits a target definition.

Resolved module facts are generation-local. The fusion layer persists `facts/resolution.json` with `factsSchemaVersion: code-intel.resolved-facts.v1`. These facts record resolved modules, package export entries, import bindings, export bindings, CommonJS bindings, dynamic import status, target files, target packages, target symbols where known, unresolved status, and fallback reasons. TypeScript-compatible module resolution owns relative paths, `tsconfig` or `jsconfig` path aliases, package names, package `exports` and `imports` maps, re-exports, default imports, named imports, namespace imports, dynamic imports, and CommonJS cases where they are statically resolvable.

The graph writes first-class `Import` and `Export` nodes with owning-file edges. It also creates declaration-backed symbol nodes for non-chunk AST declarations so exported variables, database clients, middleware values, and route aliases can be graph targets. SCIP fusion owns canonical symbol identity and references when compiler facts exist. AST facts preserve syntax detail, ranges, source text hashes, import/export specifiers, member paths, containing chunks, and test context. Fusion combines both evidence sources into `IMPORTS`, `EXPORTS`, `REFERENCES`, `CALLS`, `TESTS`, and `MENTIONS` edges with confidence, owner file, containing chunk, SCIP evidence, AST evidence, module resolution evidence, local/exported names, member path, and fallback reason. Unresolved and dynamic cases are marked explicitly instead of guessed.

Graph edge meanings must stay consistent:

- `IMPORTS` means a file or import node imports a resolved file, package, or symbol.
- `EXPORTS` means a file, export node, or package exposes a resolved file or symbol.
- `REFERENCES` means source code refers to a target symbol, file, layout, or module target with evidence metadata.
- `CALLS` means observed call evidence exists from SCIP or AST call facts. An import alone must not create `CALLS`.
- `TESTS` means a test file or test chunk references, imports, or calls an implementation target with test-context evidence.
- `MENTIONS` means weaker local mention evidence and should rank below compiler, resolver, import, export, call, and test evidence.

Graph traversal must be typed and evidence-aware. Traversal APIs should accept allowed edge kinds, direction, max depth, evidence requirements, confidence and fallback rules, and return ordered path nodes with edge metadata. Path output should include edge kind, owner file, range, evidence sources, confidence, traversal direction, and fallback reason. Package nodes must not become accidental app-flow bridges unless package traversal is explicitly relevant.

## Indexing Pipeline

The indexer should run as a deterministic local batch process:

1. Discover repos from a workspace manifest or CLI arguments.
2. Detect package manager, package workspaces, `package.json` names, exports, dependencies, and source roots.
3. Run `scip-typescript` per repo or workspace package according to its repo layout.
4. Parse SCIP output into definition, reference, and occurrence records.
5. Parse source files with Tree-sitter for syntax chunks, static imports, dynamic imports, CommonJS imports, exports, CommonJS exports, re-exports, default exports, namespace imports, declarations, decorators, constructors, calls, member access, JSX component usage, ownership, callbacks, test cases, file-local structures, and fallback symbols.
6. Resolve modules and exports through TypeScript-compatible resolution plus package export metadata, while recording unresolved and dynamic cases.
7. Normalize AST, SCIP, and resolved module facts into the feature schema.
8. Fuse AST and SCIP facts into canonical resolved symbols and evidence-backed graph edges.
9. Write nodes, edges, chunks, and embedding properties to LadybugDB.
10. Build chunk texts and symbol summaries.
11. Generate embeddings locally through Transformers.js.
12. Create or refresh Ladybug vector indexes for semantic search.
13. Write manifest, index version, repo SHAs, timestamps, tool versions, and health metadata.

`code-intel update` should preserve the same correctness as a clean `index` while avoiding repeated work where it is provably safe. The current P0 update model fingerprints source file bytes, reuses unchanged file chunk facts and matching embeddings, rechunks added and changed files, reruns SCIP at repo level, recomputes relationships from the current fact set, writes a fresh Ladybug generation, then publishes that generation atomically. Deleted files are removed by omission from the next generation rather than physical in-place row deletion.

The active generation manifest is the metadata authority for query, health, status, CLI, and MCP paths. The root manifest remains a convenience copy, not the only source readers should trust.

## Query Model

The query engine should support exact, semantic, and relationship retrieval.

Required CLI commands:

```text
code-intel index
code-intel update
code-intel status
code-intel health
code-intel search <pattern>
code-intel semantic <query>
code-intel find-symbol <name>
code-intel references <symbol-id-or-name>
code-intel callers <symbol-id-or-name>
code-intel callees <symbol-id-or-name>
code-intel expand-context <node-id>
code-intel get-context <node-id>
code-intel eval
code-intel mcp
```

## Eval Pack Model

The eval harness is pack based. A pack defines corpus metadata, corpus source, and JSON case files. Eval cases carry gate metadata so quality progress is measured by capability instead of one repo-specific pass/fail label.

Gate statuses:

- `required`: blocking regression gate. Any required failure makes report `status` and `blockingStatus` fail.
- `target`: non-blocking development target. Failures remain visible in `qualityStatus`, gate summaries, ranks, and failure classes.
- `scoreboard`: non-blocking quality metric for trend tracking and broader comparison.

Gate metadata records `id`, `status`, `capability`, and `layer`. Capabilities are general JS/TS patterns such as route-to-mutation, mutation-to-database, middleware-to-route, UI-to-data/API, test-to-implementation, package-boundary imports, re-export/canonical symbol resolution, and false-positive guards. Layers map to the current architecture: AST, SCIP, fusion, graph, ranking, and app-flow.

Eval reports include suite identity, corpus source, embedding metadata, index stats, top-level `blockingStatus`, `qualityStatus`, per-case latency, expected result ranks, false-positive checks, failure class, and summary aggregates by gate status, gate, capability, rank, and failure class.

Built-in P0 packs:

- `js-ts-general`: committed synthetic JS/TS corpus under `local-tools/code-intel/eval-packs/js-ts-general`. This is the deterministic regression pack. It covers exported symbols, re-exports, path alias references, React hooks, class methods, caller relationships, test relationships, semantic concept retrieval, and a duplicate-method false-positive guard.
- `oss-rallly-app-flow`: committed metadata, query case files, and AST fact case files under `local-tools/code-intel/eval-packs/oss-rallly-app-flow`. The Rallly source is not vendored. The CLI fetches the pinned external repository on demand into an eval cache when `--fetch` is provided. This pack is the real-world app-flow pack for frontend, API, package, database, middleware, and test retrieval quality.

Useful commands:

```text
code-intel eval --suite js-ts-general --json
code-intel eval --suite js-ts-general --embedding-provider hash --json
code-intel eval --suite oss-rallly-app-flow --fetch --json
code-intel eval --suite oss-rallly-app-flow --eval-cache-path /tmp/code-intel-rallly-eval-cache --embedding-provider hash --json
```

The synthetic pack is the hard regression gate. Its cases are `required` so regressions block the report. The Rallly pack mixes `required` gates for focused AST, SCIP, fusion, and graph relationship correctness with `target` gates for ranking, graph traversal, and full app-flow usefulness. Rallly target cases can fail without making the blocking status fail, but those failures must remain visible as future work.

CLI behavior requirements:

- Global options should include `--workspace <path>`, `--repo <path...>`, `--index-path <path>`, `--json`, `--quiet`, and `--verbose` where they apply.
- Human commands may render friendly text when stdout is a TTY.
- Machine-readable commands should support stable JSON through `--json`.
- Non-TTY output must be deterministic and free of spinners, progress animation, and terminal control codes.
- Command handlers must return explicit result objects to the presenter layer before writing output.

Required MCP tools:

- `workspace_overview`
- `health`
- `search_text`
- `semantic_search`
- `find_symbol`
- `get_symbol`
- `get_references`
- `get_callers`
- `get_callees`
- `expand_context`
- `get_context`
- `trace_path`

Semantic search should return ranked pointers, not large source dumps. Hybrid ranking may combine vector similarity, symbol text, path tokens, file-kind signals, and graph-neighbor evidence when those signals are present. Context expansion should walk graph relationships. Source text should be returned only by `get_context` or a bounded `expand_context` call.

## MCP Response Contract

MCP outputs must be structured JSON payloads wrapped in MCP text content only when the client requires text content.

`code-intel mcp` must start an MCP server with `StdioServerTransport`. The MCP client launches the command as a subprocess with stdin, stdout, and stderr pipes. MCP stdout is reserved for newline-delimited JSON-RPC messages. Logs go to stderr or files only.

MCP tests should use the MCP TypeScript SDK client transport or a small JSON-RPC harness over stdio pipes. PTY is not appropriate for MCP validation because a real MCP client communicates over ordinary stdio pipes, not a terminal.

Semantic search result shape:

```json
{
  "query": "embedded wallet session recovery",
  "results": [
    {
      "id": "chunk:capsule-org:js-monorepo@abc123:packages/react/src/useWallet.ts#12-88",
      "score": 0.87,
      "kind": "function",
      "repo": "js-monorepo",
      "package": "@getpara/react-sdk",
      "file": "packages/react/src/useWallet.ts",
      "range": { "startLine": 12, "endLine": 88 },
      "symbol": {
        "id": "symbol:capsule-org:js-monorepo@abc123:packages/react/src/useWallet.ts#useWallet",
        "name": "useWallet",
        "kind": "function"
      },
      "matchedSignals": ["vector_similarity", "symbol_text", "graph_calls"],
      "neighborCounts": {
        "callers": 3,
        "callees": 4,
        "references": 12,
        "tests": 1
      }
    }
  ]
}
```

## Safety Model

The tool is local-first and source-read-only by default.

Safety requirements:

- No remote source upload.
- No hosted embedding API during normal indexing.
- No Claude or other LLM calls inside the indexer.
- Explicit opt-in before indexing ignored files, generated folders, `.env` files, secrets, logs, or build outputs.
- Default ignore list for `node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`, generated SDK outputs, and local-dev runtime state.
- MCP tools must not expose arbitrary shell execution.
- MCP tools must enforce result limits, depth limits, and token budgets.
- Stdio MCP server must log to stderr or files, not stdout.

## Validation Model

The feature must be validated by layer before it is used as trusted agent context. `testing-strategy.md` defines the detailed test matrix.

Minimum validation layers:

- Unit tests for stable IDs, schemas, command parsing, output presenters, ignore rules, and query result shaping.
- Fixture integration tests for workspace discovery, SCIP ingestion, Tree-sitter chunking, LadybugDB schema setup, graph writes, vector writes, exact search parsing, and model-cache status.
- Database persistence tests that write a temp `.lbug`, close it, reopen it, and verify graph, full-text, and vector queries still work.
- CLI process tests that run the built `code-intel` binary through stdio pipes.
- TTY tests through `node-pty` only for terminal-specific behavior.
- MCP stdio tests through the SDK client transport or JSON-RPC pipes, not PTY.
- End-to-end fixture tests that index, query through CLI, query through MCP, restart the process, and confirm stable IDs and results remain consistent.
- Proof-of-concept smoke queries against selected local JS/TS packages after fixture correctness passes.

## Current MVP Behavior

The first implementation is a working local MVP under `local-tools/code-intel/` with its own git history. It provides the CLI, MCP stdio server, fixture indexer, LadybugDB graph persistence, LadybugDB vector index, SCIP artifact preservation and ingestion, Tree-sitter structural fact extraction, TypeScript-compatible fusion resolution, exact search, hybrid semantic search, context expansion, and eval suite.

The MVP now uses `jinaai/jina-embeddings-v2-base-code` through Transformers.js as the default semantic provider. Chunk embeddings are generated locally, stored as 768-dimension vectors on Ladybug `CodeNode` chunk records, and queried through the same manifest metadata from CLI and MCP paths. The deterministic `local-hash-v1` provider remains available only as an explicit `--embedding-provider hash` fallback for fast tests, offline diagnostics, and comparison runs.

Health now reports both the configured embedding provider and the existing index embedding provider. A hash-backed index is treated as a warning with a rebuild message, and a forced Jina query against a hash index fails with an embedding provider mismatch rather than silently mixing vector spaces.

LadybugDB is the live graph and vector store. A short database-open retry was added after proof-of-concept smoke testing showed file-lock contention when multiple CLI query processes open the same `.lbug` path at the same time. The MCP server now closes the query engine after each tool call so external CLI readers can open the active generation without contending with a long-lived MCP lock.

The Tree-sitter layer now exposes `extractSourceFileFacts()` as the primary AST API. `chunkSourceFile()` remains only as a legacy compatibility wrapper for chunk-only tests and callers. The indexer uses `extractSourceFileFacts()` through the file-facts pipeline, and the richer API gives SCIP fusion, graph building, and ranking work deterministic source facts instead of ad hoc string matching.

The A-grade AST hardening pass expands extraction to JS, JSX, TS, and TSX syntax including dynamic imports, CommonJS `require`, `module.exports`, `exports.foo`, export star, export namespace, export type, anonymous default exports, top-level variable declarations, decorators where the bundled grammar supports them, constructor calls, optional chained calls, JSX component usage, and test-case calls. The Rallly AST eval cases now pass on pinned API route, API mutation, database client, UI loader, middleware, and route test files. One Rallly database-client file still reports `hasParseError` because the pinned Tree-sitter TypeScript grammar flags newer `export type *` syntax, but the required structural facts are extracted.

The SCIP layer now owns the canonical symbol and relationship backbone for JS/TS projects when `scip-typescript` succeeds. `src/scip/ingest.ts` normalizes definitions, references, occurrence ranges, raw role masks, read/test facts, and symbol metadata. `src/indexer/scip-fusion.ts` maps those compiler facts to Tree-sitter declarations and chunks, promotes matching AST symbols to SCIP-backed canonical symbols, writes relationship evidence into graph edges, persists normalized SCIP facts, and keeps Tree-sitter relationship matching only as a fallback when SCIP fails.

## Success Criteria

The first usable version is successful when it can:

- Index at least one nontrivial local JS/TS repository without hosted services, with `js-monorepo` as the first real proof-of-concept corpus.
- Persist graph and vector data in LadybugDB.
- Resolve known exported symbols through `scip-typescript`.
- Find syntax-aware chunks and reusable structural facts through Tree-sitter.
- Answer exact symbol, reference, caller, callee, semantic, and context expansion queries.
- Serve those same queries through MCP.
- Return stable file paths, line ranges, node IDs, and relationship evidence.
- Pass a fixture suite that proves relationship traversal and semantic discovery against a small sample JS/TS project.
- Pass the minimum validation layers in `testing-strategy.md`.
- Improve local agent discovery compared with repeated `rg` searches for at least five real debugging or orientation queries from the first proof-of-concept corpus.
