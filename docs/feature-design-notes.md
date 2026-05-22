---
title: Code Intelligence Graph Design Notes
feature: code-intelligence-graph
created: 2026-05-13
last_updated: 2026-05-22
status: active
---

# Code Intelligence Graph Design Notes

Entries `2026-05-13.01` through `2026-05-13.12` reconstruct same-session decision order. Exact minute timestamps were not recorded for those earlier decisions, so sequence suffixes preserve chronology without inventing times.

## 2026-05-13.01: Feature Formalized

Jordy defined this as a new feature track separate from the existing docs accuracy PR. The current objective is not docs validation. The objective is a local JS/TS code intelligence knowledge graph that improves agent understanding of target repositories and can later become a foundation for docs workflows.

The tool should be local-first, serious enough for production workflows, and consumable by LLMs through MCP. It should be designed as a CLI with a built-in MCP server mode.

## 2026-05-13.02: JS/TS Scope Chosen

The feature will focus on JavaScript and TypeScript only. This avoids building a general multi-language platform before proving value.

The initial code intelligence layer should understand JS/TS monorepos, package exports, TypeScript references, source files, React hooks, components, tests, examples, and package relationships.

## 2026-05-13.03: CLI And MCP Shape

The CLI should own indexing, update, health, status, eval, and MCP startup. The MCP server should be a command of the CLI:

```text
code-intel mcp
```

This gives one local package that can be used by humans, CI, scheduled reindex jobs, and MCP-compatible agents.

MCP should expose bounded query tools. The intelligence lives in the local indexes, schema, query engine, graph store, vector store, and evaluation suite.

Bad MCP shape:

```text
ask_codebase(prompt)
```

Preferred MCP shape:

```text
semantic_search(query, filters)
find_symbol(name, filters)
get_references(symbolId)
get_callers(symbolId, depth)
expand_context(nodeId, depth)
get_context(nodeIds)
trace_path(fromId, toId)
```

The tools should return structured records with node IDs, files, ranges, scores, edge kinds, and bounded excerpts.

## 2026-05-13.04: Vector Search, Graph Search, And Exact Search Boundaries

Vector search answers fuzzy concept questions where the agent does not know the exact term. Graph search answers relationship questions once there is a seed node.

Working model:

```text
semantic_search(query)
  -> likely seed chunks or symbols

expand_context(seed)
  -> graph neighbors such as callers, callees, references, imports, exports, tests, and related packages

get_context(nodes)
  -> exact source excerpts
```

Exact text search remains useful but is not the knowledge layer. `rg` can find known strings. The graph and vector indexes reduce repeated rediscovery when the right strings are not known.

## 2026-05-13.05: Local-Only Embeddings

Semantic indexing should use local embeddings. The selected first model is `jinaai/jina-embeddings-v2-base-code` through Transformers.js. The first run may download model artifacts unless they are preseeded, but indexing should not call a hosted embedding API.

The tool should expose model-cache status in `code-intel health`.

## 2026-05-13.06: Initial Stack Selected With FalkorDBLite

The initial stack was:

- `@sourcegraph/scip-typescript` for precise definitions and references.
- `tree-sitter`, `tree-sitter-typescript`, and `tree-sitter-javascript` for syntax chunks and fallback structure.
- `falkordblite` for local graph persistence and traversal.
- `@lancedb/lancedb` for local vector persistence.
- `@huggingface/transformers` with `jinaai/jina-embeddings-v2-base-code` for local code embeddings.
- `ripgrep` for exact search via `rg --json`.
- `@modelcontextprotocol/sdk` for MCP stdio tools.
- `zod` for runtime schema contracts.

This was intentionally not a SQLite-based design. The feature question was whether a local graph database plus vector database gives agents a better map than repeated grep and raw file reads.

## 2026-05-13.07: FalkorDBLite Rejected Due License

FalkorDBLite was initially attractive because it is local, persistent with a path, Node/TypeScript compatible, and graph-native. It is rejected for this feature because FalkorDB core is SSPLv1. That is the wrong default for tooling that may later become public or broadly reusable.

This removes the need to carry a legal caveat in the default architecture.

## 2026-05-13.08: CozoDB Selected As Graph Store, Then Superseded

CozoDB was selected as the graph database for the first implementation after FalkorDBLite was rejected. The Node package is `cozo-node`; it embeds CozoDB in Node and exposes a `CozoDb` class. CozoDB is a relational-graph-vector database that uses Datalog-style CozoScript for graph queries, supports persistent engines including RocksDB, and avoids the SSPL issue.

The original plan would have used the `rocksdb` engine and stored graph state under `.code-intel/cozo`.

Important tradeoff: CozoDB is pre-1.0 and upstream notes that versions before 1.0 do not promise syntax/API stability or storage compatibility. That is a real maintenance risk, but it is a better risk than SSPL for this local/public-possible tool direction. The eval suite must test graph queries directly so a future graph-store swap is contained behind the query layer.

## 2026-05-13.09: Kuzu Upstream Rejected, Ladybug Successor Accepted

Kuzu would have been a strong local graph candidate because it is embedded and property-graph focused. The archived upstream Kuzu repository is not selected because the upstream repository is archived as of October 10, 2025. LadybugDB is selected instead because it continues the Kuzu direction under active community development and MIT licensing.

## 2026-05-13.10: LadybugDB Supersedes CozoDB

LadybugDB is selected over CozoDB after reviewing the current Kuzu successor landscape. LadybugDB is the community-centric successor fork of Kuzu, uses an MIT license, provides a Node package through `@ladybugdb/core`, supports on-disk embedded operation, uses a property graph model with Cypher, and documents native vector search over node-table float-array properties.

This is a better fit for code intelligence than CozoDB because the code graph is naturally a property graph. Code relationships map directly to node and relationship tables, and Cypher queries are easier for maintainers and LLM-facing tooling to reason about than a Datalog-specific query layer.

LadybugDB also supports combining vector search and graph traversal in the same Cypher query. That makes a separate LanceDB store unnecessary for the first implementation.

The revised first implementation should use LadybugDB as the single local database for graph, full-text, and vector search. LanceDB remains a fallback candidate only if the Ladybug vector extension fails local performance, filtering, or Node API validation.

## 2026-05-13.11: Exact Stack Updated After Ladybug Selection

The current first stack is:

- Node.js 20+ and TypeScript for runtime.
- `tsc` for package build output.
- `commander` for CLI command scaffolding.
- `@sourcegraph/scip-typescript` for precise definitions and references.
- `tree-sitter`, `tree-sitter-typescript`, and `tree-sitter-javascript` for syntax chunks and fallback structure.
- `@ladybugdb/core` for local graph persistence, Cypher traversal, full-text search, and native vector indexing.
- `@huggingface/transformers` with `jinaai/jina-embeddings-v2-base-code` for local code embeddings.
- `ripgrep` for exact search via `rg --json`.
- `@modelcontextprotocol/sdk` for MCP stdio tools.
- `zod` for runtime schema contracts.
- `vitest`, `execa`, and `node-pty` for unit, process, and TTY-specific tests.

This remains intentionally not a SQLite-based design. The current feature question is whether a local property graph with native vector search gives agents a better map than repeated grep and raw file reads.

## 2026-05-13.12: Storage Uses Shared Stable IDs

Ladybug graph, full-text, and vector records must all use the same stable node IDs. The first implementation should avoid a separate vector database unless eval evidence proves Ladybug vector search is insufficient.

The graph database stores relationships plus embedding-bearing chunk nodes. Native vector search returns graph nodes directly, so semantic results can be expanded through graph traversal without joining a second database.

## 2026-05-13 09:47 CDT: General-Purpose Product Boundary Clarified

Jordy clarified that this is not a `js-monorepo` or `user-management` specific tool. Those repositories are the first proof-of-concept corpus because Para is where the tool will be validated first, but the product direction is general-purpose local JS/TS repository intelligence.

The implementation should stay under `local-tools/code-intel/` while it is being tested in this workspace. If the approach proves useful, the source should move into its own dedicated repository for maintenance and reuse across non-Para work.

## 2026-05-13 10:06 CDT: CLI Harness And MCP Transport Stack Locked

The CLI scaffolding gap is now part of the stack decision. The first implementation should use `commander` for the `code-intel` command tree, with command actions kept as thin adapters over the shared core library.

The package should build with `tsc` into `dist/` and expose a `code-intel` binary through `package.json`. The first pass should avoid bundling because the selected stack includes native or runtime-sensitive dependencies such as LadybugDB, Tree-sitter, and the PTY test harness.

Testing should use `vitest` as the main runner. Process-level CLI tests should use `execa` with stdio pipes. TTY-specific behavior should be tested with `node-pty`, but only for behavior that actually depends on a terminal, such as `process.stdout.isTTY`, color/progress rendering, terminal width, or signal behavior.

MCP must not run through PTY in normal operation or validation. `code-intel mcp` should use the MCP TypeScript SDK `StdioServerTransport`, where the client launches the command as a subprocess and communicates through stdin/stdout JSON-RPC. Logs must go to stderr or files because stdout is protocol traffic.

## 2026-05-13 10:24 CDT: Layered Testing Strategy Added

The feature now has a dedicated `testing-strategy.md` so validation is explicit by layer before implementation starts.

The test model separates unit tests, contract tests, fixture integration tests, CLI process tests, TTY tests, LadybugDB persistence tests, MCP stdio tests, fixture end-to-end tests, eval cases, and proof-of-concept smoke queries. This matters because a bad answer must be classifiable as a discovery, SCIP, chunking, graph, vector, query, CLI, MCP, or eval-quality gap instead of being treated as a generic tool failure.

The minimum readiness gate before using the tool as trusted agent context is fixture correctness first, then CLI and MCP agreement, then persisted re-query after database reopen, then first proof-of-concept smoke queries against selected local JS/TS packages.

## 2026-05-13 11:04 CDT: MVP Implemented With Local Git History

The first code intelligence graph MVP was implemented under `local-tools/code-intel/` and initialized as a standalone-shaped local git repository on `main`. This gives the tool its own commit history if it is later moved out of `capsule-org` into a dedicated repository.

The MVP includes the Commander CLI, schema contracts, health and status commands, workspace discovery, Tree-sitter chunking, SCIP execution and ingestion, LadybugDB graph persistence, LadybugDB vector indexing, exact search, graph query engine, MCP stdio server, fixture eval suite, and proof-of-concept smoke validation against `js-monorepo/packages/react-sdk`.

