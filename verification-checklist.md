---
title: Code Intelligence Graph Verification Checklist
feature: code-intelligence-graph
created: 2026-05-13
last_updated: 2026-05-16
status: active
---

# Code Intelligence Graph Verification Checklist

This checklist tracks design readiness, implementation validation, and open risks for the local JS/TS code intelligence graph feature.

## Feature Docs

- [x] `README.md` created.
- [x] `feature-spec.md` created.
- [x] `feature-plan.md` created.
- [x] `feature-design-notes.md` created.
- [x] `verification-checklist.md` created.
- [x] `testing-strategy.md` created.
- [x] `research/01-local-stack-reference.md` created.
- [x] `feature-design-notes.md` corrected to chronological same-day sequence entries.
- [ ] Jordy reviewed and accepted the feature docs.
- [x] Feature docs updated after review decisions.

## Stack Verification

- [x] `scip-typescript` upstream usage checked.
- [x] Tree-sitter upstream Node usage checked.
- [x] LadybugDB Node usage checked.
- [x] LadybugDB vector extension checked.
- [x] LanceDB local TypeScript usage checked as a comparison and fallback.
- [x] Transformers.js embedding usage checked.
- [x] Jina code embedding model usage checked.
- [x] MCP TypeScript server usage checked.
- [x] Commander CLI usage checked.
- [x] Vitest test runner usage checked.
- [x] Execa process test harness usage checked.
- [x] Node child process stdio behavior checked.
- [x] node-pty TTY harness usage checked.
- [x] FalkorDBLite rejected due SSPL.
- [x] CozoDB pre-1.0 stability caveat captured.
- [x] LadybugDB selected over CozoDB.
- [x] Kuzu archive status captured as a rejection reason.

## CLI Skeleton

- [x] `local-tools/code-intel/package.json` created.
- [x] TypeScript build configured.
- [x] `commander` command tree configured.
- [x] `createCliProgram()` command factory implemented.
- [x] `code-intel status` implemented.
- [x] `code-intel health` implemented.
- [x] `code-intel mcp` implemented.
- [x] CLI runs from `/Users/jordy/Documents/GitHub/capsule-org` for the proof-of-concept.
- [x] Non-TTY `--json` output is deterministic.
- [x] TTY-only formatting is gated behind terminal detection.

## Health Checks

- [x] Node.js version check requires 20 or newer.
- [x] `rg` availability check.
- [x] `scip-typescript` availability check.
- [x] Tree-sitter JS parser load check.
- [x] Tree-sitter TS/TSX parser load check.
- [x] LadybugDB persistent `.lbug` path open check.
- [x] LadybugDB vector extension load check.
- [x] Transformers.js model-cache check.
- [x] MCP stdio startup check.
- [x] MCP stdout pollution check.

## Schema Contract

- [x] Schema version defined.
- [x] Node schemas defined.
- [x] Edge schemas defined.
- [x] Chunk schemas defined.
- [x] Vector metadata schemas defined.
- [x] MCP input schemas defined.
- [x] MCP output schemas defined.
- [x] Index manifest schema defined.
- [x] Invalid records fail validation tests.

## Indexing

- [x] Workspace discovery works on fixture repo.
- [x] Workspace discovery works on `js-monorepo` as the first real proof-of-concept corpus.
- [x] Package discovery captures package names.
- [x] Package discovery captures exports.
- [x] Package discovery captures dependencies.
- [x] `scip-typescript` runs on fixture repo.
- [x] `scip-typescript` runs on selected `js-monorepo` packages as the first real proof-of-concept corpus.
- [x] SCIP definitions ingest into graph nodes.
- [x] SCIP references ingest into graph edges.
- [x] SCIP occurrences, raw role masks, read/test roles, ranges, and enclosing ranges ingest into normalized facts.
- [x] Normalized SCIP facts persist to generation-local `facts/scip.json`.
- [x] SCIP definitions promote matching Tree-sitter declarations to canonical symbols instead of duplicate AST and SCIP symbols.
- [x] Tree-sitter chunks fixture TS files.
- [x] Tree-sitter chunks fixture TSX files.
- [x] Tree-sitter chunks fixture JS files.
- [x] Tree-sitter structural facts cover imports, exports, re-exports, default exports, namespace imports, declarations, member calls, ownership, tests, duplicate method names, and partial syntax.
- [x] Chunks link back to SCIP symbols when ranges overlap.

## Graph Store

- [x] LadybugDB opens with `.code-intel/code-intel.lbug`.
- [x] Graph data persists after process exit.
- [x] `find_symbol` query works from graph.
- [x] `get_references` query works from graph.
- [x] `get_callers` query works from graph.
- [x] `get_callees` query works from graph.
- [x] `trace_path` query works from graph.
- [x] Graph health detects dangling edges during writes.
- [x] Import and export facts become graph nodes with `IMPORTS` and `EXPORTS` edges from owning files.
- [x] SCIP-backed `REFERENCES`, `CALLS`, `IMPORTS`, `EXPORTS`, `TESTS`, and `MENTIONS` edges include relationship evidence metadata.
- [x] Query relationship results expose SCIP versus Tree-sitter fallback provenance.
- [x] Shared graph traversal enforces allowed edge kinds, direction, max depth, evidence requirements, confidence, and fallback metadata.
- [x] `trace_path` CLI and MCP outputs expose ordered path nodes plus path edge metadata.
- [x] `CALLS` edges require observed call evidence instead of import-only evidence.
- [x] `TESTS` edges preserve test context, SCIP evidence, and Tree-sitter test evidence where available.
- [x] Graph traversal avoids package nodes as accidental app-flow bridges.
- [x] Rallly graph target gates pass for route-to-mutation-to-database, middleware-to-route, UI-to-data-loader, test-to-implementation, and false-positive guard cases.

## Vector Store

- [x] Jina embedding model loads locally.
- [x] Deterministic local MVP chunk embeddings are generated.
- [x] Chunk embeddings are stored on Ladybug graph `CodeNode` chunk nodes.
- [x] Ladybug vector index is created on chunk embeddings.
- [x] `semantic_search` returns ranked results.
- [x] Semantic results are returned as graph nodes.
- [x] Changed chunks update without stale duplicates by full rebuild.

## MCP

- [x] MCP server starts with `code-intel mcp`.
- [x] MCP server does not write logs to stdout in stdio mode.
- [x] `health` tool works.
- [x] `workspace_overview` tool works.
- [x] `search_text` tool works.
- [x] `semantic_search` tool works.
- [x] `find_symbol` tool works.
- [x] `expand_context` tool works.
- [x] `get_context` tool works.
- [x] Tool outputs are bounded and schema-validated.
- [x] MCP process test uses stdio pipes or SDK client transport, not PTY.

## CLI And Process Tests

- [x] Vitest unit tests cover command parsing.
- [x] Vitest unit tests cover output presenters.
- [x] Execa tests cover CLI stdout, stderr, exit code, and timeout behavior.
- [x] Execa tests cover non-TTY JSON output.
- [ ] node-pty tests cover TTY-only output behavior.
- [x] node-pty tests are isolated from MCP stdio tests.

## Layered Validation Gates

- [x] Unit gate passes for stable IDs, schemas, command parsing, presenters, ignore rules, and query result shaping.
- [x] Contract gate passes for schema-validated node, edge, chunk, manifest, query, and MCP payloads.
- [x] Workspace discovery integration gate passes on fixture repos.
- [x] SCIP integration gate passes on fixture repos and stored SCIP fixtures.
- [x] Tree-sitter integration gate passes on TS, TSX, JS, JSX, and partial-syntax fixture files.
- [x] LadybugDB schema and write gate passes against a temp `.lbug` path.
- [x] LadybugDB persistence gate passes after close and reopen.
- [x] Exact search gate passes with `rg --json` fixture output.
- [x] Embedding and vector gate passes with deterministic local embeddings; Jina model-cache remains open.
- [x] Query engine gate passes for symbol, reference, caller, callee, semantic, context, and trace queries.
- [x] CLI process gate passes against the built `code-intel` binary.
- [x] MCP stdio gate passes through SDK client transport or JSON-RPC pipes.
- [x] Fixture end-to-end gate passes across index, CLI query, MCP query, process restart, and persisted re-query.
- [x] First proof-of-concept smoke gate passes with five expected-answer queries.

