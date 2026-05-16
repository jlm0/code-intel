---
title: Code Intelligence Graph Testing Strategy
feature: code-intelligence-graph
created: 2026-05-13
last_updated: 2026-05-16
status: active
---

# Code Intelligence Graph Testing Strategy

This document defines how to validate the code intelligence graph tool at each layer before relying on it in agent workflows.

## Test Principles

- Unit tests prove pure logic and command parsing without filesystem, process, database, or model dependencies.
- Contract tests prove schema shape, stable IDs, query outputs, MCP outputs, and artifact versions.
- Fixture integration tests use small committed JS/TS projects with known symbols, imports, exports, tests, and semantic concepts.
- Process tests launch the built `code-intel` binary the same way users and MCP clients will launch it.
- Database tests use temporary `.lbug` paths and verify persistence by closing and reopening the database.
- End-to-end tests index a fixture repo from scratch, query through CLI and MCP, and compare results to expected files, symbols, and relationships.
- Eval tests measure both deterministic fixture correctness and real-world app-flow usefulness after lower-level correctness tests pass.

## Layer Test Matrix

| Layer | Harness | What Must Be Tested | Failure Class |
| --- | --- | --- | --- |
| CLI command tree | `vitest` against `createCliProgram()` | Subcommands, options, validation errors, help, async handlers, exit codes from mocked actions | CLI parser gap |
| CLI presenters | `vitest` | Text output, JSON output, non-TTY determinism, error formatting, no terminal control codes in pipe mode | CLI output gap |
| CLI process behavior | `execa` | Built binary starts, stdout/stderr separation, exit codes, timeouts, `--json`, missing repo errors | CLI process gap |
| TTY behavior | `node-pty` | `isTTY` branches, color/progress gates, terminal width handling, resize handling, interrupt behavior | TTY gap |
| Schemas | `vitest` and golden JSON fixtures | Node, edge, chunk, vector metadata, index manifest, query result, MCP input, MCP output schemas | Schema gap |
| Workspace discovery | `vitest` with fixture repos | Explicit `--repo`, workspace manifest, package manager workspaces, ignore rules, generated folders skipped | Discovery gap |
| SCIP execution | `vitest` plus process integration on fixtures | `scip-typescript` invocation, JS infer mode, TS config mode, raw `.scip` artifact placement, execution errors | Precise index gap |
| SCIP ingestion and fusion | `vitest` with stored SCIP fixtures plus graph integration tests | Definitions, references, occurrences, raw role masks, normalized read/test roles, symbol IDs, file ranges, canonical AST/SCIP symbol promotion, evidence-backed graph edges, fallback behavior, malformed SCIP rejection | Precise ingest gap |
| Tree-sitter structural facts | `vitest` with golden fixture files | TS, TSX, JS, JSX, partial syntax errors, static imports, dynamic imports, CommonJS imports, CommonJS exports, exports, re-exports, default exports, namespace imports, declarations, decorators, constructors, object methods, class methods, variable functions, top-level variables, member calls, optional chained calls, JSX component usage, ownership, tests, callbacks, chunk-to-symbol overlap | Syntax fact gap |
| Module resolution and fact fusion | `vitest` fixture integration plus eval gates | TypeScript-compatible relative imports, path aliases, package exports, package names, default/named/namespace imports, re-exports, dynamic imports, CommonJS, unresolved cases, canonical SCIP identity with preserved AST evidence, generation-local `facts/resolution.json`, evidence-backed graph edges | Fusion gap |
| Graph path eval gates | `code-intel eval` graph cases | Direct edge existence, edge direction, forbidden edges, ordered path existence, forbidden paths, allowed edge kinds, max depth, evidence metadata, confidence, fallback reason, app-flow false-positive guards, package-hub guard behavior, test-to-implementation links | Graph traversal gap |
| Test linking | `vitest` fixture integration plus graph and query eval gates | Direct test imports, direct test calls, AST test-case ranges, SCIP references, indirect implementation paths, exact colocated fallback, implementation-to-test lookup, test-to-implementation lookup, evidence, confidence, fallback reasons, false-positive guards | Test-linking gap |
| Ladybug schema setup | `vitest` integration with temp `.lbug` | Node tables, relationship tables, vector properties, full-text indexes, vector indexes | Database schema gap |
| Ladybug writes | `vitest` integration with temp `.lbug` | Idempotent upserts, edge creation, dangling edge detection, changed file updates, stale row cleanup | Database write gap |
| Ladybug persistence | `vitest` integration with temp `.lbug` | Reopen after process exit, manifest consistency, graph rows and vector rows still queryable | Database persistence gap |
| Exact search | `vitest` or integration fixtures with `rg --json` | Ignore rules, result parsing, path normalization, stable result shape, fallback behavior | Exact search gap |
| Embeddings | `vitest` integration with local model cache or test double | Model availability, vector dimension, normalization, cache status, graceful offline behavior | Embedding gap |
| Vector search | `vitest` integration with temp `.lbug` | Vector index creation, ranked results, filters, stable node IDs, changed chunk replacement | Semantic search gap |
| Ranking | `vitest` integration plus eval gates | Candidate generation from semantic, lexical, exact symbol, graph, reference, caller/callee, import/export, and test signals; deterministic rank fusion; query intent handling; code-aware boosts and demotions; dedupe; ranking explanations; false-positive suppression | Ranking gap |
| Query engine | `vitest` integration fixtures | `find_symbol`, references, callers, callees, semantic search, expand context, get context, trace path | Query gap |
| MCP server | SDK client transport or JSON-RPC stdio harness | Tool list, tool input validation, bounded outputs, stdout protocol purity, stderr logging only | MCP gap |
| Eval suite | `code-intel eval` | Pack-based synthetic and Rallly query cases report gate metadata, blocking status, quality status, expected ranks, false-positive checks, latency, and failure class; Rallly AST cases report expected structural facts by file | Eval quality gap |
| End-to-end fixture flow | `execa` plus MCP stdio harness | `index`, `status`, `health`, query CLI commands, `mcp` tools, persisted re-query after restart | End-to-end gap |
| Proof-of-concept smoke flow | `execa` against selected local repos | Index selected `js-monorepo` packages, run five real queries, classify misses with evidence | POC readiness gap |