The Tree-sitter packages required an implementation adjustment: `tree-sitter-typescript@0.23.2` still peers on `tree-sitter@0.21`, while `tree-sitter-javascript@0.25.0` peers on `tree-sitter@0.25`. The MVP pins `tree-sitter@0.21.1` and `tree-sitter-javascript@0.21.4` so the JS and TS grammars share a compatible runtime.

## 2026-05-13 11:04 CDT: Embedding Provider Gap Tracked

The stack still includes `@huggingface/transformers` and the selected Jina model, and `code-intel health` reports model-cache status. The working MVP uses a deterministic local feature-hash embedding provider named `local-hash-v1` for chunk vectors so fixture and process tests can run fully offline without a model download.

This is acceptable for structural MVP validation, but it is not enough to validate final semantic retrieval quality. Before using semantic results as trusted agent context, either switch the default provider to `jinaai/jina-embeddings-v2-base-code` or explicitly keep `local-hash-v1` as a documented fallback only.

## 2026-05-13 11:04 CDT: Ladybug Locking And PTY Findings

Proof-of-concept smoke testing showed that multiple separate CLI query processes can contend on the same Ladybug `.lbug` database file lock. A short open retry was added to reduce brittleness, but the preferred high-concurrency agent path is to run one MCP server process and issue multiple tool calls through that process.

The `node-pty` dependency installs and rebuilds, but in this local environment it cannot spawn even `/bin/echo`, returning `posix_spawnp failed`. The PTY test remains checked in and isolated, but it is skipped when the binding cannot spawn. This does not affect MCP validation because MCP is tested through stdio pipes.

## 2026-05-13 12:10 CDT: Review Remediation And Scale Pass

The post-MVP review found real implementation gaps: query methods were traversing the full graph in memory, chunk vectors were duplicated in a separate table, source chunk content leaked through generic result metadata, duplicate same-file symbols could collide, exact search treated user input as regex, package discovery could drop a real root package, SCIP lacked timeout and output caps, and parallel CLI reads could contend on Ladybug locks.

The current remediation adds a `CodeGraphRepository` boundary, pushes symbol and relationship lookups behind Ladybug-backed query methods, stores chunk embeddings directly on `CodeNode` chunk graph nodes, validates query result payloads, caps returned source context, keeps raw chunk source out of generic metadata, adds an embedding provider abstraction with both deterministic hash and Jina Transformers providers, and adds process-level serialization plus Ladybug retry handling for concurrent CLI reads.

Indexing was also hardened: duplicate symbol IDs now include ranges, parser exceptions fall back to safe file chunks, exact search uses literal `rg --fixed-strings` with streaming and timeouts, SCIP has timeout and bounded output capture, large repos skip the quadratic Tree-sitter reference fallback and rely on SCIP as the canonical reference source, and Ladybug rebuilds write to a generation path before atomically moving the active pointer.

The combined proof-of-concept now indexes `js-monorepo/packages/react-sdk` and `user-management/apps/server` into `.code-intel/poc-code-intel-review`. That run indexed 528 files into 8,406 nodes, 29,408 relationships, and 2,261 chunks in about 44 seconds. The user-management slice indexed 499 files, 8,309 nodes, and 29,265 relationships in about 50 seconds after batch database writes replaced per-row writes.

The Jina provider was validated separately because it is slower and model-cache dependent. `code-intel health --embedding-provider jina` successfully loaded and embedded with `jinaai/jina-embeddings-v2-base-code`, and a Jina-backed `react-sdk` index ranked `src/stellar/hooks/useStellarSigner.ts` first for `stellar signer wallet query`. The default remains deterministic hash for fast CI and fixture tests; Jina should be used for semantic-quality validation and agent context where the model cache is available.

## 2026-05-13 12:41 CDT: Final Review Closure

The final review loop found three more spec gaps that were valid: semantic search needed repo, package, file-kind, and symbol-kind filters; discovery needed stronger default ignore behavior plus explicit `--include-ignored`; and discovery needed to understand workspace manifests plus `tsconfig.json` or `jsconfig.json` source roots, includes, and excludes. Those are now implemented and covered by integration, CLI, and MCP tests.

The MCP server now uses a short idle query-engine cache instead of holding the Ladybug lock for the server lifetime. This avoids rapid open/close instability while still allowing external CLI reads to succeed while MCP is running. CLI limits are capped, exact search handles dash-prefixed literals via `rg --`, and byte truncation now uses UTF-8 byte-aware truncation.

The final hash-backed proof-of-concept index uses the new ignore and tsconfig-aware discovery behavior, so it indexes fewer files than the earlier broad scan: 431 files across `react-sdk` and `user-management/apps/server`, 7,594 graph nodes, 26,156 relationships, and 1,904 chunks in about 66 seconds. Filtered semantic smoke queries stayed bounded to the requested repo, package, and file kind. A separate Jina-backed fixture index built a 768-dimension vector schema and ranked `packages/core/src/tithe.ts` first for `giving receipt summary`.

## 2026-05-13 12:49 CDT: Future Improvements Backlog Created

The post-MVP improvement backlog now lives in `future-improvements.md`. The current 80/20 priority order is Jina default, incremental changed-file reindexing, stronger eval harness, SCIP-first relationship accuracy, import/export graph, and query ranking before lower-priority ergonomics or packaging work.

## 2026-05-13 16:29 CDT: Jina Default Migration

The first P0 improvement is implemented. `createEmbeddingProvider()` now resolves an unspecified provider to Jina instead of deterministic hash, so normal `index`, `update`, `health`, `eval`, CLI semantic query, and MCP semantic query paths use `jinaai/jina-embeddings-v2-base-code` unless `--embedding-provider hash` is explicitly selected.

Hash remains as an intentional fallback for fast deterministic tests, offline diagnosis, and comparison runs. The test harness now selects hash explicitly in fast CLI, MCP, integration, and PTY paths, while the e2e eval keeps the default provider and asserts Jina metadata.

Health now separates configured-provider validation from index-provider validation. This catches old hash-backed indexes as warnings and tells the user to rebuild without the hash flag. A query that explicitly requests Jina against a hash index still fails with an embedding provider mismatch, while normal queries infer the provider/model/dimension from the manifest.

The full `npm test` harness was also hardened. Process-style suites no longer each run `npm run build` concurrently from Vitest workers because that can leave `dist/` in a partial state. The build now runs once at script level before process, MCP, PTY, e2e, and full-suite test runs.

Validation shows Jina is an improvement path, not a complete ranking solution. The fixture default Jina index ranked `packages/core/src/tithe.ts` first for `giving receipt summary`, and MCP returned the same Jina metadata. On real Para slices, `react-sdk` literal hook-name queries were already strong with hash, while a user-management test-slice semantic query, `auth object overrides top level email input`, improved the expected `e2eIdentifierGate.test.ts` rank from 5 with hash to 2 with Jina. Ranking, import/export graph, and chunk granularity remain important follow-ups because some real-repo semantic cases still put a neighboring file first.

## 2026-05-13 18:39 CDT: Incremental Reindexing

The second P0 improvement is implemented in `local-tools/code-intel` commit `d9acc74 feat: add incremental reindexing`.

The implementation keeps the correctness oracle from the design discussion: after `code-intel update`, the active index should be equivalent to a fresh `code-intel index` over the same current files, options, schema, provider, and model. The first version does not mutate Ladybug rows in place. It reuses safe facts first, rebuilds the full current graph from those facts, writes a new Ladybug generation, then publishes the active pointer.

New source modules split the responsibilities:

- `fingerprints.ts` computes file-byte fingerprints and config invalidation hashes.
- `update-planner.ts` classifies added, changed, deleted, and unchanged files.
- `fact-cache.ts` reads and writes generation-local file facts and previous embeddings.
- `file-facts.ts` decides which file chunk facts can be reused and which files must be rechunked.
- `chunk-embeddings.ts` applies cached embeddings or calls the configured provider for misses.
- `index-artifacts.ts` centralizes active generation manifest resolution and atomic JSON writes.

The graph assembly still recomputes relationships from the current file fact set. This is intentional. Reusing relationship edges blindly would risk stale cross-file edges when a changed file changes symbol names, calls, references, or test coverage.

SCIP still reruns at repo level for this P0. Incremental SCIP reconciliation remains deferred because the safer first version should reuse Tree-sitter chunks and embeddings, but ingest fresh compiler-backed definitions and references.

The manifest now records incremental stats: added files, changed files, deleted files, unchanged files, reused chunks, and embedded chunks. CLI, MCP, health, status, and semantic query metadata now resolve against the active generation manifest instead of assuming the root manifest is authoritative.

Review remediation tightened this further. `createQueryEngine()` now resolves one active index snapshot and passes the same snapshot's manifest and Ladybug database path through query setup. This prevents a race where an update could publish a new generation between provider metadata resolution and database open.

The validation harness now asserts exact incremental file and chunk counts, proves changed and added chunks are the only embeddings regenerated in the fixture mutation, checks deleted source symbols and semantic chunks disappear, verifies facts and manifest equivalence against a fresh full index, and includes a regression test for the active-generation race.

## 2026-05-14 06:50 CDT: Stronger Eval Harness Packs

The third P0 improvement is implemented as a pack-based eval harness.

Two eval packs now define the validation split:

- `js-ts-general` is the committed synthetic fixture pack. It lives under `local-tools/code-intel/eval-packs/js-ts-general`, includes its own small JS/TS corpus, and is the deterministic regression gate.
- `oss-rallly-app-flow` is the external real-app pack. It lives under `local-tools/code-intel/eval-packs/oss-rallly-app-flow` as metadata and case JSON only. The Rallly repository is fetched on demand into an eval cache and pinned to commit `5017e6a3a616bf479ee21ca74d86d0da85e1a169`.

The CLI now supports `--suite`, `--eval-pack`, `--eval-cache-path`, and `--fetch`. Eval reports include suite metadata, corpus metadata, embedding provider metadata, index stats, expected result ranks, false-positive checks, latency, actual top results, and failure class.

The synthetic pack remains the hard pass/fail regression gate because it is deterministic, small, and network-free. The Rallly pack is a real-world quality scoreboard for frontend, API, package, database, middleware, and test relationships. A Rallly failure is useful evidence about retrieval quality or ranking, not a sign that the harness itself failed.

Validation found that the Rallly sparse fetch and hash-backed eval path work. The hash-backed Rallly run indexed 110 files into 1,261 nodes, 3,018 edges, and 423 chunks, then reported expected ranking and coverage failures. A default Jina-backed Rallly run was CPU-active for several minutes and was interrupted by the local command window before producing a report, so full Rallly Jina evaluation remains a long-running manual quality check until embedding performance is improved.

## 2026-05-15 11:43 CDT: Tree-sitter Structural Facts Layer