## Eval Cases

- [x] Synthetic eval pack: exported function definition and references.
- [x] Synthetic eval pack: re-exported symbol.
- [x] Synthetic eval pack: path alias import.
- [x] Synthetic eval pack: React hook.
- [x] Synthetic eval pack: class method.
- [x] Synthetic eval pack: caller/callee chain.
- [x] Synthetic eval pack: test coverage edge.
- [x] Synthetic eval pack: SCIP type-import reference.
- [x] Synthetic eval pack: SCIP class-method callee relationship.
- [x] Synthetic eval pack: semantic query where exact term is absent.
- [x] Synthetic eval pack: false-positive guard.
- [x] Rallly OSS app-flow pack metadata and case files created.
- [x] Rallly source fetch is on demand and pinned, not vendored.
- [x] Rallly hash-backed eval path runs and reports quality failures instead of silently passing.
- [x] Eval cases support `required`, `target`, and `scoreboard` gate metadata.
- [x] Synthetic eval cases are required hard regression gates.
- [x] Rallly cases are grouped by general JS/TS capabilities instead of Rallly-only trivia.
- [x] Rallly target gates capture known ranking, graph traversal, and full app-flow improvement targets.
- [x] Eval JSON reports include blocking status, quality status, gate summaries, capability summaries, rank summaries, and failure-class summaries.
- [x] Proof-of-concept query: known SDK hook.
- [x] Proof-of-concept query: known package export.
- [x] Proof-of-concept query: known cross-package dependency.
- [x] Proof-of-concept query: known test relationship.
- [x] Proof-of-concept query: known semantic concept.

## Open Risks

- [x] Confirm LadybugDB graph performance and reliability on selected `js-monorepo/packages/react-sdk` proof-of-concept corpus.
- [x] Confirm LadybugDB vector search performance on selected local code chunks.
- [x] Confirm Jina code embeddings are accurate enough for JS/TS concept search.
- [ ] Decide whether model artifacts should be preseeded into `.code-intel/models`.
- [x] Decide if LanceDB fallback is needed after Ladybug vector eval.
- [x] Decide if a future graph DB swap is needed if LadybugDB creates operational friction.
- [ ] Confirm `node-pty` install friction is acceptable as a dev-only dependency before extracting the tool to its own repo.
- [x] Switch default semantic provider from `local-hash-v1` to Jina Transformers.
- [x] Add incremental changed-file reindexing instead of full rebuild.
- [x] Add stronger eval harness with synthetic and Rallly eval packs.
- [x] Add richer AST structural facts before ranking-only remediation.
- [x] Add SCIP-first symbol and relationship accuracy before ranking-only remediation.

## 2026-05-13 Validation Evidence

- Created feature docs after reading `local-doc/agent-workflows/local-documentation.md` and current feature-doc patterns.
- Verified current upstream usage details for SCIP, `scip-typescript`, Tree-sitter, LadybugDB, Ladybug vector search, LanceDB as a fallback, Transformers.js, the selected Jina embedding model, and MCP TypeScript server setup.
- Verified current upstream usage details for Commander, Vitest, Execa, Node child process stdio, node-pty, and MCP stdio transport. Locked the CLI scaffolding and process test harness stack.
- Added `testing-strategy.md` and layer-by-layer validation gates for unit, contract, integration, CLI, TTY, database, MCP, end-to-end, eval, and proof-of-concept smoke coverage.
- Corrected feature design notes to preserve same-day chronology and updated root `AGENTS.md` plus `local-doc/agent-workflows/local-documentation.md` with the chronological design-note rule.
- No implementation commands have been run yet.
- Clarified that `js-monorepo` and `user-management` are the first proof-of-concept validation targets, not the product boundary.

## 2026-05-13 MVP Validation Evidence

- Created `local-tools/code-intel/` and initialized it as a local git repo on `main`.
- Current implementation repo head: `11e3e2c fix: validate graph edge integrity`.
- `npm run build` passed from `local-tools/code-intel/`.
- `npm test` passed from `local-tools/code-intel/`: 12 test files passed, 1 skipped, 23 tests passed, 1 skipped.
- The skipped test is `tests/pty/health.test.ts`; `node-pty` cannot spawn even `/bin/echo` in this environment after `npm rebuild node-pty`, so the PTY test skips when the binding is unavailable.
- `npm run test:integration` passed with workspace discovery, Tree-sitter chunking, exact search, SCIP, Ladybug persistence, vector search, relationship, context, and trace coverage.
- `npm run test:cli` passed against the built `dist/cli/main.js` binary.
- `npm run test:mcp` passed through `@modelcontextprotocol/sdk` `StdioClientTransport`.
- `npm run test:e2e` passed for `code-intel eval --json`.
- `code-intel eval --json` passed all fixture cases.
- Proof-of-concept indexed `/Users/jordy/Documents/GitHub/capsule-org/js-monorepo/packages/react-sdk` into `/Users/jordy/Documents/GitHub/capsule-org/.code-intel/poc-react-sdk`.
- Proof-of-concept smoke query `find-symbol ParaProvider` returned `src/provider/ParaProvider.tsx`.
- Proof-of-concept smoke query `find-symbol useStellarSigner` returned `src/stellar/hooks/useStellarSigner.ts`.
- Proof-of-concept smoke query `callers getStellarSigner` returned `src/stellar/hooks/useStellarSigner.ts`.
- Proof-of-concept smoke query `semantic "stellar signer wallet query"` returned `src/stellar/hooks/useStellarSigner.ts`.
- Proof-of-concept smoke query `search "@getpara/react-sdk-lite"` returned `src/index.ts` and package dependency usage files.
- Parallel CLI smoke initially hit LadybugDB file-lock contention. A short open retry was added; one MCP process remains the recommended concurrent agent access path.

## 2026-05-13 Review Remediation Validation Evidence

- Current implementation repo head before the next commit: `11e3e2c fix: validate graph edge integrity`.
- `npm run build` passed from `local-tools/code-intel/`.
- `npm test` passed from `local-tools/code-intel/`: 12 test files passed, 1 skipped, 28 tests passed, 1 skipped.
- The skipped test remains `tests/pty/health.test.ts` because `node-pty` cannot spawn in this local environment.
- Added regression coverage for literal exact search patterns, missing repo path discovery failures, package-root discovery when nested package files exist, duplicate same-file symbol IDs, bounded metadata without raw source content, concurrent CLI reads, broader MCP tool coverage, invalid MCP inputs, and fixture e2e index/status/query/context/re-query.
- `code-intel health --embedding-provider jina --index-path /tmp/code-intel-jina-health --json` loaded `jinaai/jina-embeddings-v2-base-code` locally and returned a 768-dimension embedding provider pass.
- Jina-backed fixture index and semantic query passed; `semantic "giving receipt summary"` returned `packages/core/src/tithe.ts`.
- Combined proof-of-concept index created `/Users/jordy/Documents/GitHub/capsule-org/.code-intel/poc-code-intel-review` with `js-monorepo/packages/react-sdk` and `user-management/apps/server`: 528 files, 8,406 nodes, 29,408 relationships, 2,261 chunks, about 44 seconds.
- POC health on `.code-intel/poc-code-intel-review` returned index-integrity pass with 8,406 nodes and 29,408 relationships. Overall health is `warn` because that combined POC uses deterministic hash embeddings and Jina model artifacts are not preseeded in that index.
- POC `find-symbol ParaProvider` returned `js-monorepo/packages/react-sdk/src/provider/ParaProvider.tsx`.
- POC `find-symbol useStellarSigner` returned `js-monorepo/packages/react-sdk/src/stellar/hooks/useStellarSigner.ts`.
- POC `find-symbol e2eIdentifierGateMiddleware` returned `user-management/apps/server/src/middleware/e2eIdentifierGate.ts`.
- POC `references findActivePolicy` returned `user-management/apps/server/src/__tests__/findActivePolicy.test.ts`, validating a known test relationship.
- Jina-backed `react-sdk` proof-of-concept index created `.code-intel/poc-react-sdk-jina`; `semantic "stellar signer wallet query"` ranked `src/stellar/hooks/useStellarSigner.ts` first.
- Remaining open risks: `node-pty` is still skipped in this local environment, model preseed policy is undecided, and `code-intel update` still performs a full rebuild rather than changed-file incremental reindexing.