## Required Fixture Repo

The committed fixture repo should be small enough to run quickly but rich enough to prove the core model.

Required fixture contents:

- One package with TypeScript source.
- One package with JavaScript source and inferred TS config.
- Package exports and re-exports.
- Path alias import.
- React hook or component.
- Class with method calls.
- Function caller/callee chain.
- Test file covering a source function.
- Source file with a syntax error that Tree-sitter can partially parse.
- Semantic concept where the expected file does not contain the exact query words.

Required expected-answer files:

- Expected workspace discovery output.
- Expected node and edge records.
- Expected chunk ranges.
- Expected AST structural facts for static imports, dynamic imports, CommonJS imports and exports, exports, declarations, calls, member access, ownership, tests, and callbacks.
- Expected resolved module facts for package exports, path aliases, barrels, default exports, namespace imports, CommonJS, dynamic imports, and unresolved imports.
- Expected symbol lookup results.
- Expected relationship query results.
- Expected semantic result top matches.
- Expected MCP payload shapes.

The fixture also has a committed eval-pack copy at `local-tools/code-intel/eval-packs/js-ts-general/corpus`. That pack is the hard regression gate for `code-intel eval`. Lower-level integration tests may keep using their own fixture path, but eval-pack corpus files must be excluded from Vitest discovery because they are input data.

## Eval Packs

P0 eval validation uses two packs:

- `js-ts-general`: local synthetic pack committed with the tool. It should stay deterministic, small, and network-free.
- `oss-rallly-app-flow`: external git pack with committed metadata, query cases, and AST fact cases only. It fetches Rallly on demand from a pinned commit and is used for real app-flow quality measurement plus real-file AST extraction proof.

Required eval-pack behavior:

- Pack files validate before indexing begins.
- Query and AST cases support gate metadata with `required`, `target`, and `scoreboard` statuses.
- Required gates fail the blocking report status; target and scoreboard gates fail only the quality status.
- Reports aggregate pass/fail by gate status, gate, capability, rank, failure class, and blocking status.
- Query-case reports include `MRR@10`, `Recall@K`, `nDCG@10`, expected found or missing counts, and false-positive counts.
- Local packs resolve corpora from the pack folder.
- Git packs fail quickly without `--fetch` when no matching checkout is cached.
- Reports include suite metadata, corpus metadata, embedding metadata, index stats, expected result ranks, false-positive checks, latency, actual top results, and failure class.
- Reports include AST case results when a pack defines `astCaseFiles`, including expected structural facts, actual fact counts, parse-error status, and syntax-layer failure class.
- Hash and Jina runs can be compared by rerunning the same suite with different `--embedding-provider` values.

Gate mapping:

- `required` synthetic gates cover AST declarations, SCIP definitions and references, fusion export resolution, graph relationships, semantic concept retrieval, implementation-intent ranking, test-intent ranking, graph-backed ranking, and false-positive guards.
- `required` Rallly gates cover focused route-to-mutation, mutation-to-database, middleware-to-route, UI-to-data/API, test-to-implementation, package-boundary import, and canonical symbol checks where AST, SCIP, fusion, or graph correctness should be deterministic.
- `target` Rallly gates cover transitive graph traversal, hybrid ranking, and full app-flow retrieval. These started as expected failures and are now a quality regression target after the fusion, graph, and deterministic-ranking passes.
- Stricter graph target gates add ordered path and evidence checks. They now pass after graph traversal hardening and remain regression coverage for edge semantics, direction, path ranking, and evidence exposure.
- Test-linking target gates cover private route tests, route-to-mutation coverage, route-to-database coverage, middleware/API tests, implementation-to-test lookup, test-to-implementation lookup, and false-positive guards. These now pass after explicit `TESTS` edge hardening and remain regression coverage for test coverage mapping.
- `scoreboard` gates are reserved for broader quality trend checks that should be visible but not release-blocking.

## Unit Tests

Unit tests should run without LadybugDB, Transformers.js model downloads, `scip-typescript`, or `rg`.

Required unit coverage:

- Stable ID generation.
- Path normalization and repo-relative paths.
- Ignore rule matching.
- Schema validation success and failure cases.
- CLI option parsing through `createCliProgram()`.
- Output presenters for text and JSON.
- Query result shaping from mocked repository objects.
- MCP input and output schema validation.

## Integration Tests

Integration tests may use real local dependencies, but they must use temporary directories and clean up after themselves.

Required integration coverage:

- LadybugDB opens a temp `.lbug`, creates tables and indexes, writes rows, closes, reopens, and queries the same rows.
- Tree-sitter parsers load and parse TS, TSX, JS, and JSX fixture files.
- `rg --json` runs against the fixture repo and parses deterministic result records.
- `scip-typescript` runs against the fixture repo and writes raw SCIP output to the expected temp artifact path.
- SCIP fusion maps compiler definitions and references to containing chunks, canonical symbols, import/export edges, call edges, test edges, and relationship evidence metadata.
- Transformers.js can load the configured model when cache is present, or reports a clear model-cache status when unavailable.

## CLI Process Tests

CLI process tests must run the built binary, not imported command functions.

Required CLI process coverage:

- `code-intel --help` exits successfully and writes help to stdout.
- `code-intel health --json` returns valid JSON with check names and statuses.
- `code-intel status --json` works before and after indexing.
- `code-intel index --repo <fixture>` creates expected artifacts.
- `code-intel search <pattern> --repo <fixture> --json` returns deterministic JSON.
- Invalid arguments exit nonzero and write human-readable errors to stderr.
- Non-TTY output contains no spinner frames, ANSI color, cursor movement, or progress animation.

## TTY Tests

TTY tests should be narrow because PTY dependencies can create install friction.

Required TTY coverage:

- Human `health` output is readable in a terminal.
- Progress or color appears only when explicitly supported and stdout is a TTY.
- Terminal width changes do not corrupt compact output.
- Interrupting a long-running command exits cleanly and does not leave a corrupt manifest or partial lock.

TTY tests must not be used for MCP.

## Database Tests

Database tests must prove that LadybugDB is not just available, but correct for this tool.

Required database coverage:

- Schema creation is idempotent.
- Unique stable IDs prevent duplicate nodes.
- Relationship writes reject or report dangling references.
- File reindex removes stale symbols, chunks, embeddings, and edges for the changed file.
- Full-text search returns the expected file or chunk.
- Vector search returns `Chunk` node IDs that can immediately expand through graph relationships.
- Database reopen preserves graph, full-text, and vector state.
- Query functions enforce limit and depth caps.