The AST layer has been expanded from chunk-only extraction into a reusable structural fact pass. The public compatibility API remains `chunkSourceFile()`, but it now delegates to `extractSourceFileFacts()`. The richer API emits chunks plus imports, exports, re-exports, default exports, namespace imports, declarations, calls, member access paths, parent/child ownership, test cases, callbacks, stable ranges, source hashes, owner file, and containing chunk provenance.

The implementation is intentionally general JS/TS first. Framework labels are not core assumptions. The extractor records generic syntax facts such as import specifiers, object methods, class methods, variable-declared functions, member call paths, and test-call facts. Later ranking or graph layers can interpret those facts for Next.js routes, Hono handlers, React hooks, database calls, or test ownership without baking those frameworks into the AST layer.

Generation-local `files.json` now persists these facts beside chunk and embedding facts, so incremental reindexing can reuse unchanged AST facts. The graph builder also writes first-class `Import` and `Export` nodes plus `IMPORTS` and `EXPORTS` edges from the owning file. Full module target resolution, package export resolution, and query/ranking use of these edges remain follow-up work.

The extractor was split into focused modules under `src/treesitter/`: `chunker.ts` for the public API, `types.ts` for contracts, `node-utils.ts` for parser helpers, `module-facts.ts` for imports/exports, `declaration-facts.ts` for declarations/chunks/ownership, and `reference-facts.ts` for calls, members, callbacks, and tests.

## 2026-05-15 13:07 CDT: AST Hardening And Fact Persistence Split

The AST layer has been hardened before moving to SCIP fusion. `extractSourceFileFacts()` is now the primary source API for the indexer, and `chunkSourceFile()` is only a legacy chunk-only wrapper.

The extractor now covers broader real-world JS/TS syntax: JS, JSX, TS, TSX, static imports, dynamic imports, CommonJS `require`, `module.exports`, `exports.foo`, export star, export namespace, export type specifiers, anonymous default exports, top-level variable declarations, decorators where the bundled grammar supports them, constructor calls, optional chained calls, member calls, JSX component usage, test cases, callbacks, duplicate method names, and partial syntax.

Graph identity now uses qualified declaration facts where appropriate. Chunk display names remain backward-compatible, but Tree-sitter symbol IDs and metadata carry qualified names such as `GivingLedger.summarize` so duplicate method names are not treated as the same source identity.

Generation-local persistence is split. Structural file facts are written to `facts/files.json` with `factsSchemaVersion: code-intel.facts.v2`, while reusable chunk vectors are written to `facts/embeddings.json` with `factsSchemaVersion: code-intel.embeddings.v1`. Readers merge both files internally so incremental reindexing still reuses unchanged embeddings without storing large vectors in the main structural facts JSON.

The Rallly eval pack now has `astCaseFiles`. The hash-backed Rallly run passes all six pinned AST cases across API route, API mutation, database client, UI loader, middleware, and private route test files. The semantic app-flow cases still fail mostly as ranking, which confirms the next quality work remains ranking, import/export target resolution, SCIP fusion, and test relationship linking rather than basic AST fact extraction.

One parser limitation remains visible: the pinned Tree-sitter TypeScript grammar reports `hasParseError` on Rallly's valid `export type *` syntax in `packages/database/src/client.ts`. The extractor still recovers the required imports, exports, declarations, and constructor calls from that file, so this is tracked as grammar freshness rather than a blocking AST fact failure.

## 2026-05-15 15:01 CDT: SCIP Canonical Symbol And Relationship Layer

The SCIP layer has been hardened so compiler-aware facts are the canonical symbol and relationship backbone when `scip-typescript` succeeds. The indexer no longer treats SCIP as a separate set of parallel `Symbol` nodes beside Tree-sitter symbols. Matching Tree-sitter declaration nodes are promoted with SCIP metadata, which keeps chunk identity and declaration identity aligned while avoiding duplicate AST and SCIP symbol results.

Normalized SCIP facts now include definitions, references, occurrence ranges, enclosing ranges, raw role masks, normalized read references, test-file references, and symbol metadata. These facts persist in generation-local `facts/scip.json` with `factsSchemaVersion: code-intel.scip-facts.v1`. The raw `.scip` artifact is still preserved separately.

One important provider finding: `scip-typescript` often emits references with no import or read role bit set. The implementation preserves the raw role mask, normalizes unmarked references as `ReadAccess`, and derives import/test evidence during AST/SCIP fusion where Tree-sitter syntax facts identify import declarations and test chunks. This keeps the raw compiler evidence intact while still giving graph edges useful operational roles.

SCIP fusion now creates evidence-backed `REFERENCES`, `CALLS`, `IMPORTS`, `EXPORTS`, `TESTS`, and `MENTIONS` edges with `metadata.relationship` available in query output. Tree-sitter name matching remains only as a labeled fallback when SCIP fails, rather than competing with compiler-backed relationships on healthy indexes.

The synthetic eval pack now covers type-import references and class-method callee relationships. The Rallly pack now includes `createPoll` and `deletePoll` symbol/reference cases so future eval runs can separate symbol-resolution failures from semantic ranking failures.

## 2026-05-15 15:22 CDT: SCIP And AST Fusion Fallback Boundary

Rallly exposed an important `scip-typescript` limitation: the SCIP artifact included `CreatePollParams` and type/property facts, but did not emit definitions for exported variable functions such as `createPoll` and `deletePoll`. The graph cannot use compiler evidence that is not present, so the fusion layer now treats Tree-sitter import/export resolution as a labeled fallback when SCIP has no target definition.

The indexer now creates declaration-backed symbol nodes for AST declarations that are not chunk-backed, such as exported variables, database clients, middleware variables, and route handler aliases. Import/export fusion still prefers SCIP-backed canonical symbols first. If no SCIP symbol exists, it resolves package, alias, and relative imports to AST declaration symbols with `origin: tree-sitter-import-resolution` or `origin: tree-sitter-export-resolution`, `confidence: fallback`, and relationship evidence under `metadata.relationship`.

The Rallly hash-backed eval now passes the focused graph relationship cases for `createPoll`, `deletePoll`, `prisma`, `spaceApiKeyAuth`, UI route references, and private route test imports. The overall Rallly suite still returns `status: fail` because semantic app-flow cases remain ranking failures. That is the correct boundary for this layer: SCIP/AST facts and graph references now resolve, but hybrid ranking still needs to consume those graph signals.

## 2026-05-15 16:01 CDT: Gated Eval Suite

The eval suite now has first-class gate metadata instead of treating every Rallly miss as the same blocking pass/fail signal. Query and AST cases can be `required`, `target`, or `scoreboard`. Required gates define the regression contract and drive report `status` plus `blockingStatus`. Target and scoreboard gates remain visible through `qualityStatus`, gate summaries, rank summaries, and failure-class summaries without blocking the report.

The synthetic `js-ts-general` pack is all required. It remains the fast hard regression gate for AST, SCIP, fusion, graph, ranking, and false-positive mechanics. The Rallly pack is now organized around general JS/TS capabilities: route-to-mutation, mutation-to-database, middleware-to-route, UI-to-data/API, test-to-implementation, package-boundary imports, re-export/canonical symbol resolution, transitive graph traversal, full app-flow retrieval, and false-positive guards.

This changes the meaning of a Rallly result. Focused AST/SCIP/fusion/graph cases can block when they fail, while ranking and full app-flow failures are target evidence for the next layers. The next implementation layers should make those target gates go green over time instead of adding repo-specific one-off cases.

Hash-backed Rallly validation after the gate change returned `status: pass`, `blockingStatus: pass`, and `qualityStatus: fail`. Required gates passed 13 of 13. Target gates passed 1 of 7, with the remaining failures split between ranking and one transitive graph traversal case. This is the intended baseline before hybrid ranking and deeper graph traversal work.

## 2026-05-15 18:03 CDT: Fusion Resolution And Graph-Aware Ranking

The fusion layer now has a concrete resolved-facts contract instead of ad hoc AST import/export fallback. The indexer builds generation-local module resolution facts in `facts/resolution.json` with `factsSchemaVersion: code-intel.resolved-facts.v1`. Those facts record resolved modules, package export entries, import bindings, export bindings, CommonJS bindings, dynamic import status, target files, target packages, target symbols where known, unresolved status, and fallback reasons.

Resolution uses the TypeScript compiler API where appropriate and package metadata fallback for workspace package exports. It covers relative imports, `tsconfig` aliases, workspace package names, package exports, barrels, re-exports, default imports, named imports, namespace imports, dynamic imports, CommonJS cases, and explicit unresolved cases. SCIP still owns canonical symbol identity and reference evidence when compiler facts exist. AST owns the syntax evidence that SCIP does not provide: exact import/export specifiers, local names, exported names, source ranges, containing chunks, member paths, and test context.

Graph edge creation now consumes this fused fact set. `IMPORTS`, `EXPORTS`, `REFERENCES`, `CALLS`, `TESTS`, and `MENTIONS` edges preserve SCIP, AST, and module-resolution evidence metadata with confidence, owner file, range, containing chunk, specifier, local/exported names, target file, target package, target symbol, member path, and fallback reason. Dynamic and unresolved imports are marked explicitly instead of guessed.

Hybrid semantic ranking now uses more than vector similarity. The query path overfetches vector candidates, then reranks with code-like query tokens, symbol text, path tokens, route/API/mutation/database/test signals, and graph neighbors through call and reference edges. This moved the gated Rallly target cases from visible expected failures to passing quality gates without changing the embedding model.

One operational fix landed with this pass: the MCP server now closes the query engine after each tool call, and the Ladybug store now explicitly closes query results plus database handles before releasing its process lock. This gives up the short idle query-engine cache but avoids Ladybug lock contention when an external CLI query opens the same active generation while MCP is running. The tradeoff is acceptable for correctness until we add a more deliberate shared-reader strategy.

Validation now shows the current gated eval pack is green: synthetic hash-backed eval passes 14 of 14 required cases, and Rallly hash-backed eval passes 13 of 13 required gates plus 7 of 7 target gates. This does not mean ranking is finished. It means the current AST, SCIP, fusion, graph, and app-flow gates are now a regression contract, and future work should add broader cases before tuning weights further.

## 2026-05-15 19:30 CDT: Graph-Layer Red Gates

The graph phase now has a red-phase eval target before graph traversal implementation starts. Claude CLI was invoked through `claude -p` with a scoped prompt to add stricter graph-specific target gates. That run partially added the graph-case harness but hung before adding pack cases, so the harness was inspected, completed, and validated locally.