## 2026-05-13 Final Review Closure Evidence

- Current implementation repo head: `1cbd75a fix: harden code intel review gaps`.
- Final subagent review found valid remaining gaps around semantic filters, default ignores, workspace manifest and tsconfig discovery, bounded CLI limits, MCP lock lifetime, dash-prefixed exact search literals, and UTF-8 byte truncation.
- Added semantic filters for repo, package, file kind, and symbol kind across CLI, MCP, query engine, and Ladybug vector search.
- Added `--workspace-manifest` and `--include-ignored`; discovery now defaults away from generated, build, log, dependency, `.code-intel`, and local-dev runtime paths.
- Added tsconfig/jsconfig source-root, include, and exclude handling with JSONC-tolerant parsing for real TypeScript config files.
- Reworked MCP query-engine lifetime to use a short idle cache instead of holding the Ladybug lock for the server lifetime; MCP tests now verify an external CLI read can succeed while MCP is running.
- Added bounded CLI `--limit` and `--depth` validation, `rg --` exact-search protection for dash-prefixed literals, and UTF-8 byte-aware truncation for source excerpts, exact-search excerpts, and SCIP output capture.
- `npm run build` passed from `local-tools/code-intel/`.
- `npm test` passed from `local-tools/code-intel/`: 12 test files passed, 1 skipped, 33 tests passed, 1 skipped.
- `git diff --check` passed from `local-tools/code-intel/`.
- Final combined proof-of-concept index created `/Users/jordy/Documents/GitHub/capsule-org/.code-intel/poc-code-intel-review` with `js-monorepo/packages/react-sdk` and `user-management/apps/server`: 431 files, 7,594 nodes, 26,156 relationships, 1,904 chunks, about 66 seconds.
- Final POC health returned index-integrity pass with 7,594 nodes and 26,156 relationships. Overall health is `warn` because the combined POC uses deterministic hash embeddings and Jina model artifacts are not preseeded in that index.
- Final POC `find-symbol ParaProvider` returned `js-monorepo/packages/react-sdk/src/provider/ParaProvider.tsx`.
- Final POC `find-symbol e2eIdentifierGateMiddleware` returned `user-management/apps/server/src/middleware/e2eIdentifierGate.ts`.
- Final POC `references findActivePolicy` returned `user-management/apps/server/src/__tests__/findActivePolicy.test.ts`, validating a known test relationship.
- Final filtered POC semantic query `stellar signer wallet query --filter-repo react-sdk --filter-package @getpara/react-sdk` ranked `src/stellar/hooks/useStellarSigner.ts` first.
- Final filtered POC semantic query `policy test --filter-repo server --file-kind test` returned only `fileKind: test` results.
- Jina-backed fixture index created `/tmp/code-intel-jina-fixture` with 768-dimension embeddings; `semantic "giving receipt summary"` ranked `packages/core/src/tithe.ts` first.
- Remaining open risks: `node-pty` is still skipped in this local environment, model preseed policy is undecided, and `code-intel update` still performs a full rebuild rather than changed-file incremental reindexing.

## 2026-05-13 Jina Default Migration Evidence

- Current implementation repo head after migration: `bcbfd87 feat: default to jina embeddings`.
- Red phase: `npx vitest run tests/unit/embedding-provider.test.ts tests/integration/index-query.test.ts` failed before implementation because the default provider was still `hash` and health did not include an `index-embedding-provider` warning.
- Implemented default provider migration: unspecified provider now resolves to `jina`; `hash` remains explicit through `--embedding-provider hash`, `local-hash-v1`, or the matching environment variable.
- Implemented hash-index detection: `health` now includes `index-embedding-provider`, passes for Jina indexes, warns for hash indexes, and keeps provider mismatch errors for forced cross-provider queries.
- Implemented eval metadata: `code-intel eval --json` now reports embedding provider, model, and dimension.
- Fixed full-suite build race: `npm test`, `test:cli`, `test:mcp`, `test:pty`, and `test:e2e` now run `npm run build` before Vitest instead of rebuilding concurrently inside process test files.
- `npm run build` passed from `local-tools/code-intel/`.
- `npm run test:unit` passed: 5 files, 11 tests.
- `npm run test:integration` passed: 5 files, 14 tests.
- `npm run test:cli` passed after the script-level build hardening: 1 file, 7 tests.
- `npm run test:mcp` passed after the script-level build hardening: 1 file, 1 test.
- `npm run test:e2e` passed after the script-level build hardening with default Jina: 1 file, 2 tests.
- `npm test` passed after the build-race fix: 13 files passed, 1 skipped; 35 tests passed, 1 skipped.
- `npm run test:pty` skipped as expected because `node-pty` still cannot spawn in this local runtime: 1 file skipped, 1 test skipped.
- `git diff --check` passed.
- Default Jina fixture index created `/tmp/code-intel-jina-default-fx4BEC` with provider `jina`, model `jinaai/jina-embeddings-v2-base-code`, dimension `768`, 49 nodes, 107 relationships, and 13 chunks.
- `code-intel health --index-path /tmp/code-intel-jina-default-fx4BEC --json` returned status `ok`; `embedding-provider`, `index-embedding-provider`, Ladybug vector, index integrity, and MCP SDK checks passed.
- CLI semantic query `giving receipt summary` against `/tmp/code-intel-jina-default-fx4BEC` ranked `packages/core/src/tithe.ts` first with Jina metadata on the result.
- MCP `semantic_search` against `/tmp/code-intel-jina-default-fx4BEC` returned `packages/core/src/tithe.ts` with provider `jina` and model `jinaai/jina-embeddings-v2-base-code`, proving MCP and CLI use the same manifest-backed metadata path.
- Legacy hash fixture index created `/tmp/code-intel-hash-legacy-r7NKP1`; health returned status `warn` with `index-embedding-provider` warning that the index uses deterministic hash embeddings and should be rebuilt without the hash flag for Jina.
- Forced Jina query against `/tmp/code-intel-hash-legacy-r7NKP1` failed clearly with `Embedding provider mismatch: index uses hash, query requested jina`.
- Real `react-sdk` comparison indexes created `/tmp/code-intel-react-sdk-hash-HnVDxU` and `/tmp/code-intel-react-sdk-jina-ZzVxzk`. Both indexed 28 files, 95 nodes, 139 relationships, and 30 chunks; the Jina index used 768-dimension vectors.
- `react-sdk` literal semantic query `stellar signer wallet query` ranked `src/stellar/hooks/useStellarSigner.ts` first for both hash and Jina, showing no regression but not a quality separation on that exact-token-heavy query.
- Real user-management test-slice comparison indexes created `/tmp/code-intel-um-tests-hash-FCmV1u` and `/tmp/code-intel-um-tests-jina-w4fl5X`. Query `auth object overrides top level email input` improved expected `e2eIdentifierGate.test.ts` rank from 5 with hash to 2 with Jina.
- A larger 120-chunk user-management middleware Jina slice exceeded the interactive command window before producing a manifest. This keeps performance batching, model-cache strategy, and incremental reindexing important follow-ups.