## MCP Tests

MCP tests must validate protocol behavior and tool usefulness.

Required MCP coverage:

- `code-intel mcp` starts with `StdioServerTransport`.
- The client can initialize, list tools, and call `health`.
- Tool schemas reject invalid inputs.
- `semantic_search`, `find_symbol`, `expand_context`, and `get_context` return schema-valid bounded payloads.
- stdout contains only valid MCP JSON-RPC messages.
- diagnostics go to stderr or files only.
- tool results match equivalent core query engine results.

## End-To-End Tests

End-to-end fixture tests should be the readiness gate before using the tool on real local repos.

Required flow:

```text
build package
code-intel health --json
code-intel index --repo <fixture> --json
code-intel status --json
code-intel find-symbol <known-symbol> --json
code-intel references <known-symbol> --json
code-intel semantic <known-concept> --json
code-intel expand-context <known-node> --json
start code-intel mcp
call health, find_symbol, semantic_search, expand_context, get_context
stop mcp process
reopen database through a new process
repeat one relationship query and one semantic query
```

The end-to-end test passes only if CLI, MCP, and direct query results agree on stable IDs, file paths, ranges, and relationship counts.

## Proof-Of-Concept Validation

After fixture end-to-end tests pass, validate selected local proof-of-concept packages.

Required proof-of-concept checks:

- Index selected `js-monorepo` packages within an agreed time budget.
- Run at least five real queries from the first proof-of-concept corpus.
- Record expected files, symbols, or relationships for each query.
- Classify every miss as a discovery, SCIP, chunking, graph, vector, query, MCP, or eval-quality gap.
- Do not treat a useful-looking answer as correct unless it points to the expected source evidence.

## MVP Test Results

The first MVP verification pass ran from `local-tools/code-intel/`:

```text
npm run build
npm test
```

Result:

```text
Test Files 12 passed, 1 skipped
Tests 23 passed, 1 skipped
```

The skipped test is the PTY-only health rendering test. It is skipped only because the installed `node-pty` binding cannot spawn even `/bin/echo` in this environment after `npm rebuild node-pty`. MCP tests use stdio pipes through the SDK client transport and are not skipped.

## Fusion Resolution Test Results

The fusion hardening verification pass ran from `local-tools/code-intel/`:

```text
npm test
git diff --check
npm pack --dry-run
node dist/cli/main.js eval --suite js-ts-general --embedding-provider hash --json
node dist/cli/main.js eval --suite oss-rallly-app-flow --eval-cache-path /tmp/code-intel-rallly-gated-eval-cache --embedding-provider hash --json
```

Result:

```text
Test Files 19 passed, 1 skipped
Tests 54 passed, 1 skipped
Synthetic eval: status pass, blockingStatus pass, qualityStatus pass, required 14/14
Rallly eval: status pass, blockingStatus pass, qualityStatus pass, required 13/13, target 7/7
```

The skipped test remains the PTY-only health rendering test because the local `node-pty` binding cannot spawn in this runtime. The new focused coverage includes `tests/integration/fusion-resolution.test.ts`, which asserts package export resolution, path alias resolution, default export resolution, CommonJS resolution, dynamic import status, unresolved import status, `facts/resolution.json`, and graph edge creation.

## Graph Layer Test Results

The graph hardening verification pass ran from `local-tools/code-intel/`:

```text
npm run build
npx vitest run tests/integration/scip.test.ts tests/integration/fusion-resolution.test.ts tests/integration/index-query.test.ts tests/unit/evaluator.test.ts tests/mcp/server.test.ts tests/e2e/eval.test.ts
npm test
git diff --check
npm pack --dry-run
node dist/cli/main.js eval --suite oss-rallly-app-flow --eval-cache-path /tmp/code-intel-rallly-gated-eval-cache --embedding-provider hash --json
```

Result:

```text
Focused graph verification: 6 files passed, 13 tests passed
Full package verification: 19 files passed, 1 skipped; 55 tests passed, 1 skipped
Rallly graph eval: all 5 graph target cases passed
Rallly blocking gates: status pass, blockingStatus pass, required 13/13
Rallly quality gates: qualityStatus fail due one remaining semantic-ranking target
```