Eval packs now support `graphCaseFiles`. Graph cases can assert direct edge existence, forbidden edges, ordered path existence, forbidden paths, allowed edge kinds, max depth, and evidence requirements. This is intentionally stricter than the existing query cases because it checks whether graph relationships explain the app flow, not just whether semantic ranking can surface expected files.

The synthetic pack has two required graph cases that pass: a UI hook to package-exported core function path, and a duplicate-method false-positive guard. These prove the graph-case parser and runner work without weakening the blocking regression contract.

The Rallly pack has five new target graph cases. Four fail today by design: route to mutation to database through typed `CALLS` edges with SCIP evidence, middleware to route usage path, UI page to private API route path, and test to implementation path through `TESTS` evidence. One false-positive guard passes: create-poll route should not connect to billing through mention-only app-flow paths.

This gives the graph layer a concrete next target. `blockingStatus` remains `pass`, while `qualityStatus` now fails because graph traversal and evidence are not strong enough yet. The next implementation should harden graph traversal, path semantics, edge direction handling, path ranking, and evidence exposure until these target gates pass.

## 2026-05-16 20:41 CDT: Graph Traversal And Evidence Hardening

The graph layer now has a shared traversal implementation rather than eval-only breadth-first search. `trace_path`, graph eval cases, CLI, and MCP all use the same path semantics: allowed edge kinds, direction (`outgoing`, `incoming`, or `either`), max depth, evidence requirements, deterministic path ordering, path edge metadata, confidence, fallback reason, owner file, and traversal direction.

Edge semantics were tightened. `CALLS` now requires observed call evidence from AST call facts or SCIP call references. A resolved import by itself creates `IMPORTS` and `REFERENCES`, but no longer creates a `CALLS` edge unless the imported binding is actually called or used as a member-call receiver. File-level `CALLS` still exists for route handlers and callback-heavy files when the file has an AST call fact but no containing chunk. This fixed the Rallly route-to-mutation path without reintroducing import-only false positives.

`TESTS` edges now preserve test evidence from test files, test chunks, resolved imports, SCIP references, and Tree-sitter test context. Test relationship metadata includes `tree-sitter-test` when the edge is derived from test context, and keeps `scip-typescript` when the target is compiler-backed.

The graph traversal layer now avoids using `Package` nodes as accidental app-flow bridges unless package traversal is explicitly relevant. This prevents broad package membership from creating misleading paths such as UI file to unrelated API route through `Package:@rallly/web`.

Rallly forced one eval correction. The original `UI page to private API route` graph gate was not a valid direct code-relationship expectation for the sparse pinned corpus. The real relationship in that slice is UI page to route data loader to route layout. The gate was changed to `rallly.graph-ui-to-route-data-loader-path`, which remains framework-agnostic in purpose: prove UI-to-data/API graph traversal through concrete local code relationships and labeled framework fallback where needed.

The indexer now adds thin Next App Router route-segment layout edges as labeled fallback evidence. These edges are not core AST or SCIP truth. They are `REFERENCES` edges with `origin: next-app-router`, `evidenceSources: ["next-app-router", "file-convention"]`, `confidence: fallback`, and `fallbackReason: next-app-router-file-convention`.

Incoming reference ranking was also adjusted because the graph layer made more precise edges visible. Incoming `REFERENCES` results now dedupe by file after ranking, prefer real call usage over import-only rows, preserve SCIP and module-resolution evidence, and propagate imported-symbol roles from SCIP references even when the symbol is used outside the import statement. This keeps `references prisma` useful for mutation-to-database discovery without breaking type-import evidence.

MCP query handling now reuses the query engine briefly across nearby tool calls and closes it on an unref'd idle timer. This avoids LadybugDB lock churn during multi-tool MCP sessions while still allowing `health` to force a close before checking index state.

Validation after this pass:

- Synthetic eval passed with `status: pass`, `blockingStatus: pass`, `qualityStatus: pass`.
- Rallly hash-backed eval passed all required gates and all five graph target cases. The only remaining Rallly target failure is `rallly.private-api-test-flow`, a semantic-ranking target where `route.test.ts` ranks 10 but `route.ts` is missing from the top 10.
- Full local package tests passed: 19 files passed, 55 tests passed, 1 PTY test skipped.
- `git diff --check` passed.
- `npm pack --dry-run` passed.

## 2026-05-16 22:20 CDT: Deterministic Hybrid Ranking Hardening

The ranking layer now treats semantic vector search as one candidate source instead of the final ordering. `semantic_search` overfetches vector rows, adds lexical/path/name candidates, exact symbol candidates, graph relationship candidates, reference/call/import/export/test candidates, and test-to-implementation paired candidates, then applies deterministic rank fusion plus code-aware boosts and demotions.

Query intent is now explicit. The ranker classifies implementation, caller, callee, test, app-flow, and broad semantic searches, then adjusts source/test file preference, exact-symbol priority, graph evidence, weak mention demotion, fallback-only demotion, and duplicate file/chunk suppression accordingly.

CLI and MCP semantic results now expose the rank explanation under `metadata.ranking`, including intent, final score, contributing source ranks, reason signals, evidence detail, and demotions. This keeps the output explainable without introducing a local reranker as a P0 dependency.

The eval harness now reports ranking metrics for query cases: `MRR@10`, `Recall@K`, `nDCG@10`, expected totals, expected found or missing counts, and false-positive counts. Synthetic eval cases now cover implementation-intent ranking, test-intent ranking, and graph-backed semantic ranking.

Hash-backed Rallly validation after the ranking pass returned `status: pass`, `blockingStatus: pass`, and `qualityStatus: pass`. Required gates passed 13 of 13 and target gates passed 12 of 12. The private API target now ranks `route.ts` first and `route.test.ts` second, resolving the remaining graph-phase ranking failure without weakening graph assertions.

Remaining ranking work is no longer P0 layer correctness. The next ranking improvements should be broader cross-corpus generalization, optional local reranker support after candidate recall is strong, and eval diagnostics that explain whether misses are caused by corpus coverage, discovery, chunking, embedding, graph traversal, or final ranking.

## 2026-05-16 00:09 CDT: Test-Linking Layer Hardening

The test-linking layer now creates explicit `TESTS` relationships instead of relying on ranking to infer coverage from nearby test files. Direct test imports, direct test calls, SCIP references, and concrete AST test-case facts are normalized onto evidence-backed `TESTS` edges. Bounded indirect links then extend those relationships through implementation `CALLS`, `REFERENCES`, `IMPORTS`, and `EXPORTS` paths when a direct test-to-implementation edge proves the starting point. Exact colocated source/test naming remains available only as labeled fallback.

The metadata contract is now stricter. Test edges carry owner file, test case name, test case range, target symbol or file, confidence, evidence sources, traversal path for indirect links, and fallback reason where fallback is used. Compiler and AST evidence outrank naming fallback. Broad package, folder, or word overlap is not sufficient to create a `TESTS` edge.

Synthetic eval coverage now includes direct call evidence, indirect helper-to-target coverage, colocated fallback, and false-positive guards. Rallly target coverage now includes private route tests, route-to-mutation coverage, route-to-database coverage, middleware/API tests, implementation-to-test lookup, test-to-implementation lookup, and false-positive guards. After this pass, hash-backed synthetic eval passes 23 of 23 required gates and hash-backed Rallly eval passes 13 of 13 required gates plus 18 of 18 target gates.

One graph eval assertion was corrected during the pass. The prior strict route-to-mutation-to-database ordered path overstated the current graph semantics because the graph proves route-to-mutation and route-to-database separately, but does not yet expose a clean `createPoll` symbol to `prisma` `CALLS` edge. The gate now checks typed route-to-database evidence for this layer, while type/member relationship precision remains future graph/type work.

## 2026-05-16 09:03 CDT: Relationship Graph Type, Member, And Boundary Hardening

The relationship graph layer now fills the precision gap left by test-linking. The graph no longer only proves route-to-database separately. It now emits a concrete `CALLS` edge from a resolved source symbol such as `createPoll` to a database client symbol such as `prisma` when module resolution and Tree-sitter member-call evidence prove the relationship.

SCIP-backed type references now emit `EXTENDS`, `IMPLEMENTS`, and type-use `REFERENCES` edges. The implementation keeps compiler evidence first, using declaration source only to classify the already-resolved compiler reference as inheritance, implementation, or general type use.

Module-resolution graph edges now preserve relationship tags for package-boundary imports, type imports, function calls, constructor calls, member calls, property access, loader/action convention targets, route handler sources, and mutation-to-database usage. These tags are exposed through edge metadata and evidence sources so evals, CLI output, and MCP output can distinguish a meaningful app-flow edge from a weak mention.

A new relationship graph pass covers syntax-only cases that are not true module-resolution edges: `process.env.NAME` becomes an explicit config/env symbol reference, `fetch(...)` and common client methods become unresolved API-client callsites, and concrete route or loader/action conventions add labeled fallback evidence. These fallback edges are intentionally marked with confidence and fallback reason instead of pretending runtime-only behavior has a static target.

Synthetic fixture coverage expanded with deterministic cases for inheritance, implementation, generic type use, member-chain call, property access, package boundary, loader/action, route handler, API client unresolved callsite, config/env, and false-positive guarding. Rallly target gates now include an ordered route-to-mutation-to-database path and a stricter createPoll-to-prisma member-chain edge requiring mutation-to-database evidence.

Validation after this pass is green: synthetic hash-backed eval passes 33 of 33 required gates, Rallly hash-backed eval passes 13 of 13 required gates and 20 of 20 target gates, and the full package suite passes 19 files with 55 tests plus the existing PTY skip.

## 2026-05-16 11:21 CDT: Adversarial Eval Completion

The adversarial eval packs now pass across both semantic providers. `js-ts-adversarial` passes target 73 of 73 and scoreboard 5 of 5 with both hash and Jina. `oss-rallly-adversarial` passes target 17 of 17 with both hash and Jina. The implementation work did not weaken the pack case files or graduate target gates to required.

The main implementation findings were around precision boundaries. Exact ID lookup must run before broad text search so MCP and CLI symbol tools do not return nearby aliases. Plain symbol queries should not search all metadata by default because that pollutes graph seed sets for names that appear inside documentation or chunk metadata. Function-valued variable extraction needs a specific factory-call rule so exported middleware and route handlers are captured without incorrectly classifying local collection transforms as functions.

Test ownership now has a split contract: AST `testCase.parentName` stays as the raw enclosing suite title for pack compatibility, while ownership facts resolve that raw title to the canonical suite fact name. This keeps the eval surface stable and still gives downstream graphing an unambiguous owner.