## 2026-05-13 Incremental Reindexing Evidence

- Current implementation repo head after migration: `d9acc74 feat: add incremental reindexing`.
- Red phase: `npx vitest run tests/unit/incremental-planner.test.ts tests/integration/incremental-update.test.ts` failed before implementation because `updateWorkspace()` returned a full rebuild manifest with no `incremental` stats.
- Implemented generation-local file facts at `generations/<generation-id>/facts/files.json` with file fingerprints, chunk facts, embedding input hashes, and cached embeddings.
- Implemented source-byte fingerprinting with size and mtime metadata used as facts, but content hash as the decision source of truth.
- Implemented config invalidation hashing over schema, update options, embedding metadata, workspace manifest, repo package manifests, and TS/JS config files.
- Implemented `code-intel update` planning for added, changed, deleted, unchanged, and config-changed paths.
- Kept Ladybug writes generation-based. Update reuses safe facts, recomputes the graph, writes a fresh generation, then publishes the active pointer.
- Reruns SCIP at repo level for P0 while reusing unchanged Tree-sitter chunk facts and embeddings.
- Added provenance metadata on generated file, chunk, symbol, and relationship facts with `ownerRepo`, `ownerFile`, `origin`, and `derivedFrom` where applicable.
- Added active generation manifest resolution for status, health, query, CLI, and MCP paths so metadata follows the published database generation.
- `npm run build` passed from `local-tools/code-intel/`.
- Focused red-to-green command passed after implementation: `npx vitest run tests/unit/incremental-planner.test.ts tests/integration/incremental-update.test.ts`.
- `npm run test:unit` passed: 6 files, 13 tests.
- `npm run test:integration` passed: 6 files, 16 tests.
- `npm run test:cli` passed: 1 file, 8 tests.
- `npm run test:mcp` passed: 1 file, 2 tests.
- `npm run test:e2e` passed: 1 file, 2 tests.
- `npm run test:pty` skipped as expected because `node-pty` still cannot spawn in this local runtime.
- `npm test` passed: 15 files passed, 1 skipped; 41 tests passed, 1 skipped.
- `git diff --check` passed.
- Incremental integration test mutates a copied fixture repo by adding `blessing.ts`, changing `ledger.ts`, deleting `duplicateMethods.ts`, and deleting `tithe.test.ts`; update reports exactly 1 added, 1 changed, 2 deleted, 5 unchanged, 6 reused chunks, and 3 embedded chunks.
- Incremental integration test proves only the changed and added chunks are embedded: `GivingLedger`, `summarize`, and `createBlessingNote`.
- Incremental integration test proves the new symbol `createBlessingNote` is queryable, deleted source symbol `PrimaryRenderer` disappears, deleted files disappear from graph and semantic-filtered results, `summarize` callees change from `calculateGivingTotal` to `formatGivingReceipt`, and the incremental graph matches a fresh full index graph.
- Incremental integration test now compares active facts, manifest stats, embedding metadata, graph nodes, graph edges, and semantic result IDs against a fresh full index.
- Active-generation snapshot regression test proves a query engine created before a later update still uses one consistent manifest and Ladybug database generation when it performs semantic search.
- CLI process test proves `code-intel update --json` reports incremental stats and updated query results through the built CLI.
- MCP stdio test proves the server serves the active generation after incremental update, including new-symbol lookup, deleted-symbol cleanup, deleted-reference cleanup, and deleted semantic chunk cleanup.
- Review loop findings addressed: tightened exact manifest count assertions, broadened deleted-file assertions, extended full-index equivalence beyond nodes and edges, and fixed the active manifest/database generation race in query setup.

## 2026-05-14 Stronger Eval Harness Evidence

- Current implementation repo head before commit: `d9acc74 feat: add incremental reindexing`.
- Red phase: `npx vitest run tests/unit/evaluator.test.ts` failed before implementation because `runEvalSuite()` ignored suite selection, did not report pack metadata, and did not reject uncached Rallly runs without `--fetch`.
- Added `eval-packs/js-ts-general` with a committed corpus and deterministic cases for symbol lookup, path alias references, React hook discovery, class methods, call relationships, test relationships, semantic concept retrieval, and a duplicate-method false-positive guard.
- Added `eval-packs/oss-rallly-app-flow` with metadata and app-flow cases only. Rallly source is fetched on demand from `https://github.com/lukevella/rallly.git` at commit `5017e6a3a616bf479ee21ca74d86d0da85e1a169`.
- Added CLI options `--suite`, `--eval-pack`, `--eval-cache-path`, and `--fetch`.
- Eval reports now include suite metadata, corpus metadata, embedding metadata, index stats, per-case expected ranks, false-positive results, latency, actual top results, and failure class.
- `npx vitest run tests/unit/evaluator.test.ts` passed after implementation.
- `npm run build` passed.
- `npx vitest run tests/e2e/eval.test.ts` passed after updating the eval report contract.
- `npm run test:unit` passed: 7 files, 15 tests.
- `npm run test:integration` passed: 6 files, 16 tests.
- `npm run test:cli` passed: 1 file, 8 tests.
- `npm run test:mcp` passed: 1 file, 2 tests.
- `npm run test:e2e` passed: 1 file, 4 tests.
- `npm run test:pty` skipped as expected because `node-pty` still cannot spawn in this local runtime.
- First `npm test` run caught a real harness issue: Vitest discovered `eval-packs/js-ts-general/corpus/packages/core/src/tithe.test.ts` as an executable test file. `vitest.config.ts` now excludes `eval-packs/**` because eval corpora are input data.
- Final `npm test` passed: 16 files passed, 1 skipped; 45 tests passed, 1 skipped.
- `git diff --check` passed.
- `npm pack --dry-run` passed and confirmed `eval-packs/**` are included with the built package.
- Manual Rallly fetch validation passed with hash embeddings: `node dist/cli/main.js eval --suite oss-rallly-app-flow --fetch --eval-cache-path /tmp/code-intel-rallly-eval-cache --embedding-provider hash --json` fetched the pinned repo, indexed 110 files into 1,261 nodes, 3,018 edges, and 423 chunks, and returned `status: fail` with ranking and coverage failures. This proves the external pack execution path works and provides baseline quality evidence.
- Manual default Jina Rallly validation was attempted with `node dist/cli/main.js eval --suite oss-rallly-app-flow --eval-cache-path /tmp/code-intel-rallly-eval-cache --json`. The process stayed CPU-active for several minutes and exited with code `-1` from the local command window before producing JSON, so full Rallly Jina evaluation remains a long-running manual check until embedding performance is improved.

## 2026-05-15 AST Structural Facts Evidence

- Red phase: `npx vitest run tests/integration/ast-facts.test.ts` failed because `extractSourceFileFacts()` did not exist.
- Added `extractSourceFileFacts()` while preserving `chunkSourceFile()` as the legacy chunk wrapper.
- Added golden AST fixture coverage for value imports, type imports, side-effect imports, namespace imports, re-exports, default exports, local exports, function declarations, class methods, object methods, variable-declared functions, member calls, ownership, test cases, duplicate method names, and partial syntax files.
- Added generation-local persistence for structural facts in `facts/files.json` so unchanged files can reuse AST facts during incremental update.
- Added graph write support for `Import` and `Export` nodes with `IMPORTS` and `EXPORTS` edges from owning files.
- `npx vitest run tests/integration/ast-facts.test.ts` passed: 1 file, 4 tests.
- `npm run build` passed.
- `npm run test:unit` passed: 7 files, 15 tests.
- `npm run test:integration` passed: 7 files, 20 tests.
- `npm run test:cli` passed: 1 file, 8 tests.
- `npm run test:mcp` passed: 1 file, 2 tests.
- `npm run test:e2e` passed: 1 file, 4 tests.
- `npm run test:pty` skipped as expected because local `node-pty` cannot spawn in this runtime: 1 file skipped, 1 test skipped.
- `npm test` passed: 17 files passed, 1 skipped; 49 tests passed, 1 skipped.
- `git diff --check` passed.
- `npm pack --dry-run` passed and included the split Tree-sitter modules in `dist/`.
- Remaining follow-up: import/export graph resolution still needs to connect module specifiers to target files, packages, and package exports. Ranking still needs to consume the richer facts.