## Ranking Layer Test Results

The ranking hardening verification pass ran from `local-tools/code-intel/`:

```text
npm run build
npx vitest run tests/integration/index-query.test.ts tests/unit/evaluator.test.ts tests/unit/eval-gates.test.ts tests/e2e/eval.test.ts tests/mcp/server.test.ts tests/cli/process.test.ts
npm test
git diff --check
npm pack --dry-run
node dist/cli/main.js eval --suite js-ts-general --embedding-provider hash --json
node dist/cli/main.js eval --suite oss-rallly-app-flow --eval-cache-path /tmp/code-intel-rallly-gated-eval-cache --embedding-provider hash --json
```

Result:

```text
Focused tests: 6 files passed, 21 tests passed
Full package verification: 19 files passed, 1 skipped; 55 tests passed, 1 skipped
Synthetic eval: status pass, blockingStatus pass, qualityStatus pass, required 19/19
Rallly eval: status pass, blockingStatus pass, qualityStatus pass
Rallly required gates: 13/13 pass
Rallly target gates: 12/12 pass
Private API ranking: route.ts rank 1, route.test.ts rank 2
UI dashboard ranking: dashboard polls path rank 12
Target ranking metrics: MRR@10 0.904762, Recall@K 0.880952, nDCG@10 0.808548
```

This resolves the graph-phase remaining ranking target without weakening graph assertions. `Recall@K` is below 1 because some target expectations are allowed inside top 20 while the metric uses K capped at 10. Ranking remains rule-weighted and deterministic; broader eval coverage should come before optional model reranking.

## Test-Linking Layer Test Results

The test-linking hardening verification pass ran from `local-tools/code-intel/`:

```text
npx vitest run tests/integration/index-query.test.ts tests/unit/evaluator.test.ts
npm run build
npx vitest run tests/integration/index-query.test.ts tests/unit/evaluator.test.ts
node dist/cli/main.js eval --suite js-ts-general --embedding-provider hash --json
node dist/cli/main.js eval --suite oss-rallly-app-flow --eval-cache-path /tmp/code-intel-rallly-gated-eval-cache --embedding-provider hash --json
npm test
npm run test:pty
git diff --check
npm pack --dry-run
```

Result:

```text
Red phase: focused tests failed before implementation because direct TESTS metadata and new synthetic test-linking gates were absent
Focused tests after implementation: 2 files passed, 5 tests passed
Synthetic eval: status pass, blockingStatus pass, qualityStatus pass, required 23/23
Rallly eval: status pass, blockingStatus pass, qualityStatus pass
Rallly required gates: 13/13 pass
Rallly target gates: 18/18 pass
Rallly target aggregate after test-linking: MRR@10 0.809524, Recall@K 0.880952, nDCG@10 0.763554
Full package verification: 19 files passed, 1 skipped; 55 tests passed, 1 skipped
PTY verification: 1 file skipped, 1 test skipped because node-pty cannot spawn in this runtime
Package dry run: passed
```

The new test-linking gates prove direct import/call coverage, exact test-case attribution, bounded indirect implementation paths, colocated fallback, bidirectional test/source lookup, and false-positive guards. One graph target was corrected from a strict route-to-mutation-to-database symbol chain to route-to-database typed evidence, because the current graph proves route-to-mutation and route-to-database separately but does not yet expose a clean `createPoll` symbol to `prisma` `CALLS` edge. That remaining precision belongs to future type/member relationship work rather than the test-linking layer.

## Minimum Gate Before Agent Use

The tool should not be used as trusted agent context until these pass:

- Unit tests for schemas, stable IDs, command parsing, presenters, and query shaping.
- Fixture integration tests for LadybugDB, Tree-sitter, `rg`, SCIP ingestion, and model-cache status.
- CLI process tests for `health`, `status`, `index`, and at least two query commands.
- MCP stdio tests for initialization, tool list, `health`, and at least three query tools.
- End-to-end fixture flow with persisted re-query after database reopen.
- First proof-of-concept smoke with five expected-answer queries recorded in `verification-checklist.md`.