The on-demand Rallly pack remains outside `npm test` because it fetches and indexes a pinned OSS checkout. The committed regression test pins the synthetic adversarial pack in-process, while final Rallly validation is recorded through explicit CLI eval commands in `verification-checklist.md`.

## 2026-05-16 21:48 CDT: Cross-OSS Eval Portfolio Added

The eval portfolio now extends beyond Rallly with three pinned on-demand OSS packs: Ghostfolio, OpenStatus, and Hermes Agent. These packs are deliberately organized around general JS/TS capability gates rather than repository trivia. Ghostfolio covers Angular-to-NestJS-to-service/database relationships. OpenStatus covers monitoring routes, dashboard/API flows, service/database relationships, edge/config usage, and tests. Hermes covers AI-agent React/Ink UI/TUI flows, gateway-client protocol types, hooks, package boundaries, and test-to-implementation relationships.

All new gates start as `target` or `scoreboard`. This keeps the existing regression contract unchanged while giving future work concrete generalization targets. First-run reports pass `blockingStatus` and fail `qualityStatus`, which is the intended state until these new target gates are hardened and directly regression-pinned.

Two cache and scaling fixes landed with this pass. External git corpus cache keys now include the sparse checkout shape, so changing `sparsePaths` cannot silently reuse an old checkout for the same commit. Eval Jina model artifacts now persist under the eval cache path instead of a temporary index path, and embedding input text is bounded before provider calls so local model runs avoid wasted work on oversized chunks.

Baseline results are recorded in `oss-eval-portfolio.md` and `verification-checklist.md`. The first useful failures are Ghostfolio service-to-Prisma traversal and test-linking, OpenStatus Hono/service AST facts and route-to-database traversal, and Hermes hook AST extraction, hook reference fusion, gateway test-linking, and TUI gateway ranking.

## 2026-05-17 07:42 CDT: Hermes Composer Eval Correction

The Hermes composer reference target was corrected to match the pinned source. `ui-tui/src/__tests__/useComposerState.test.ts` imports and exercises `looksLikeDroppedPath` from `ui-tui/src/app/useComposerState.ts`; it does not reference the `useComposerState` hook symbol. The eval pack now queries `looksLikeDroppedPath` and expects the helper source plus the helper test, while a separate graph target checks the test-to-helper implementation path.

This keeps the OSS eval portfolio from overfitting to a false relationship. The corrected Hermes target still fails quality for both hash and Jina, but the failure is now a useful capability signal: helper symbol/reference fusion returns the containing hook chunk instead of the helper symbol, and the graph does not currently resolve the composer test file as a test-linking source. Those are future discovery, fusion, and test-linking targets rather than evidence that the old hook-reference expectation was valid.

## 2026-05-17 09:10 CDT: Cross-OSS Quality Hardening

Ghostfolio, OpenStatus, and Hermes now pass their target and scoreboard gates with both hash and Jina providers. The fixes were structural first, then ranking only after graph and fusion targets were green.

AST extraction now normalizes fluent member calls and wrapped calls such as `await db.insert(...)`, `await tx.delete(...)`, `await gw.request(...)`, and `void gw.request(...).then(...)` into stable member paths, receivers, properties, and member-call facts. This resolved the OpenStatus fluent database-call and Hermes gateway request extraction failures without adding repo-specific logic.

Discovery now keeps explicit test files under included source roots even when a build `tsconfig` excludes tests, and it supports recursive workspace globs such as `packages/**/*`. This fixed Hermes test discovery and OpenStatus package discovery where `@openstatus/db` had been treated as an external package.

Fusion and graph resolution now cover two important monorepo patterns: root `tsconfig.base.json` path aliases when root `tsconfig.json` is empty, and named import resolution through multi-hop `export *` barrels. Imported member/property usage now creates symbol-level `REFERENCES` edges when the target symbol is known. Relationship graphing also adds deterministic constructor-injected member-call edges from a class method to an injected service type when Tree-sitter proves `this.service...` and the class constructor or field proves the service type.

References queries now prioritize actual relationship rows before appending exact source definitions. This preserves the Hermes helper definition use case without pushing real consumers behind barrel export wrappers.

Ranking changes were limited to deterministic hybrid ranking rules after all target gates were green. The ranker now has general surface boosts for UI/page/component/table and gateway/client/RPC/hook queries, broader symbol-token generation for common hook and client naming patterns, stronger non-test demotion for non-test intents, and a slightly wider per-file dedupe window for surface queries so the right symbol is not hidden by another symbol from the same file.

The resulting eval matrix is green:

- Ghostfolio hash and Jina: target 8/8, scoreboard 1/1.
- OpenStatus hash and Jina: target 8/8, scoreboard 1/1.
- Hermes hash and Jina: target 9/9, scoreboard 1/1.

The full package suite also passed with 21 test files passed, 1 skipped; 93 tests passed, 1 skipped. The skipped test remains the PTY-only case in this local runtime.

## 2026-05-17 11:05 CDT: Holdout OSS Validation Phase

Added three new on-demand holdout eval packs after the Ghostfolio/OpenStatus/Hermes hardening pass: Dub, Twenty, and Formbricks. These are intentionally target and scoreboard packs only. They are not regression gates yet, and they are meant to measure generalization before implementation is tuned to these repos.

The packs are pinned to full commit SHAs and use sparse checkout paths:

- Dub at `3e669b19b42a903178baa19a9e16b4a9b02a968e`, covering Next.js link creation, redirect analytics, Prisma/Tinybird/cache/database paths, webhook/payment handlers, UI-to-server flow, and integration-test-to-route linking.
- Twenty at `62b347fc743fbd28d558b02ab0d47fac04095816`, covering React-to-GraphQL/API, Nest GraphQL resolver-to-service, service-to-query-runner, module/provider references, package boundaries, ranking, and service tests.
- Formbricks at `f90a9fb1315bc3819da86917e08ee5daee112ade`, covering survey editor server components, response server actions, auth/organization permission actions, shared package response utilities, package tests, and ranking.

The first corrected baselines were run with both hash and Jina. All three packs pass `blockingStatus` because they have no required gates, and all three fail `qualityStatus` as intended holdout signal. Hash and Jina produced the same pass/fail shape in every pack, which means the current misses are mostly relationship, traversal, test-linking, and deterministic ranking gaps rather than provider-specific embedding drift.

Baseline results:

- Dub hash and Jina: target 5/11, scoreboard 1/2, quality fail.
- Twenty hash and Jina: target 5/9, scoreboard 1/1, quality fail.
- Formbricks hash and Jina: target 5/9, scoreboard 0/1, quality fail.

Failure classification:

- Real tool gaps: Dub and Twenty relationship fusion misses, Dub/Twenty/Formbricks graph traversal misses, and Twenty/Formbricks direct test-linking misses.
- Unsupported repo pattern: Dub's integration test exercises `/links` through an HTTP harness path rather than a direct import, so current test-linking does not map that route test to the route handler.
- Ranking-only quality issues: Dub UI-to-server semantic retrieval and Formbricks survey editor auth/response retrieval.
- Eval gap corrected before final baseline: Formbricks response-action expectations were updated from nonexistent `getResponseDownloadFile` usage to the actual `getResponsesAction` to `getResponses` flow in the pinned sparse file; organization action declaration kind was corrected to `VariableFunction`.
- Sparse-checkout gaps: none observed in the corrected baseline.

One batched hash/Jina summary script hit a transient Ladybug WAL open error during the final Formbricks/Jina run. The isolated Formbricks/Jina rerun passed blocking and produced the expected quality-fail baseline, so this is recorded as a validation runtime note rather than a holdout pack failure.

## 2026-05-17 14:24 CDT: Holdout Generalization Hardening

The Dub, Twenty, and Formbricks holdout failures drove a generic relationship hardening pass rather than repo-specific tuning. The implementation now covers several common JS/TS app patterns that were missing from the graph even though AST and SCIP facts already existed.

Module resolution now keeps the repo-level `tsconfig.base.json` path map when the root package has a blank `tsconfig.json`. Package-local `tsconfig.json` and `jsconfig.json` files can still override resolution for nested workspaces, but the root package no longer erases the inherited base config. This fixed Ghostfolio alias resolution for imports such as `@ghostfolio/api/...` and protects Nx-style roots that keep paths in `tsconfig.base.json`.

Workspace discovery no longer ignores `lib` directories by default. In JS/TS apps, `lib/` is commonly first-party source rather than generated output. Generated output should still be filtered by more specific directories such as `dist`, `build`, `.next`, `coverage`, and `generated`.

The graph now preserves exact call-evidence variants separately from canonical source/target edges. This matters because a canonical `CALLS` edge can merge multiple callsites between the same two nodes over time, and scalar metadata such as owner file, range, member path, and target symbol can be overwritten by the latest merge. Evidence-specific `CALLS` edges keep deterministic callsite evidence available for graph evals, CLI/MCP output, and traversal while the canonical edge remains useful for broad connectivity.

Relationship graphing now promotes imported member-call facts to concrete `CALLS` edges when module resolution proves the imported binding target and Tree-sitter proves member-call usage. This is what turns `prisma.link.create(...)`, `prisma.poll.create(...)`, and similar database-client calls into source-symbol-to-client relationships with `module-resolution`, `tree-sitter-member-call`, and `mutation-to-database` evidence.

Constructor-injected service calls now resolve to both the injected service class and the called service method when the class constructor or field proves the injected type. This strengthens Nest-style resolver/service/query-runner flows without relying on repo names. Module/provider arrays also produce resolver-backed references so framework modules can explain provider relationships.

Test-linking now recognizes HTTP harness route-string calls in test files. Calls such as `http.post({ path: "/links" })` can link to matching Next route handlers using the static route path and HTTP method, with `http-harness-route` and `tree-sitter-test` evidence. This is intentionally bounded to route-shaped source files and explicit request paths so broad string overlap does not create `TESTS` edges.

The final holdout result is provider-independent for the target gates:

- Dub hash and Jina: target 11/11, scoreboard 1/2. The remaining miss is `dub.query.webhook-payment-flow`, classified as ranking.
- Twenty hash and Jina: target 9/9, scoreboard 1/1.
- Formbricks hash and Jina: target 9/9, scoreboard 0/1. The remaining miss is `formbricks.query-survey-editor-auth-response-flow`, classified as ranking.

The older regression portfolio stayed green after the hardening pass: `js-ts-general` required 33/33, `js-ts-adversarial` required 29/29 plus target 44/44 and scoreboard 5/5, Rallly required 13/13 plus target 20/20, Ghostfolio target 8/8 plus scoreboard 1/1, OpenStatus target 8/8 plus scoreboard 1/1, and Hermes target 9/9 plus scoreboard 1/1.