## 2026-05-15 AST Hardening Evidence

- Red phase: `npx vitest run tests/integration/ast-facts.test.ts tests/unit/evaluator.test.ts` failed because CommonJS and dynamic import facts were missing, `facts/embeddings.json` did not exist, and Rallly AST case metadata was not loaded.
- Added A-grade AST fixture coverage for JS, JSX, TS, TSX, dynamic imports, CommonJS `require`, CommonJS exports, export star, export namespace, export type specifiers, anonymous default exports, top-level variables, decorators where supported, constructors, optional chained calls, JSX component usage, duplicate names, tests, callbacks, and partial syntax.
- Added richer call evidence: `callKind`, `receiver`, `propertyName`, `optionalChain`, `memberPath`, containing declaration, and containing chunk provenance.
- Added dynamic and CommonJS module facts with stable ranges, source text, hashes, owner file, and containing chunk provenance.
- Added `Variable` declaration facts for top-level variables without turning local implementation temporaries into declarations.
- Graph identity now uses qualified declaration names in Tree-sitter symbol IDs and metadata while preserving chunk display names.
- Split generation-local facts persistence: `facts/files.json` stores structural facts with `factsSchemaVersion: code-intel.facts.v2`, and `facts/embeddings.json` stores reusable chunk vectors with `factsSchemaVersion: code-intel.embeddings.v1`.
- `readActiveIndexFacts()` merges structural facts and embedding facts so incremental unchanged-file reuse still works.
- Added `eval-packs/oss-rallly-app-flow/cases/ast-facts.json` with pinned AST expectations for API route, API mutation, database client, UI loader, middleware, and private API route test files.
- `npx vitest run tests/integration/ast-facts.test.ts tests/unit/evaluator.test.ts` passed after implementation: 2 files, 8 tests.
- `npm run test:unit` passed: 7 files, 16 tests.
- `npm run test:integration` passed: 7 files, 21 tests.
- `npm run build` passed.
- `npm run test:cli` passed: 1 file, 8 tests.
- `npm run test:mcp` passed: 1 file, 2 tests.
- `npm run test:e2e` passed: 1 file, 4 tests.
- `npm run test:pty` skipped as expected because local `node-pty` cannot spawn in this runtime: 1 file skipped, 1 test skipped.
- `npm test` passed: 17 files passed, 1 skipped; 51 tests passed, 1 skipped.
- `git diff --check` passed.
- `npm pack --dry-run` passed and included `eval-packs/oss-rallly-app-flow/cases/ast-facts.json`.
- Manual Rallly AST validation passed through the hash-backed eval pack: `node dist/cli/main.js eval --suite oss-rallly-app-flow --fetch --eval-cache-path /tmp/code-intel-rallly-ast-eval-cache --embedding-provider hash --json` returned all six `astCases` as `pass`.
- The same Rallly run still returned overall `status: fail` because semantic app-flow query cases continue to fail mostly as `ranking`. This is expected and remains the next-layer work.
- Parser limitation tracked: the Rallly database client AST case passes, but `hasParseError` is true because the pinned Tree-sitter TypeScript grammar flags valid `export type *` syntax.

## 2026-05-15 SCIP Fusion Evidence

- Red phase: `npx vitest run tests/integration/scip.test.ts tests/integration/index-query.test.ts` failed before implementation because normalized SCIP occurrences were missing and symbol query results were still Tree-sitter-only.
- Added normalized SCIP occurrence ingestion with roles, raw role masks, ranges, enclosing ranges, read/test normalization, and definition/reference facts.
- Added generation-local `facts/scip.json` with `factsSchemaVersion: code-intel.scip-facts.v1`.
- Added SCIP fusion that promotes matching AST declaration symbols to canonical SCIP-backed symbols and writes evidence-backed `REFERENCES`, `CALLS`, `IMPORTS`, `EXPORTS`, `TESTS`, and `MENTIONS` edges.
- Added relationship provenance to query output under `metadata.relationship`, including `origin`, `source`, `evidenceSources`, roles, confidence, SCIP symbol, and range when present.
- Added declaration-backed graph symbols for non-chunk AST declarations so exported variables, database clients, middleware values, and route aliases can be graph targets.
- Added labeled AST import/export fallback resolution for cases where `scip-typescript` succeeds but omits a target definition. Rallly exposed this with exported variable functions `createPoll` and `deletePoll`.
- Added synthetic eval cases for type-import references and class-method callee relationships.
- Added Rallly relationship cases for `createPoll`, `deletePoll`, `prisma`, `spaceApiKeyAuth`, and private route-test imports.
- `npx vitest run tests/unit/evaluator.test.ts tests/integration/index-query.test.ts tests/integration/scip.test.ts` passed after implementation.
- `npx vitest run tests/integration/index-query.test.ts tests/integration/scip.test.ts tests/integration/incremental-update.test.ts tests/cli/process.test.ts` passed after declaration-backed symbol remediation: 4 files, 12 tests.
- `node dist/cli/main.js eval --suite js-ts-general --embedding-provider hash --json` passed with 15 chunks, 161 edges, and 65 nodes after declaration-symbol expansion.
- Rallly hash-backed eval passed all six pinned AST cases and passed the focused graph relationship cases for `createPoll`, `deletePoll`, `prisma`, `spaceApiKeyAuth`, web poll UI, and private route-test imports. It indexed 110 files into 2,120 nodes, 5,008 edges, and 395 chunks.
- The same Rallly run still returned overall `status: fail` because semantic app-flow cases remain ranking failures. This keeps hybrid ranking as the next P1 item rather than a SCIP-layer blocker.
- `npm test` passed: 17 files passed, 1 skipped; 51 tests passed, 1 skipped.
- `git diff --check` passed.
- `npm pack --dry-run` passed and included `dist/indexer/scip-fusion`, `dist/scip/fact-cache`, and both eval packs.

## 2026-05-15 Gated Eval Suite Evidence

- Red phase: `npx vitest run tests/unit/evaluator.test.ts` failed because `runEvalSuite()` did not expose `blockingStatus`, did not parse per-case gate metadata, and still treated target failures as overall report failures.
- Added gate metadata schema for query and AST eval cases with `required`, `target`, and `scoreboard` statuses.
- Added report aggregation for `blockingStatus`, `qualityStatus`, gate-status totals, per-gate summaries, per-capability summaries, expected-rank coverage, and failure-class summaries.
- Updated synthetic eval cases to required gates and Rallly cases to general JS/TS capabilities: route-to-mutation, mutation-to-database, middleware-to-route, UI-to-data/API, test-to-implementation, package-boundary imports, re-export/canonical symbol resolution, transitive graph traversal, app-flow retrieval, and false-positive guards.
- Focused verification passed: `npx vitest run tests/unit/evaluator.test.ts tests/e2e/eval.test.ts`.
- Hash-backed synthetic CLI verification passed: `node dist/cli/main.js eval --suite js-ts-general --embedding-provider hash --json` returned `status: pass`, `blockingStatus: pass`, and `qualityStatus: pass` across 11 required cases.
- Hash-backed Rallly gated verification passed the blocking gate: `node dist/cli/main.js eval --suite oss-rallly-app-flow --fetch --eval-cache-path /tmp/code-intel-rallly-gated-eval-cache --embedding-provider hash --json` returned `status: pass`, `blockingStatus: pass`, and `qualityStatus: fail`.
- The Rallly gated run indexed 110 files into 2,120 nodes, 5,008 edges, and 395 chunks. Required gates passed 13 of 13. Target gates passed 1 of 7, with five ranking failures and one graph traversal failure. This confirms the next targets are hybrid ranking and transitive graph traversal, not AST/SCIP/focused graph correctness.
- Full package verification passed: `npm test` returned 18 files passed, 1 skipped; 53 tests passed, 1 skipped. The skip remains the local `node-pty` spawn limitation.
- `git diff --check` passed.
- `npm pack --dry-run` passed and confirmed the updated eval packs are included in the package.

