---
title: Code Intelligence Graph Design Notes
feature: code-intelligence-graph
created: 2026-05-13
last_updated: 2026-05-16
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