Remaining work is now ranking quality rather than relationship correctness for these holdouts. Dub webhook/payment flow and Formbricks survey editor auth/response flow still fail scoreboard cases because expected files are not ranked high enough, even though the target relationship gates now pass.

## 2026-05-17 18:19 CDT: Path-Level App-Flow Ranking Hardening

The ranking layer now scores coherent graph paths before individual nodes for app-flow style semantic queries. Ranking builds bounded typed paths from semantic, lexical, symbol, and graph seeds, then scores those paths with internal in-code weights for edge kind, evidence quality, node role, concept coverage, path length, fallback evidence, weak mentions, unresolved edges, and representative owner promotion. No user-facing override or config surface was added.

The new path-ranking metadata is carried through CLI and MCP query results. Result metadata can now include path-level rank reasons, path nodes, edge kinds, evidence sources, confidence values, demotions, and final score contributions. Eval query reports also include the ranking explanation for each top result so failures can show whether a miss is semantic retrieval, graph path quality, evidence quality, demotion, or representative selection.

The implementation promotes representative owners when the best evidence points at a file, chunk, or symbol that should stand in for an app-flow owner. This is what lets queries surface route handlers, services, database/client calls, UI entries, middleware, and tests even when the raw semantic hit landed on a less useful nearby chunk. Weak mentions, unresolved edges, fallback-only paths, generated/vendor files, non-matching concepts, and generic app-flow matches are demoted.

The final result closed the remaining ranking-only holdout failures without weakening previous AST, SCIP, fusion, graph, test-linking, or eval contracts. Dub webhook/payment flow and Formbricks survey editor auth/response flow now pass scoreboard gates for both hash and Jina. The broader regression matrix remains green for synthetic, adversarial, Rallly, Ghostfolio, OpenStatus, Hermes, Dub, Twenty, and Formbricks on both providers.

## 2026-05-17 21:29 CDT: Pre-Standalone Diagnostics, Benchmarking, And MCP Ergonomics

The pre-standalone readiness pass adds operational evidence around the already-green eval suite. The key change is a generation-local diagnostics artifact, `facts/diagnostics.json`, with `diagnosticsSchemaVersion: code-intel.diagnostics.v1`. It records file lifecycle status across fetch or local corpus presence, sparse checkout presence, discovery, ignored path handling, tsconfig filtering, parse recovery, AST facts, SCIP facts, chunks, embeddings, graph writes, exact queryability, symbol queryability, and semantic ranking readiness.

The CLI now exposes `diagnose file <path>` and `diagnose symbol <name>`. `diagnose file` can explain both indexed files and skipped paths, including files inferred under an ignored directory. `diagnose symbol` reports matching graph symbols and attaches the owning file lifecycle so a user can tell whether a symbol result is backed by parsed, embedded, graph-written, queryable facts.

Eval reporting now supports `--diagnostics`. The report adds preflight rows for every query-case `expected` and `notExpected` file or symbol, checking whether the file exists in the corpus, was discovered, was indexed, has graph and embedding support, and is queryable. Preflight failure classification points at fetch, sparse-checkout, discovery, ignore, tsconfig, parse, AST, SCIP, graph, embedding, query, or ranking based on the first failing lifecycle stage.

A repeatable `benchmark` command now copies an eval corpus to a temporary workspace and measures cold index, warm update, one-file update, deleted-file update, query latency, optional MCP query latency, memory RSS, node/edge/chunk counts, embedding batch size, graph write batch sizes, and Ladybug concurrent-read behavior. The benchmark is intentionally corpus-based so it can run against synthetic fixtures or pinned OSS eval packs without mutating a user checkout.

MCP tool descriptions and tool payloads now include agent-facing guidance: purpose, evidence fields, suggested next tools, and examples. This keeps MCP clients from treating the server like generic search and points agents toward the intended flow: semantic or exact search for seeds, symbol lookup for known names, graph expansion and path tracing for relationships, and bounded context only after selecting nodes.

The OSS diagnostics matrix was run with hash embeddings across Rallly, Ghostfolio, OpenStatus, Hermes, Dub, Twenty, and Formbricks. All seven packs passed, and diagnostics preflight reported zero missing files, undiscovered files, unindexed files, or unqueryable symbols. This validates that the current green eval results are not coming from sparse-checkout or discovery blind spots for those packs.

Benchmark evidence now covers the synthetic fixture with hash and Jina, plus the larger Rallly app-flow pack with hash. The synthetic Jina run used `jinaai/jina-embeddings-v2-base-code`, dimension 768, and recorded materially higher cold index time and RSS than hash, as expected. Rallly hash recorded 403 chunks, 4,816 nodes, and 18,438 edges, which gives a first larger-corpus scale datapoint without mutating the cached OSS checkout.

One scale risk remains explicit: the benchmark currently records Ladybug concurrent-read behavior as `fail`. That is not hidden behind a passing test because the benchmark is meant to report runtime behavior. It should be treated as a standalone-readiness risk for concurrent MCP or query workloads until investigated.

## 2026-05-18 07:07 CDT: Concurrency And Locking Hardening

The standalone-readiness risk around Ladybug concurrent reads is now resolved for the intended CLI and MCP access model. The benchmark failure came from two separate lifecycle issues, not from eval quality: same-process concurrent reads could race into `LadybugGraphStore.open()` before the first open finished, and the custom process lock was scoped to the index root instead of the concrete Ladybug database path.

The query layer now uses bounded serialization inside a `QueryEngine`. Parallel semantic, symbol, reference, caller, callee, context, and path reads against the same engine run one at a time through a queue, and `close()` waits for the queue before releasing the store. This is the intended behavior for CLI and MCP because it gives deterministic results and avoids native embedded-database handle contention.

The graph store now uses single-flight `open()` behavior and exposes runtime stats for process-lock wait time, native open retry count, and process-lock contention count. The process lock moved from the index root to the specific `.lbug` database path. That matters because `update` writes a new immutable generation under a new database path while existing readers may still hold the old active generation. Old readers can finish against the stale generation, and new readers resolve the freshly published generation after the active pointer changes.

The benchmark report now records `concurrentRead`, `readerDuringUpdate`, `readerAfterPublish`, `retryCount`, `queueWaitMs`, `lockWaitMs`, and `failureClassification`. A passing report means same-engine reads were safely serialized, a reader could query during an update, and a new reader saw the published generation afterward. If a future failure appears, the report classifies it as a Ladybug connection limit, graph-store lifecycle issue, active-generation pointer issue, MCP reuse issue, test harness issue, or unknown issue.

Focused tests now cover parallel query-engine reads, parallel MCP tool calls, reader-during-update behavior, reader-after-publish behavior, stale generation behavior, live lock timeout reporting, and stale lock recovery. This preserves the generation-based update model: no in-place graph mutation is needed for concurrency safety.

## 2026-05-18 07:22 CDT: Standalone Local Repository Move

The code-intel implementation and feature docs now live together in the code-intel repository. The feature-doc history from `local-doc/code-intelligence-graph` was imported into the repo under `docs/`, then the repo directory was moved from `capsule-org/local-tools/code-intel` to `/Users/jordy/Documents/GitHub/code-intel`.

This is a local standalone move, not a packaging or publishing claim. Historical verification entries keep their original paths, while current docs and commands should use the standalone repo root and repo-relative paths such as `eval-packs/`, `src/`, and `docs/`.

## 2026-05-18 07:43 CDT: Standalone Agent Instructions

The agentic development rules that previously came from the parent workspace have been copied into the standalone repository as repo-local instructions. `AGENTS.md` now defines the code-intel directive layer, and `docs/agent-workflows/` holds the supporting workflow references for development workflow, TDD, verification, local documentation, coding standards, and pull requests.

The copied workflow was intentionally narrowed to code-intel. It keeps the requirements-first, TDD, feature-doc, eval, verification, coding-quality, and conventional-commit practices, while removing parent-workspace, multistack, child-repo, deployment, infrastructure, mobile, and Para-specific operational rules that do not govern this standalone tool.

## 2026-05-18 10:36 CDT: Type Precision Regression Track

Type precision is now a dedicated required regression track inside `eval-packs/js-ts-adversarial`. The new fixtures cover type alias dependencies, generic constraints/defaults/instantiations, mapped and conditional type references, type-only imports and re-exports, enum member precision, merged interface/namespace ownership, and recursive type false-positive guards.

Tree-sitter extraction now emits persisted `typeReferences` facts with containing declaration and chunk provenance. The extractor records type-position references from annotations, type aliases, generic constraints, generic defaults, type arguments, mapped types, conditional types, indexed access, `keyof`, `typeof`, and namespace-qualified type member references while skipping declaration names and mapped/type-parameter definitions.

Relationship graph fusion now turns those AST type references into `REFERENCES` edges with `tree-sitter-type-reference` and `type-use` evidence when the source owner and target symbol are proven. These edges complement SCIP-backed `EXTENDS`, `IMPLEMENTS`, and type-use references instead of replacing compiler evidence. Recursive/self references remain guarded so type aliases such as `RecursiveEnvelope` do not create same-symbol self-loop references.

Query seeding now tries exact qualified symbol metadata before broad name or metadata search for dotted seeds. This keeps queries such as `Severity.Error` pinned to the enum member and prevents `Severity.Info` owners from satisfying `Error` expectations. The default-caller fallback also now merges direct rows with anonymous-default fallback rows so adding a real `default*` symbol does not hide the existing anonymous default scoreboard case.

The new type-precision cases entered as failing required gates first. The red phase failed for missing `typeReferences` and missing `tree-sitter-type-reference` graph evidence, then passed after implementation without weakening existing adversarial gates.

## 2026-05-18 12:21 CDT: MCP Agent-Readiness Regression Track

MCP agent readiness is now a dedicated required regression track inside `eval-packs/js-ts-adversarial`. The new `mcpCaseFiles` eval class runs a real `@modelcontextprotocol/sdk` stdio client against the built `code-intel mcp` command after the eval harness indexes the corpus, so the gate checks the actual agent-facing process boundary instead of an in-process mock.

The MCP server now advertises `outputSchema` for every tool and returns the same schema-validated payload through `structuredContent` and text `content`. This preserves compatibility with text-only clients while letting structured MCP clients validate output automatically. The payload still carries the code-intel wrapper with schema version, tool name, guidance metadata, and the typed result.