## 2026-05-15 Fusion Resolution Evidence

- Current implementation repo head after this pass: `8a11925 feat: harden fusion resolution`.
- Red phase: `npx vitest run tests/integration/fusion-resolution.test.ts` failed before implementation because the index did not write `facts/resolution.json`.
- Added generation-local resolved module facts at `generations/<generation-id>/facts/resolution.json` with `factsSchemaVersion: code-intel.resolved-facts.v1`.
- Added TypeScript-compatible resolution for relative imports, `tsconfig` aliases, workspace package names, package exports, barrels, re-exports, default imports, named imports, namespace imports, dynamic imports, CommonJS, and unresolved cases where resolution is not safe.
- Added graph construction from resolved module facts. `IMPORTS`, `EXPORTS`, `REFERENCES`, `CALLS`, `TESTS`, and `MENTIONS` edges now preserve SCIP, AST, and module-resolution evidence metadata with confidence, owner file, range, containing chunk, specifier, local/exported names, target file, target package, target symbol, member path, test context, and fallback reason.
- Added hybrid semantic reranking so vector candidates are promoted by symbol text, code-like query tokens, path tokens, file-kind signals, and graph-neighbor evidence.
- Added fixture and eval corpus coverage for package exports, path aliases, barrels, re-exports, default exports, namespace imports, CommonJS, dynamic imports, duplicate names, member calls, tests, and unresolved cases.
- `npx vitest run tests/integration/fusion-resolution.test.ts` passed after implementation.
- `npx vitest run tests/integration/index-query.test.ts tests/integration/scip.test.ts tests/integration/incremental-update.test.ts tests/unit/evaluator.test.ts tests/e2e/eval.test.ts` passed after eval and fixture count updates.
- An initial full-suite rerun exposed a real MCP concurrency regression: an external CLI read could still hit a Ladybug native lock while the MCP process was alive.
- Fixed the lock handoff by explicitly closing Ladybug query results and database handles before releasing the graph store's process lock.
- `npm run build && npx vitest run tests/mcp/server.test.ts` passed after the graph-store close fix: 1 test file passed, 2 tests passed.
- `npm test` passed: 19 test files passed, 1 skipped; 54 tests passed, 1 skipped. The skipped test remains the local `node-pty` spawn limitation.
- `git diff --check` passed.
- `npm pack --dry-run` passed and did not leave a `code-intel-0.1.0.tgz` artifact behind.
- Synthetic hash-backed eval passed: `node dist/cli/main.js eval --suite js-ts-general --embedding-provider hash --json` returned `status: pass`, `blockingStatus: pass`, `qualityStatus: pass`, 14 of 14 required cases, and index stats of 101 nodes, 300 edges, and 22 chunks.
- Rallly hash-backed gated eval passed: `node dist/cli/main.js eval --suite oss-rallly-app-flow --eval-cache-path /tmp/code-intel-rallly-gated-eval-cache --embedding-provider hash --json` returned `status: pass`, `blockingStatus: pass`, `qualityStatus: pass`, 13 of 13 required gates, 7 of 7 target gates, and index stats of 2,120 nodes, 5,431 edges, and 395 chunks.
- Rallly target evidence now includes create-poll route, mutation, and database flow; delete-poll route and mutation flow; API key middleware-to-route flow; web poll loader, admin page, and dashboard-polls flow; private API route-test flow; route-to-database transitive flow; and a false-positive guard.
- Remaining risk: hybrid ranking is deterministic and eval-backed, but still rule-weighted. Broader eval cases should be added before treating current weights as generally optimal.

## 2026-05-15 Graph Eval Red-Gate Evidence

- Current implementation repo head after this pass: `74e4994 test: add graph eval target gates`.
- Invoked Claude CLI directly with `claude -p` to add stringent graph-specific eval gates. The run partially added graph-case harness support but hung before adding case files, so it was stopped and the red-gate change was completed locally.
- Added graph eval support through `graphCaseFiles`, graph check schemas, graph case results, graph-case execution, and query-engine repository access for eval-only graph assertions.
- Added synthetic required graph cases for typed path traversal and duplicate-name false-positive guarding.
- Added Rallly target graph cases for route-to-mutation-to-database typed path, middleware-to-route usage path, UI-to-private-API path, test-to-implementation evidence path, and mention-only billing false-positive guard.
- `npm run build` passed.
- `npx vitest run tests/unit/evaluator.test.ts` passed: 1 test file passed, 4 tests passed.
- Synthetic graph eval passed: `node dist/cli/main.js eval --suite js-ts-general --embedding-provider hash --json` returned `status: pass`, `blockingStatus: pass`, `qualityStatus: pass`, 16 of 16 required cases, and both graph cases passed.
- Rallly graph red-gate eval produced the intended quality failure: `node dist/cli/main.js eval --suite oss-rallly-app-flow --eval-cache-path /tmp/code-intel-rallly-gated-eval-cache --embedding-provider hash --json` returned `status: pass`, `blockingStatus: pass`, `qualityStatus: fail`, 13 of 13 required gates passed, and target gates passed 8 of 12 with 4 graph target failures.
- Failing Rallly graph targets: `rallly.graph.route-mutation-database-typed-path`, `rallly.graph.middleware-to-route-usage-path`, `rallly.graph-ui-to-private-api-path`, and `rallly.graph-test-to-implementation-evidence-path`.
- Passing Rallly graph target: `rallly.graph-no-mention-only-billing-flow`.
- `npx vitest run tests/unit/evaluator.test.ts tests/e2e/eval.test.ts` passed: 2 test files passed, 8 tests passed.
- `npm test` passed: 19 test files passed, 1 skipped; 55 tests passed, 1 skipped. The skipped test remains the local `node-pty` spawn limitation.
- `git diff --check` passed.
- `npm pack --dry-run` passed and included the new graph-case runner plus graph-path eval pack files. No tarball artifact was left behind.

## 2026-05-16 Graph Layer Hardening Evidence

- Current implementation status after this pass: graph-layer hardening implemented in `local-tools/code-intel`; commit pending at the time this note was written.
- Added shared graph traversal in `src/graph/path-traversal.ts` with allowed edge kinds, direction handling, max depth, evidence requirements, deterministic scoring, package-intermediate guarding, ordered path support, and path edge metadata.
- Updated graph eval execution to use the shared traversal path and to report edge direction, owner file, range, confidence, evidence sources, and fallback reason.
- Updated `trace_path` query output to include `pathEdges`, `incomingPathEdge`, path rank, path score, and traversal direction metadata.
- Added CLI and MCP traversal controls for `trace_path`: allowed edge kinds, direction, and max depth.
- Tightened module-resolution graph semantics so imports alone create `IMPORTS` and `REFERENCES`, while `CALLS` requires observed call facts. File-level `CALLS` remains available for callback-heavy route files when AST call facts prove the call.
- Added test-context metadata for `TESTS` edges and `tree-sitter-test` evidence when test files or test chunks cause the edge.
- Added labeled Next App Router route-segment layout fallback edges with `origin: next-app-router`, `confidence: fallback`, and `fallbackReason: next-app-router-file-convention`.
- Propagated imported-symbol roles onto SCIP references when a symbol imported by a file is later used in a function signature or body.
- Adjusted incoming `REFERENCES` ranking to dedupe by file after ranking, prefer real call usage, prefer module-resolution and SCIP evidence, and reduce duplicate chunk/file noise.
- Updated incremental fixture expectations after adding graph fixture files: unchanged files are now 18 and reused chunks are now 22.
- Fixed MCP read stability by reusing the query engine across nearby MCP calls and closing it on an unref'd idle timer.
- Focused verification passed: `npm run build && npx vitest run tests/integration/scip.test.ts tests/integration/fusion-resolution.test.ts tests/integration/index-query.test.ts tests/unit/evaluator.test.ts tests/mcp/server.test.ts tests/e2e/eval.test.ts`.
- Full package verification passed: `npm test` returned 19 test files passed, 1 skipped; 55 tests passed, 1 skipped. The skip remains the PTY-only health rendering test in this local runtime.
- Rallly graph verification passed: `node dist/cli/main.js eval --suite oss-rallly-app-flow --eval-cache-path /tmp/code-intel-rallly-gated-eval-cache --embedding-provider hash --json` returned `status: pass`, `blockingStatus: pass`, 13 of 13 required gates passed, and all five graph target cases passed.
- Rallly still returned `qualityStatus: fail` because `rallly.private-api-test-flow` remains a semantic-ranking target failure, not a graph failure. `route.test.ts` ranked 10, while `route.ts` was not found in the top 10.
- `git diff --check` passed.
- `npm pack --dry-run` passed and did not leave a `code-intel-0.1.0.tgz` artifact behind.

## 2026-05-16 Ranking Layer Hardening Evidence

- Red phase: `npx vitest run tests/integration/index-query.test.ts tests/unit/evaluator.test.ts tests/unit/eval-gates.test.ts` failed before implementation because semantic results did not expose `metadata.ranking`, eval cases did not report ranking metrics, and the new ranking gates were not yet satisfied.
- Replaced raw semantic ordering with deterministic hybrid ranking that combines semantic, lexical, exact symbol, graph, reference, caller/callee, import/export, and test candidates.
- Added query intent handling for implementation, caller, callee, test, app-flow, and broad semantic searches.
- Added code-aware boosts and demotions for exact symbols, SCIP/fusion evidence, graph confidence, app-flow paths, file kind, weak mentions, fallback-only edges, generated/vendor paths, test/source intent mismatch, and duplicate file/chunk noise.
- CLI and MCP semantic results now expose ranking explanations under `metadata.ranking`, including intent, source ranks, final score, contributing signals, reasons, evidence detail, and demotions.
- Added eval ranking metrics: `MRR@10`, `Recall@K`, `nDCG@10`, expected totals, expected found or missing counts, and false-positive counts.
- Added synthetic eval cases for implementation-intent ranking, test-intent ranking, and graph-backed semantic ranking.
- Focused verification passed: `npm run build && npx vitest run tests/integration/index-query.test.ts tests/unit/evaluator.test.ts tests/unit/eval-gates.test.ts tests/e2e/eval.test.ts tests/mcp/server.test.ts tests/cli/process.test.ts` returned 6 files passed and 21 tests passed.
- Full package verification passed: `npm test` returned 19 test files passed, 1 skipped; 55 tests passed, 1 skipped. The skip remains the PTY-only health rendering test in this local runtime.
- `git diff --check` passed.
- `npm pack --dry-run` passed and did not leave a `code-intel-0.1.0.tgz` artifact behind.
- Synthetic hash-backed eval passed: `node dist/cli/main.js eval --suite js-ts-general --embedding-provider hash --json` returned `status: pass`, `blockingStatus: pass`, `qualityStatus: pass`, and 19 of 19 required gates passed.
- Rallly hash-backed eval passed: `node dist/cli/main.js eval --suite oss-rallly-app-flow --eval-cache-path /tmp/code-intel-rallly-gated-eval-cache --embedding-provider hash --json` returned `status: pass`, `blockingStatus: pass`, `qualityStatus: pass`, 13 of 13 required gates passed, and 12 of 12 target gates passed.
- Rallly target ranking metrics after this pass: `MRR@10 0.904762`, `Recall@K 0.880952`, and `nDCG@10 0.808548`.
- The private API test-flow target now ranks `route.ts` first and `route.test.ts` second.
- Remaining risk: deterministic ranking is still rule-weighted. Broader cross-corpus eval coverage should come before learned weights or optional local reranking.

## 2026-05-16 Test-Linking Layer Hardening Evidence

- Current implementation repo head after this pass: `151e3cc feat: harden test linking`.
- Red phase: `npx vitest run tests/integration/index-query.test.ts tests/unit/evaluator.test.ts` failed before implementation because direct `TESTS` metadata and the new synthetic test-linking graph gates were absent.
- Added `src/indexer/test-linking.ts` to normalize direct test imports, direct test calls, SCIP references, and concrete AST test cases into evidence-backed `TESTS` edges.
- Added bounded indirect test-link traversal through implementation `CALLS`, `REFERENCES`, `IMPORTS`, and `EXPORTS` paths when a direct test-to-implementation edge proves the starting point.
- Added exact colocated source/test naming fallback with `confidence: fallback` and `fallbackReason: colocated-test-source-name`; broad folder, package, or word overlap remains insufficient to create a `TESTS` edge.
- Added test-linking metadata for owner file, test case name, test case title, test case range, target symbol or file, evidence sources, traversal path, confidence, and fallback reason.
- Fixed relationship lookup so typed edge tables are queried directly instead of filtering only the generic relationship table, which keeps canonical symbol references visible to CLI/MCP relationship queries.
- Added synthetic fixture and eval coverage for direct import/call, indirect route/helper path, colocated fallback, duplicate names, and false-positive guards.
- Added Rallly target gates for private route tests, route-to-mutation tests, route-to-database tests, middleware/API test relationships, implementation-to-test lookup, test-to-implementation lookup, and false-positive guards.
- Focused verification passed after implementation: `npm run build && npx vitest run tests/integration/index-query.test.ts tests/unit/evaluator.test.ts` returned 2 files passed and 5 tests passed.
- Synthetic hash-backed eval passed: `node dist/cli/main.js eval --suite js-ts-general --embedding-provider hash --json` returned `status: pass`, `blockingStatus: pass`, `qualityStatus: pass`, and 23 of 23 required gates passed.
- Rallly hash-backed eval passed: `node dist/cli/main.js eval --suite oss-rallly-app-flow --eval-cache-path /tmp/code-intel-rallly-gated-eval-cache --embedding-provider hash --json` returned `status: pass`, `blockingStatus: pass`, `qualityStatus: pass`, 13 of 13 required gates passed, and 18 of 18 target gates passed.
- Rallly full target aggregate after adding test-linking gates: `MRR@10 0.809524`, `Recall@K 0.880952`, and `nDCG@10 0.763554`.
- Full package verification passed: `npm test` returned 19 files passed, 1 skipped; 55 tests passed, 1 skipped. The skip remains the PTY-only health rendering test in this local runtime.
- PTY verification was attempted: `npm run test:pty` returned 1 file skipped and 1 test skipped because node-pty cannot spawn in this runtime.
- `git diff --check` passed.
- `npm pack --dry-run` passed.
- `.DS_Store` check passed: `find .. -name .DS_Store -print` returned no files from `local-tools/code-intel`.
- Eval correction: the strict route-to-mutation-to-database ordered path was adjusted to route-to-database typed evidence because the current graph proves route-to-mutation and route-to-database separately, but does not yet expose a clean `createPoll` symbol to `prisma` `CALLS` edge. Keep that precision as future type/member relationship work.