The MCP feature surface now includes `diagnose_file`, `diagnose_symbol`, and `get_relationships`. The diagnostics tools expose the same generation-local file and symbol lifecycle contracts as the CLI diagnostics path. `get_relationships` is a generic relationship browser over the shared query engine: it resolves seed IDs or symbol names, accepts direction and edge-kind filters, and returns bounded query results with `metadata.relationship` evidence, confidence, traversal direction, and owner metadata.

The adversarial MCP workflow gate chains `workspace_overview`, `health`, semantic search, symbol lookup, references, callers, callees, relationship browsing, path tracing, diagnostics, invalid-input handling, and bounded `get_context`. The case asserts ranking reasons, relationship evidence, path edges, no source excerpts outside context tools, and context byte limits. Hash and Jina validation pass with required 45/45, target 44/44, scoreboard 5/5, and 94/94 total.

## 2026-05-18 14:25 CDT: CLI API And CLI/MCP Parity Regression Track

The CLI API surface is now hardened as an agent-facing surface rather than only a human convenience wrapper. The new `relationships <seed>` command exposes the same generic relationship browser as MCP `get_relationships`, including bounded `--limit`, `--edge-kind`, and `--direction` controls. Existing top-level commands remain stable; the logical command hierarchy is documented instead of breaking compatibility with nested aliases.

Machine-readable CLI output remains deterministic JSON for `--json` and non-TTY stdout. TTY query output now renders a compact human summary with query, result count, symbol or file location, matched signals, relationship evidence, and ranking evidence. Source excerpts are still limited to context commands in the query contract.

The eval harness now supports `cliMcpCaseFiles`. A CLI/MCP parity case launches the built CLI and an SDK MCP stdio client against the same indexed corpus, then compares normalized result contracts for semantic search, symbol lookup, relationship browsing, path tracing, diagnostics, invalid input, and bounded context. The parity comparison covers stable IDs, files, symbols, ranking reasons, relationship evidence, path edges, result limits, diagnostics, and excerpts.

The parity eval intentionally releases the MCP query engine between steps through the existing `health` tool. That keeps the case focused on CLI/MCP result contract equivalence instead of measuring cross-process Ladybug handle timing; lock behavior remains covered by benchmark and concurrency tests.

The new gate entered red first: focused tests failed because `relationships` was not registered, TTY query output still rendered raw JSON, and the eval loader ignored `cliMcpCaseFiles`. Hash and Jina validation now pass the adversarial pack with required 46/46, target 44/44, scoreboard 5/5, and 95/95 total.

## 2026-05-18 16:01 CDT: Remove Native PTY Test Harness

The native PTY test harness has been removed from the active package. The current CLI does not implement interactive terminal-control behavior such as raw keyboard input, resize handling, cursor movement, color contracts, or progress UI. Human output is formatter behavior, and the presenter tests can cover it directly by injecting `isTTY: true`.

This removes the `node-pty` dev dependency, the `test:pty` script, and the skipped PTY health test. It also eliminates the recurring local runtime issue where `node-pty` could not spawn even `/bin/echo` and turned full-suite output into "passed with one skip" despite the skip not representing a product behavior risk.

The testing split is now simpler: CLI process behavior uses `execa` stdio pipes, MCP behavior uses SDK stdio transport, and TTY rendering branches use presenter/unit tests. If a future CLI feature adds real terminal-control semantics, choose a targeted terminal harness for that feature instead of reintroducing a native PTY dependency for formatting-only output.

## 2026-05-18 16:38 CDT: Public Repository Metadata

The root README has been rewritten as the public entry point for `jlm0/code-intel`. It now describes the tool as local-first JavaScript and TypeScript code intelligence for CLI workflows and MCP agents, leads with install-from-source and tarball-install paths, and includes quick-start commands for indexing, querying, updating, MCP setup, evals, and benchmarks.

Package metadata now points at `https://github.com/jlm0/code-intel`, includes public-facing keywords, homepage, bugs, and repository fields, and adds a `prepack` build hook so tarball creation starts from fresh `dist/` output. The package-level private publish guard was removed, but licensing was intentionally left unchanged because public repository visibility and open-source licensing are separate decisions.

The GitHub repository was created under the `jlm0` account with public visibility, the same public-facing description as the package metadata, the README homepage, and topics for code intelligence, TypeScript, JavaScript, MCP, CLI, Tree-sitter, and SCIP.

## 2026-05-18 18:30 CDT: Versioned Local Release Baseline

`0.1.0` is now the first standalone local release baseline. Product specs and the current CLI, MCP, AST, SCIP, graph, ranking, diagnostics, benchmark, and packaging-readiness tracks are treated as complete enough for local system consumption before new feature work begins.

The package version is the single source of truth for `code-intel --version`. The CLI reads `package.json` at runtime from the installed package layout, which keeps source, tarball, and global install version reporting aligned.

Local installation is now scripted through `npm run release:local`. The script runs the normal test gate, builds through the existing `prepack` hook, creates `.local-releases/v<version>/code-intel-<version>.tgz`, installs that exact tarball globally with npm, verifies the installed CLI reports the same version, and writes a local manifest. `.local-releases/` stays ignored because it is machine-local release state.

Future local versions are advanced through `npm run version:bump -- <patch|minor|major|x.y.z>`, which updates both `package.json` and `package-lock.json`. npm publication remains intentionally separate from local versioned consumption.

## 2026-05-19 19:54 CDT: Index Progress Artifact And Query Surface

Index and update now write a shared progress snapshot at `<indexPath>/progress/current.json`. The artifact is deliberately separate from generation manifests and Ladybug state: it can report `running`, `succeeded`, `failed`, or read-time `stale` without implying a new generation is active.

The first slice uses coarse phases only: `starting`, `discovering`, `planning`, `facts`, `scip`, `embeddings`, `graph`, `publishing`, `succeeded`, and `failed`. This gives humans and MCP agents visibility into long-running index work while avoiding a detailed event stream or terminal UI contract. Stale progress is derived by readers from a dead writer PID or old heartbeat instead of requiring crash cleanup.

CLI `index` and `update` now emit plain progress lines to stderr and preserve stdout for the final manifest. `--quiet` suppresses live progress output. The new CLI `progress` command returns the same progress result shape that `status` embeds optionally. MCP exposes `index_progress`, and `workspace_overview` includes progress when available so agents can detect in-flight or failed indexing before trusting query results.

Deferred work remains explicit: watch mode, retained run history, ETA, richer recent events, and lower-memory streaming counters are not part of this first contract.

## 2026-05-20 09:12 CDT: Substep Progress And Durable Run Events

Progress now keeps the coarse phase contract but adds substep evidence for hang diagnosis. `current.json` can report `currentRepo`, `currentStep`, and `startedStepAt`, while durable JSONL events under `<indexPath>/logs/index-<runId>.jsonl` record step starts, step finishes, durations, memory usage, warnings, rich failure details, discovery summaries, and SCIP quality reports.

The graph hot blocks now write a `step_started` event before entering synchronous work for module resolution, resolved-module graph application, framework graph application, relationship graph application, test-linking, and final call promotion. If one of these blocks hangs or the process dies, the last durable event identifies the repo and step that was entered.

`progress --events` and MCP `index_progress` with `includeEvents` expose bounded recent events without requiring callers to read log files directly. `progress` and `status` also expose index write-lock state from `.index-write.lock/owner.json` so active work, stale locks, and unlocked state are distinguishable.

SCIP runs now record output bytes, duration, exit code, bounded stdout/stderr summaries, and normalized definition/reference/occurrence counts. Tiny or empty successful SCIP output emits `scip-empty-or-tiny` as an explicit warning. Discovery summaries now include repo/package counts for included files, unsupported files, tsconfig exclusions, ignored directories, and files outside discovered source roots.

## 2026-05-20 11:02 CDT: Indexing Performance Corrections Without Quality Tradeoff

SCIP config inference no longer writes `tsconfig.json` into the indexed source repo. When a repo lacks `tsconfig.json`, the runner now writes an inferred TypeScript config under the index SCIP scratch directory and passes that config path as the project argument while keeping `--cwd` pointed at the source repo. This preserves source-relative SCIP document paths and avoids turning a no-op update into a config-change full rebuild.

The config fingerprint now includes `tsconfig.base.json` alongside `package.json`, `tsconfig.json`, and `jsconfig.json`. Module resolution already reads `tsconfig.base.json`, so the planner must treat edits to that file as config invalidation rather than a no-op source update.

Ladybug graph writes no longer create unused typed node projection tables for `Workspace`, `Repo`, `Package`, `File`, `Symbol`, `Test`, and `Chunk`. The canonical `CodeNode` table and existing typed relationship tables remain in place because query paths use `CodeNode`, `RELATES`, and typed edge tables.

Test-linking indirect traversal now builds a `fromId -> CodeEdge[]` index once before indirect coverage expansion. The traversal order still uses the existing edge rank and ID sort, but each expansion no longer filters the full edge set.

Chunk embedding generation now de-duplicates missing chunks by `embeddingInputHash` during a run. Cached embeddings are still reused first, and duplicate missing inputs are embedded once then assigned to every matching chunk, preserving chunk-level embedded/reused counts while reducing cold-path provider work.

## 2026-05-20 12:04 CDT: MCP Server Version Uses Package Metadata

MCP server initialization now reports the installed package version from `package.json` instead of a hardcoded server metadata value. The CLI and MCP server share the same package-version reader, so `code-intel --version` and MCP `serverInfo.version` stay aligned across local tarball installs and future version bumps.

## 2026-05-21 12:15 CDT: Capsule Workspace OOM Hardening

The capsule root workspace failure exposed two separate OOM paths: `scip-typescript` exhausted the default Node heap on the large JS monorepo, and the main process later exhausted heap during user-management relationship graph construction. The green-phase correction keeps the shared root index model but narrows graph work to the active repo's evidence. Imported-member lookup now requires current-repo edge ownership, transitive call expansion filters to current-repo endpoints, direct call edges are deduped before transitive expansion, and relationship graph no longer re-promotes call-evidence references that are already handled by the final call promotion step.

SCIP execution now has explicit sharding and process memory controls. The runner accepts `projectPaths`, invokes `scip-typescript` through Node with an explicit `--max-old-space-size`, and disables `scip-typescript` global caches. The indexer passes discovered package paths instead of relying on a single repo-root project. For packages without their own config, inferred shard configs are written under the index scratch area and extend the repo root `tsconfig.json` or `jsconfig.json` when present, preserving workspace path aliases without returning to a root-wide SCIP pass.

SCIP status handling now reports success only after the child process exits successfully. A failed child process records a warning and falls back to Tree-sitter relationships. A successful but tiny or zero-fact SCIP output also routes through Tree-sitter fallback, because a 92 byte `.scip` file with no facts is operationally equivalent to missing compiler evidence for graph construction.

The remaining memory hardening removes several all-at-once retention points. Per-repo SCIP facts are spilled to disk and streamed into the published `facts/scip.json`; diagnostics retain only per-file SCIP counts. File fingerprinting uses bounded concurrency instead of one repo-wide `Promise.all`, chunk embeddings flush missing inputs in small deduped batches, Ladybug rebuild consumes graph maps in batches instead of copied node and edge arrays, and JSON artifact writes stream to the atomic temp file instead of building one large formatted string.

Progress semantics now treat a live writer PID in a current step as running even when `updatedAt` is old, which avoids false stale reports during synchronous CPU-bound graph work. The progress schema also accepts `step_progress` events for future substep heartbeats. Write-lock state and stale-lock recovery now account for lock age as owner freshness evidence and treat EPERM from `process.kill(pid, 0)` as a live process rather than a dead owner.

## 2026-05-21 15:58 CDT: Sharded SCIP Red Phase Contract

The capsule OOM follow-up separates the temporary heap-pressure correction from the intended scalable model. Passing several package paths to one `scip-typescript` process reduces root breadth, but it does not create a reliable memory boundary because one V8 process can retain state across projects. The next contract is one child process per planned shard with repo-root `cwd`, a default heap no larger than 1 GB, disabled global caches, and raw output files keyed by repo plus shard identity.

Shard planning must be driven by code-intel discovery. Package shards cover discovered package source, while a separate repo-level shard covers discovered source files outside packages such as root tests, e2e files, or scripts. Inferred shard configs still extend the root TypeScript or JavaScript config to preserve aliases, but they must also apply discovery's generated/vendor excludes so ignored directories do not reappear through SCIP output.

Separate SCIP outputs are not equivalent until ingestion becomes repo-global. The red integration guard proves the current per-output ingest drops cross-package references from UI package files to core package definitions. The green path needs a two-pass merge: collect definitions from all shard outputs into a repo-level symbol catalog, then replay references from every shard against that catalog before SCIP fusion writes graph evidence.

## 2026-05-21 16:41 CDT: Sharded SCIP Green Phase

SCIP indexing now plans shards from code-intel discovery instead of treating a JavaScript monorepo as one compiler-wide project. Each discovered package gets its own shard constrained to the package files selected by discovery, discovered source files outside package roots get a repo-level shard with an inferred file list, and repos without packages fall back to a single repo shard. Every shard runs as its own `scip-typescript` child with the source repo as `cwd`, no global caches, and a default Node heap capped at 1 GB.

Raw SCIP artifacts are keyed by shard under `scip/<repo>/<shard>.scip`, and scratch fact spills are keyed by shard under `scip/facts/<repo>/<shard>.json`. The final published `facts/scip.json` remains one logical repo entry per repo by merging those shard spills at publish time, so downstream diagnostics and query behavior do not have to understand implementation scratch shards.

Inferred shard configs extend the package TypeScript or JavaScript config when present, otherwise the repo root config, preserving package-local options plus workspace aliases without launching a root-wide SCIP pass. The inferred configs constrain shard inputs with explicit `files` when code-intel discovery has already selected the shard files, and they exclude generated directories such as `.next`, `generated`, and `__generated__` so discovery-ignored code cannot leak back through compiler discovery.

SCIP ingestion is now merge-aware. A single shard can retain reference occurrences even when the matching definition lives in another shard, and the merge phase builds a repo-level definition catalog before rebuilding references from all shard occurrences. This preserves cross-package references while keeping each SCIP child bounded to a package or outside-package file group.

## 2026-05-21 20:43 CDT: Embedding Batch Progress

Large Jina-backed indexes can spend most of their runtime inside local ONNX inference after graph construction has completed. The progress contract now treats embedding batches as a durable substep so a live CPU-bound embedding phase is observable instead of only reporting the coarse `Embedding chunks` phase.

`embedGraphChunks` emits batch start and completion updates while preserving the incremental missing-input batching path. Index and update map those updates into `step_progress` events with `currentStep: embedding-batch`, `chunksVisited`, `chunksEmbedded`, `embeddingBatchSize`, `embeddingBatchesCompleted`, and memory telemetry through the existing progress event writer.

This does not tune Jina throughput yet. It gives `progress --events`, MCP `index_progress`, and CLI stderr enough evidence to distinguish active model inference from a dead or opaque embedding phase, and it gives later batch-size or cache tuning a measurable progress surface.

## 2026-05-21 22:04 CDT: Jina And Tree-sitter Embedding Input Hardening Track

Reference label: `workstream:jina-tree-sitter-embedding-input-hardening`

The next Jina work should not bypass local Jina embeddings or treat hash embeddings as the solution. The issue exposed by the capsule workspace run is the quality and cost of the input pipeline feeding Jina: generated artifacts can enter discovery, character-based truncation can hide relevant source, and count-based batching can make short chunks pay the padded-sequence cost of unrelated long chunks.

The hardening track is now ordered around validation gates. Token telemetry comes first so later decisions are based on Jina-token counts rather than character-length guesses. Artifact exclusion follows because generated and hidden cache/build paths are bad source candidates before Tree-sitter, SCIP, graph, exact search, or embeddings ever run. Length-aware batching is next because it should improve runtime without changing chunk text or retrieval quality.

Truncation-loss eval targets must be authored before structural splitting changes. Those target cases should fail against the current blind truncation behavior and identify whether the miss is discovery, chunking, embedding, query, or ranking. The final implementation step is token-aware Tree-sitter splitting for oversized real source chunks, preserving parent context and ranges while eliminating silent real-source truncation.

## 2026-05-21 23:33 CDT: Jina Embedding Input Hardening Complete

The hardening track is implemented without bypassing Jina or falling back to hash indexing. Jina now owns token counting through the Transformers tokenizer for the active model, while the deterministic hash provider implements the same token-counting contract for offline tests and comparison runs.

Discovery now excludes hidden dot artifact directories by default, including `.vercel`, `.next`, `.nx`, `.turbo`, `.cache`, and `.expo`, alongside existing build/cache/vendor directories. The same ignore policy is shared with exact search, and hidden source-like directories can be explicitly allowlisted through discovery configuration or direct search options.

Embedding input preparation no longer character-truncates real source. Parsed chunks keep full source content, then the file-fact layer prepares embedding-input chunks under a 512-token target budget capped by the provider maximum. Oversized Tree-sitter-owned chunks are split into deterministic child chunks with stable ranges, source hashes, parent split metadata, and `embeddingInput*` telemetry; long-line fallback splits remain bounded and are marked without pretending to be normal unsplit chunks.

Embedding inference now groups missing unique inputs by measured token length before provider calls. This preserves input text, model, normalization, dimensions, and chunk-to-vector assignment while reducing padded-token waste. Progress events, manifests, eval reports, and benchmark reports now expose total unique inputs, duplicate input chunks, token percentiles, max tokens, split counts, truncation fallback counts, batch max tokens, padded-token totals, and padding-waste ratio.

Validation covered both fixture and real-repo paths. Focused hardening tests passed, the full suite passed with 38 files and 181 tests, Jina general eval passed required 33/33, Jina and hash adversarial evals passed required 46/46, target 45/45, and scoreboard 5/5, and the new after-truncation target ranks raw source first while the `.vercel` decoy is absent. A local Jina self-index of this repo completed with 194 files, 1,332 chunks, 1,268 unique inputs, 190 split chunks, token p95 505, max 512, and zero truncation fallbacks.

## 2026-05-22 08:19 CDT: Generation Publish Reliability Workstream

Reference label: `workstream:generation-publish-reliability`

The 0.4.0 capsule `js-monorepo` proof run moved the blocker forward. Discovery, package SCIP, relationship graph construction, and all Jina embeddings completed, but the bounded run timed out during final Ladybug generation rebuild and publish before a manifest was written. That means the index remained unusable even though the expensive embedding phase finished.

The next workstream is `Workstream 14: Generation Publish Reliability And Interrupt Handling`. Its first priority is observability inside `LadybugGraphStore.rebuild()`, because the current `Writing graph generation` progress event is emitted before schema creation, node writes, edge writes, vector-index creation, close/checkpoint, and publish. The reported node and edge counts are planned in-memory graph sizes, not confirmed persisted rows.

The second priority is operational cleanup. A wrapper `SIGINT` currently leaves stale progress, a stale write lock, and partial generation artifacts without a terminal interrupted or cancelled event. The next implementation should handle interrupts and controlled timeouts by closing graph resources, releasing locks, and classifying partial generations as failed local state.

SCIP coverage remains a separate gap. Six large package/site shards still OOM around the default 1 GB child-process heap, so the scalable fix should prefer finer shard planning before raising the default heap. Jina work is no longer the primary blocker for this failure, but tail-batch economics and ambiguous unique-input versus chunk-assignment counters should be cleaned up while the next release hardens publish reliability.

## 2026-05-22 09:25 CDT: Generation Publish Reliability Implemented

`LadybugGraphStore.rebuild()` now emits durable graph-store substeps for schema creation, node writes, edge writes, vector-index creation, and close/checkpoint. Node, edge, chunk, and batch counters are updated only after successful Ladybug write batches, so progress no longer reports planned graph sizes as persisted rows.

Publishing now writes generation-local facts and diagnostics before writing the generation manifest, then publishes the active pointer, then copies the root manifest and workspace convenience files. The active manifest remains the queryable boundary, and failed rebuilds write `failed.json` tombstones into the partial generation directory when possible.

CLI `index` and `update` install signal handlers for `SIGINT` and `SIGTERM`. On termination, they write a terminal failed progress event, close active graph resources, remove `.index-write.lock`, and keep the handler installed until cleanup completes so repeated signals do not fall through to Node's default process kill before lock cleanup.

The benchmark harness now includes a deterministic graph-store publish scenario independent of discovery, SCIP, relationship construction, and embedding inference. The default hash benchmark exercised 10,000 nodes, 100,000 edges, and 2,000 chunk vectors with `failureClassification: none`; the observed time was dominated by edge writes at 163,422 ms out of 170,683 ms total, making the next graph-storage optimization target concrete.

Large package SCIP planning now splits oversized package shards by source root and bounded file groups before raising heap limits. The existing repo-level outside-package shard behavior and cross-shard merge contract remain unchanged.

Embedding progress now reports both unique input counters and chunk assignment counters, plus elapsed and estimated remaining inference time when batch progress can compute it. MCP stdio lifecycle coverage now proves a progress-only session exits promptly after SDK client close so idle query-engine timers or Ladybug handles do not keep the process alive.