## 2026-05-16 Relationship Graph Hardening Evidence

- Current implementation repo head after this pass: `9c1406c feat: harden relationship graph`.
- Red phase: focused relationship graph and eval checks initially failed because stricter Rallly graph IDs were not loaded by the unit fixture expectation, and the new synthetic relationship gates were not yet implemented.
- Added compiler-backed type relationship graphing for `EXTENDS`, `IMPLEMENTS`, and type-use `REFERENCES`.
- Added module-resolution relationship evidence for member-call, property-access, package-boundary, loader/action, route-handler, and mutation-to-database edges.
- Added explicit syntax-only relationship graph facts for config/env references, route handler conventions, loader/action conventions, and unresolved API-client callsites.
- Added direct typed-table edge reads in `LadybugGraphStore.getEdges()` so graph eval and CLI/MCP relationship reads use canonical edge kind and metadata instead of mixed generic relationship rows.
- Added synthetic fixture and eval corpus coverage for API-client calls, route-handler conventions, config/env references, type relationships, member chains, property access, package boundaries, and loader/action paths.
- Added Rallly target gates for ordered route-to-mutation-to-database traversal and createPoll-to-prisma member-call evidence, with the database member gate now requiring `mutation-to-database` evidence.
- Focused verification passed: `npm run build && npx vitest run tests/integration/fusion-resolution.test.ts tests/unit/evaluator.test.ts`.
- Synthetic hash-backed eval passed: `node dist/cli/main.js eval --suite js-ts-general --embedding-provider hash --json` returned `status: pass`, `blockingStatus: pass`, `qualityStatus: pass`, and 33 of 33 required gates passed.
- Rallly hash-backed eval passed: `node dist/cli/main.js eval --suite oss-rallly-app-flow --fetch --eval-cache-path /tmp/code-intel-rallly-gated-eval-cache --embedding-provider hash --json` returned `status: pass`, `blockingStatus: pass`, `qualityStatus: pass`, 13 of 13 required gates passed, and 20 of 20 target gates passed.
- Full package verification passed: `npm test` returned 19 test files passed, 1 skipped; 55 tests passed, 1 skipped.
- PTY verification was attempted: `npm run test:pty` returned 1 file skipped and 1 test skipped because node-pty cannot spawn in this runtime.
- `git diff --check` passed.
- `npm pack --dry-run` passed and did not leave a `code-intel-0.1.0.tgz` artifact.
- `.DS_Store` check passed: `find /Users/jordy/Documents/GitHub/capsule-org/local-tools/code-intel /Users/jordy/Documents/GitHub/capsule-org/local-doc/code-intelligence-graph -name .DS_Store -print` returned no files.

## 2026-05-16 11:21 CDT: Adversarial Eval Hardening Verification

- [x] Committed adversarial eval packs before implementation: `05d1bff test: add adversarial eval packs`.
- [x] Committed adversarial eval handoff docs before implementation: `f9e3b33 docs: add adversarial eval handoff`.
- [x] `node dist/cli/main.js eval --eval-pack eval-packs/js-ts-adversarial --embedding-provider hash --json` passed with `status: pass`, `blockingStatus: pass`, `qualityStatus: pass`, target 73/73, scoreboard 5/5.
- [x] `node dist/cli/main.js eval --eval-pack eval-packs/js-ts-adversarial --embedding-provider jina --json` passed with `status: pass`, `blockingStatus: pass`, `qualityStatus: pass`, target 73/73, scoreboard 5/5.
- [x] `node dist/cli/main.js eval --eval-pack eval-packs/oss-rallly-adversarial --eval-cache-path /tmp/code-intel-rallly-eval-cache --embedding-provider hash --fetch --json` passed with `status: pass`, `blockingStatus: pass`, `qualityStatus: pass`, target 17/17.
- [x] `node dist/cli/main.js eval --eval-pack eval-packs/oss-rallly-adversarial --eval-cache-path /tmp/code-intel-rallly-eval-cache --embedding-provider jina --fetch --json` passed with `status: pass`, `blockingStatus: pass`, `qualityStatus: pass`, target 17/17.
- [x] `npm test` passed with 20 test files passed, 1 skipped, 56 tests passed, 1 skipped.
- [x] `git diff --check` passed in `local-tools/code-intel`.
- [x] `git diff --check` passed in `local-doc/code-intelligence-graph`.
- [x] `npm pack --dry-run` passed and did not leave a `code-intel-0.1.0.tgz` artifact.
- [x] `.DS_Store` check passed across `local-tools/code-intel` and `local-doc/code-intelligence-graph`.

## 2026-05-16 21:48 CDT: Cross-OSS Eval Portfolio Verification

- [x] Added built-in eval suites `oss-ghostfolio-app-flow`, `oss-openstatus-app-flow`, and `oss-hermes-agent-ui`.
- [x] Pinned Ghostfolio to `bd2ca4aacdf715f53acb0950f30d69531a7e80a2`.
- [x] Pinned OpenStatus to `5f81fd9b7b5fab263abaacc7c621030f673057bc`.
- [x] Pinned Hermes Agent to `3b39096904ae63a9e784b2403ad6ad27160bb2ef`.
- [x] Added sparse checkout shape to the external corpus cache key.
- [x] Added persistent eval model cache usage for Jina under the eval cache path.
- [x] Added bounded embedding input text before provider calls.
- [x] Added unit coverage for new pack loading, non-required gate status, capability metadata, and external git cache reuse with sparse checkout.
- [x] `npm run build` passed.
- [x] `npx vitest run tests/unit/oss-eval-packs.test.ts tests/unit/evaluator.test.ts tests/unit/eval-gates.test.ts` passed with 3 files passed and 9 tests passed.
- [x] Ghostfolio hash eval passed blocking and produced the expected target baseline: `blockingStatus: pass`, `qualityStatus: fail`, 65 chunks, target 6/8, scoreboard 0/1.
- [x] Ghostfolio Jina eval passed blocking and produced the same target baseline: `blockingStatus: pass`, `qualityStatus: fail`, 65 chunks, target 6/8, scoreboard 0/1.
- [x] OpenStatus hash eval passed blocking and produced the expected target baseline: `blockingStatus: pass`, `qualityStatus: fail`, 122 chunks, target 5/8, scoreboard 0/1.
- [x] OpenStatus Jina eval passed blocking and produced the same target baseline: `blockingStatus: pass`, `qualityStatus: fail`, 122 chunks, target 5/8, scoreboard 0/1.
- [x] Hermes hash eval passed blocking and produced the expected target baseline: `blockingStatus: pass`, `qualityStatus: fail`, 143 chunks, target 5/8, scoreboard 0/1.
- [x] Hermes Jina eval passed blocking and produced the same target baseline: `blockingStatus: pass`, `qualityStatus: fail`, 143 chunks, target 5/8, scoreboard 0/1.
- [x] Eval reports classify new failures by layer and capability: Ghostfolio `graph-traversal`, `ranking`, `test-linking`; OpenStatus `chunking`, `graph-traversal`, `ranking`; Hermes `chunking`, `fusion`, `ranking`, `test-linking`.
- [x] Full package verification passed: `npm test` returned 21 test files passed, 1 skipped; 87 tests passed, 1 skipped.
- [x] `git diff --check` passed in `local-tools/code-intel`.
- [x] `git diff --check` passed in `local-doc/code-intelligence-graph`.
- [x] `npm pack --dry-run` passed with 296 files and 211.3 kB package size. No `code-intel-0.1.0.tgz` artifact was left behind.
- [x] `.DS_Store` check passed across `local-tools/code-intel` and `local-doc/code-intelligence-graph`.
