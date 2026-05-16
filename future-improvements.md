---
title: Code Intelligence Graph Future Improvements
feature: code-intelligence-graph
created: 2026-05-13
last_updated: 2026-05-16
status: active
---

# Code Intelligence Graph Future Improvements

This document tracks the next improvements for `local-tools/code-intel/` after the working MVP. The order is based on expected quality impact for the least implementation waste.

## Priority Order

| Priority | Improvement | Impact | Current Gap |
| --- | --- | --- | --- |
| Done | Make Jina the default semantic provider | Highest semantic quality gain | Default provider is now Jina; hash remains an explicit fallback. |
| Done | Incremental changed-file reindexing | Highest daily usability gain | `update` now reuses unchanged file facts and embeddings before publishing a fresh generation. |
| Done | Stronger eval harness | Highest confidence gain | Pack-based evals now cover deterministic synthetic regression, on-demand Rallly app-flow validation, and gated required/target/scoreboard reporting. |
| Done | A-grade AST structural facts | Highest downstream quality foundation | Tree-sitter now emits broad JS/TS structural facts, keeps embeddings out of the main structural facts JSON, and passes pinned Rallly AST eval cases. |
| Done | SCIP-first symbol and relationship accuracy | Higher graph trust | SCIP now promotes canonical symbols, writes evidence-backed relationship edges, persists normalized occurrence facts, and uses labeled AST fallback when SCIP omits definitions. |
| Done | Fusion module resolution and initial app-flow ranking | Highest JS/TS app-flow gain | Fusion now persists resolved module facts, resolves package exports and path aliases, and writes evidence-backed import/export/reference/call/test edges. |
| Done | Graph traversal and path semantics | Highest explainability gain | Shared traversal now powers `trace_path`, graph evals, CLI, and MCP with direction, depth, edge-kind, path-rank, and evidence controls. |
| Done | Deterministic hybrid ranking layer | Highest result quality gain | Semantic results now use semantic, lexical, symbol, graph, reference, caller/callee, import/export, and test signals with explainable rank metadata and current Rallly target gates passing. |
| P1.4 | Broader test relationship linking | Better implementation-to-test retrieval | Current gated route-test flows pass, but richer coverage-to-implementation mapping beyond direct imports still needs more fixtures and eval cases. |
| P1.5 | Eval corpus coverage diagnostics | Better eval trust | Some Rallly expectations may be missing because sparse checkout, discovery, or tsconfig filtering excluded files. |
| P2 | Ranking generalization and optional reranker | Better cross-corpus quality | Current deterministic weights are eval-backed but still hand-tuned; broader corpora and optional local reranking should come after candidate recall stays strong. |
| P2 | Performance batching and parallelism | Better indexing speed | Default Jina Rallly eval was too slow for a normal verification loop. |
| P2 | Skipped/ignored file reporting | Better diagnosis | Missing symbols can be hard to explain when files are skipped. |
| P2 | Type relationship graph | Better type-aware answers | `EXTENDS`, `IMPLEMENTS`, and type-use edges are still thin. |
| P2 | Tree-sitter grammar freshness | Better parser fidelity | The pinned TypeScript grammar can flag newer valid syntax such as `export type *` as a parse error even when useful facts are recovered. |
| P3 | MCP agent ergonomics | Better agent use | Tool descriptions and result guidance can improve once data quality is stronger. |
| P3 | Standalone packaging | Easier extraction | The package is standalone-shaped, but not yet extraction-ready. |

## P0: Make Jina The Default Semantic Provider

Status: completed on 2026-05-13. Keep this section for validation history and regression checks.

Goal: use `jinaai/jina-embeddings-v2-base-code` through Transformers.js as the normal semantic indexing path, while keeping `hash` only for fast tests and offline fallback.

Why this matters: the current default vectorization is deterministic and useful for test stability, but it is not the quality bar for code intelligence. Semantic search should mean model-backed semantic retrieval by default.

Implementation notes:

- Change the normal default provider from `hash` to `jina`.
- Keep an explicit `--embedding-provider hash` option for tests, CI, and offline diagnostics.
- Add a clear health warning when an index uses `hash`.
- Make query commands infer the provider from the index manifest, as they do now.
- Add a first-run model-cache message that explains whether the model is downloaded, missing, or already cached.

Acceptance criteria:

- `code-intel index` without an embedding-provider flag creates a Jina-backed index.
- `code-intel health` clearly reports model availability and embedding provider.
- Existing fast tests can still inject or select hash embeddings.
- Fixture semantic eval passes with Jina.
- A real POC semantic query ranks the expected code file first or near first.

Completion evidence:

- `createEmbeddingProvider()` defaults to Jina.
- `code-intel index` without an embedding-provider flag writes manifest embedding metadata as provider `jina`, model `jinaai/jina-embeddings-v2-base-code`, dimension `768`.
- `code-intel health` passes on a Jina index and warns on a hash index.
- CLI and MCP semantic queries infer provider/model/dimension from the same index manifest.
- `code-intel eval --json` passes with default Jina and reports embedding metadata.

## P0: Incremental Changed-File Reindexing

Status: completed on 2026-05-13. Keep this section for validation history and regression checks.

Goal: make `code-intel update` reuse unchanged work and refresh only added, changed, or deleted files where possible.

Why this matters: full rebuilds are safe but too slow for daily coding. A one-file edit should update the graph quickly.

Implementation notes:

- Add file fingerprints to the manifest or a generation-local cache: path, size, mtime, content hash, package, repo, language, and last indexed commit.
- Persist per-file facts: Tree-sitter chunks, symbol nodes, chunk hashes, source-call names, and embedding vectors.
- Make every generated node and edge traceable to a file owner so a changed file can be removed and replaced safely.
- On update, detect added, changed, unchanged, and deleted files.
- Rechunk and re-embed changed files only.
- Remove nodes and edges owned by deleted files.
- Preserve unchanged chunks and embeddings.
- For the first version, rerun SCIP at repo level but reuse Tree-sitter chunks and embeddings for unchanged files.
- Later, investigate whether SCIP occurrence facts can be safely cached or incrementally reconciled.

Acceptance criteria:

- Updating after one source-file change does not rechunk or re-embed unchanged files.
- Updating after a deleted file removes that file's symbols, chunks, references, and tests from query results.
- Updating after a new file makes new symbols queryable.
- The manifest records reused, changed, added, and deleted counts.
- Tests prove query results change after `update` without requiring a full rebuild.

Completion evidence:

- `code-intel update` now loads active generation facts, fingerprints current source files by bytes, classifies added, changed, deleted, and unchanged files, and writes `incremental` stats into the manifest.
- Unchanged file chunk facts and matching embedding vectors are reused. Changed and added files are rechunked, and missing embeddings are generated through the configured provider.
- Relationships are recomputed into a fresh Ladybug generation. Deleted files disappear by omission from the next generation instead of risky in-place row deletion.
- CLI, MCP, and query paths read the active generation manifest so metadata stays aligned with the published database generation.
- Tests cover planner classification, changed/added/deleted fixture updates, embedding reuse counts, query changes, full-index equivalence, CLI `update --json`, and MCP access after update.

## P0: Stronger Eval Harness

Status: completed on 2026-05-14. Keep this section for validation history and regression checks.

Goal: move from smoke confidence to measurable answer quality.

Why this matters: improvements need a scoreboard. Without expected-answer cases and false-positive checks, it is hard to know whether retrieval quality is improving.

Implementation notes:

- Add golden eval files for fixture and POC corpora.
- Include positive and negative expectations.
- Record ranking position, latency, provider, and index stats.
- Classify misses by layer: discovery, chunking, SCIP, graph, embedding, query, or ranking.
- Add real-repo eval cases for symbols, references, tests, imports, exports, and semantic concepts.

Acceptance criteria:

- `code-intel eval --json` reports pass/fail, rank, latency, and failure class.
- Eval cases include at least one false-positive guard.
- Hash and Jina evals can be compared.
- Regressions fail locally before manual review.

Completion evidence:

- Added `eval-packs/js-ts-general` with a committed synthetic corpus and JSON cases for exported symbols, re-exports, path alias references, React hooks, class methods, caller relationships, test relationships, semantic concept retrieval, and duplicate-method false-positive guarding.
- Added `eval-packs/oss-rallly-app-flow` with committed metadata and cases only. Rallly source is fetched on demand from the pinned commit instead of vendored into the tool.
- Added `--suite`, `--eval-pack`, `--eval-cache-path`, and `--fetch` CLI options for pack-based evals.
- Eval reports now include suite metadata, corpus metadata, embedding metadata, index stats, expected ranks, false-positive results, latency, failure class, `blockingStatus`, `qualityStatus`, and summary aggregates by gate status, gate, capability, rank, and failure class.
- Normal automated tests keep the synthetic pack as the hard regression gate. The Rallly pack now separates required focused AST/SCIP/fusion/graph gates from target ranking, graph traversal, and app-flow gates, so current misses remain visible without blocking the whole suite.

## Rallly-Informed 80/20 Quality Order

The first Rallly run was the quality baseline after AST and SCIP hardening. It proved the eval harness worked, but also showed real app-flow retrieval was not good enough yet. The fusion and hybrid-ranking pass moved that baseline forward.

Updated evidence:

- Synthetic `js-ts-general` passes all mechanical cases.
- Rallly hash-backed eval indexes the sparse app corpus successfully.
- Rallly gated hash-backed eval now returns `status: pass`, `blockingStatus: pass`, and `qualityStatus: pass`.
- Rallly required gates pass 13 of 13 across focused AST, SCIP, fusion, and graph relationship cases, including create/delete poll routes, database imports, middleware imports, UI, and route-test imports.
- Rallly target gates now pass 12 of 12 across hybrid ranking, graph traversal, and full app-flow retrieval cases.
- Current Rallly target ranking metrics are `MRR@10 0.904762`, `Recall@K 0.880952`, and `nDCG@10 0.808548`.
- The current pass is still an eval target, not a universal guarantee. Additional cases should be added when new app-flow patterns are found so the ranking weights do not overfit one fixture or one Rallly path.

The AST/chunking foundation, SCIP-first relationship item, fusion resolution item, graph traversal item, and deterministic hybrid ranking item have now been completed. The next 80/20 order from the current evidence is:

1. Broader test relationship linking.
   - Current gated test-to-implementation cases pass through import and ranking evidence.
   - The remaining opportunity is coverage-oriented linking beyond direct imports, such as implementation-to-test ownership, naming fallback with confidence, and package-local test discovery.

2. Eval corpus coverage diagnostics.
   - Before treating a miss as retrieval quality, report whether the expected path was fetched, discovered, indexed, chunked, embedded, and queryable.
   - This separates real retrieval misses from sparse-checkout or discovery misses.

3. Ranking generalization and optional reranker.
   - Keep the deterministic hybrid ranker as the default and expand eval coverage before changing weights.
   - Add an optional local reranker only after candidate recall and explainability remain strong across more corpora.

4. Type relationship graph.
   - Add `EXTENDS`, `IMPLEMENTS`, and type-use edges after import/export, references, and calls are stable.
   - This improves class/interface answers without blocking the app-flow foundation.

5. Jina performance batching.
   - Keep this after quality ranking work unless Jina eval time blocks every iteration.
   - Default Jina Rallly eval was CPU-active for several minutes and did not produce a report inside the local command window.

## Completed: Fusion Module Resolution And Hybrid App-Flow Ranking

Status: completed on 2026-05-15. Keep this section for validation history and regression checks.

Goal: improve result order for real app-flow questions by combining multiple evidence signals instead of relying on vector score alone.

Why this matters: the Rallly eval shows expected files can be present but ranked too low. Agents usually use the first few results, so a correct result at rank 17 still behaves like a miss.

Implementation notes:

- Keep semantic score as one signal, not the whole rank.
- Add exact symbol, file-name, path-token, package-name, and query-token boosts.
- Boost route/source files for implementation queries and test files for test queries.
- Boost graph-neighbor results when a semantic seed has import, export, reference, call, or test edges.
- Prefer SCIP-backed relationships over heuristic relationships.
- Return ranking metadata so failures explain which signals contributed.
- Resolve module specifiers before ranking so graph-neighbor boosts can use real import/export/package boundaries.

Acceptance criteria:

- Rallly create-poll route moves from rank 17 into the expected top 8.
- Rallly delete-poll mutation moves from rank 18 into the expected top 12.
- Synthetic exact symbol cases stay rank 1.
- False-positive guards still pass.

Completion evidence:

- Fusion now writes generation-local `facts/resolution.json` with `factsSchemaVersion: code-intel.resolved-facts.v1`.
- Module resolution covers relative imports, `tsconfig` aliases, workspace package names, package exports, barrels, re-exports, default imports, named imports, namespace imports, dynamic imports, CommonJS imports, and unresolved cases where they are statically knowable.
- Graph edges now carry SCIP, AST, and module-resolution evidence metadata, including confidence, owner file, range, containing chunk, specifier, local/exported names, member path, target file, target package, target symbol, and fallback reason.
- Hybrid ranking combines vector candidates with symbol text, code-like tokens, path tokens, route/API/mutation/database/test/file-kind signals, and graph-neighbor evidence.
- Hash-backed synthetic eval passes 14 of 14 required cases.
- Hash-backed Rallly gated eval passes 13 of 13 required gates and 7 of 7 target gates.

## Completed: A-Grade AST Structural Facts

Status: completed on 2026-05-15. Keep this section for validation history and regression checks.

Goal: improve the Tree-sitter layer so it emits reusable JS/TS structural facts rather than only basic chunks, and harden the facts enough to use as the source layer before SCIP fusion.

Why this matters: ranking and graph traversal cannot make reliable app-flow decisions if the extractor does not first capture imports, exports, declarations, calls, member paths, tests, and ownership with stable provenance.

Completion evidence:

- `extractSourceFileFacts()` now emits chunks, imports, exports, declarations, calls, member accesses, ownerships, test cases, callbacks, stable ranges, source hashes, owner file, and containing chunk provenance.
- Extraction now covers JS, JSX, TS, TSX, dynamic imports, CommonJS `require`, CommonJS exports, export star, export namespace, export type, anonymous default exports, decorators where supported, constructor calls, optional chained calls, JSX component usage, and top-level variable declarations.
- `chunkSourceFile()` remains a legacy chunk-only wrapper. The indexer uses `extractSourceFileFacts()` through the file-facts pipeline.
- Generation-local `files.json` persists the richer AST facts so incremental update can reuse unchanged file facts. Chunk vectors now persist separately in `facts/embeddings.json`.
- The graph builder writes `Import` and `Export` nodes plus `IMPORTS` and `EXPORTS` edges from owning files.
- Golden AST tests cover imports, exports, re-exports, default exports, namespace imports, function declarations, class methods, object methods, variable-declared functions, top-level variables, decorators, constructors, member calls, optional chained calls, JSX component usage, duplicate method names, test cases, and partial syntax files.
- The Rallly eval pack includes AST cases for API route, API mutation, database client, UI loader, middleware, and route test files. The hash-backed Rallly run passes all six AST cases.

Remaining work:

- Import/export target resolution and initial ranking consumption are now completed in the fusion pass.
- Broader coverage-to-test ownership and type relationship extraction remain follow-up layers.
- Ranking still needs more eval cases and diagnostics before any learned or configurable weighting is worth adding.
- The pinned Tree-sitter TypeScript grammar reports a parse error on Rallly's valid `export type *` syntax in `packages/database/src/client.ts`; the current extractor still recovers the required facts, but grammar freshness should be revisited before standalone packaging.

## Completed: Import/Export Graph Resolution

Status: completed on 2026-05-15 as part of the fusion module resolution pass. Keep this section for validation history and regression checks.

Goal: resolve first-class import and export facts to target files, packages, and package export entries so package and API flow questions are reliable.

Why this matters: many JS/TS questions are really import/export questions: where is this exported, who imports this module, and what package exposes this API.

Implementation notes:

- Use the persisted Tree-sitter import and export facts as the source facts.
- Resolve relative specifiers, tsconfig path aliases, package names, and package `exports` maps to target files or packages.
- Add target-resolved `IMPORTS` and `EXPORTS` edges with source file, target file or package, original specifier, package name, and range.
- Connect package exports from `package.json` to source files when resolvable.
- Add queries or filters for import/export relationships.

Acceptance criteria:

- Querying a known exported hook returns its exporting file or package entry point.
- Querying a known imported module returns importing files.
- Package dependency edges and source import edges are distinct.

Completion evidence:

- Synthetic fixtures now cover package exports, path aliases, barrels, re-exports, default exports, namespace imports, CommonJS, dynamic imports, duplicate names, member calls, tests, and unresolved cases.
- `tests/integration/fusion-resolution.test.ts` asserts resolved facts and graph edges for package export resolution, path alias resolution, default export resolution, CommonJS resolution, dynamic import status, and unresolved import status.
- Rallly required and target gates prove route-to-mutation, mutation-to-database, middleware-to-route, UI-to-data/API, test-to-implementation, package-boundary import, re-export/canonical symbol resolution, false-positive guards, and transitive route-to-mutation-to-database paths.

## P1.3: SCIP-First Symbol And Relationship Accuracy

Status: completed on 2026-05-15. Keep this section for validation history and regression checks.

Goal: make compiler-aware SCIP facts the primary source for definitions, references, symbol occurrence relationships, and symbol-to-chunk ranking.

Why this matters: current call and reference edges are good enough for MVP, but some relationships still rely on Tree-sitter name matching. That can create false positives when names repeat across scopes, methods, imports, or packages. Rallly also shows nearby symbols can outrank the intended function.

Implementation notes:

- Preserve SCIP occurrence ranges as first-class evidence.
- Map SCIP occurrences to containing chunks and symbols by file and range.
- Prefer SCIP references over Tree-sitter fallback references whenever SCIP facts exist.
- Limit Tree-sitter call edges to local fallback or confidence-labeled edges.
- Add relationship confidence metadata, such as `source: scip-typescript` or `source: tree-sitter-fallback`.
- Rank exact SCIP symbol matches above neighboring chunks for symbol-like queries.

Acceptance criteria:

- Known references resolve to the expected file and symbol.
- Duplicate method names across classes do not cross-link incorrectly.
- Relationship results include evidence source.
- Large repos do not run quadratic Tree-sitter reference matching.
- Rallly `createPoll` and `deletePoll` expectations surface the intended symbols, not only adjacent params or helper chunks.

Completion evidence:

- `src/scip/ingest.ts` now emits definitions, references, role-aware occurrences, raw role masks, normalized read references, test-file references, ranges, enclosing ranges, and symbol metadata.
- `src/indexer/scip-fusion.ts` maps SCIP definitions onto existing Tree-sitter declarations, promotes matching AST symbols to SCIP-backed canonical symbols, and creates SCIP evidence-backed `REFERENCES`, `CALLS`, `IMPORTS`, `EXPORTS`, `TESTS`, and `MENTIONS` edges.
- The indexer creates declaration-backed symbols for non-chunk AST declarations, which lets import/export fallback target exported variables such as database clients and middleware functions when SCIP omits those definitions.
- Normalized SCIP facts persist to generation-local `facts/scip.json` with `factsSchemaVersion: code-intel.scip-facts.v1`.
- Query relationship results expose edge provenance under `metadata.relationship`, including `evidenceSources`, `roles`, `scipSymbol`, `scipRange`, and confidence.
- Tree-sitter relationship matching is only invoked as a labeled fallback when SCIP indexing fails or when SCIP succeeds but does not contain the target definition.
- Synthetic fixtures and eval cases now cover read references, type imports, re-exports, path aliases, duplicate method names, class method callees, tests, and cross-package references.
- Rallly eval metadata now includes `createPoll`, `deletePoll`, `prisma`, `spaceApiKeyAuth`, UI, and private route-test relationship cases so the real app-flow suite can distinguish graph misses from ranking misses.

## P1.4: Test Relationship Linking

Goal: connect implementation files and symbols to relevant tests more reliably.

Why this matters: agent workflows often ask "what tests cover this" or need to update tests after changing an implementation. Rallly showed route files can surface while matching route tests are missing.

Implementation notes:

- Use SCIP imports from test files to source files and symbols.
- Add naming heuristics only as confidence-labeled fallback, such as `route.ts` to `route.test.ts`.
- Add package-local test ownership metadata.
- Support `TESTS` edges from test chunks to symbols and source files.
- Make eval cases distinguish direct import evidence from naming fallback evidence.

Acceptance criteria:

- Rallly private API route eval returns both `route.ts` and `route.test.ts` inside expected rank.
- Synthetic test relationship still passes.
- Test relationship results include evidence source.

## P1.5: Eval Corpus Coverage Diagnostics

Goal: make every eval miss explain whether the expected path was present in the corpus, discovered by the workspace scanner, indexed into graph nodes, chunked, embedded, and queryable.

Why this matters: Rallly is fetched through sparse checkout and then filtered by discovery rules. A missing expected file might be an eval corpus issue, not a retrieval issue.

Implementation notes:

- Add an eval preflight that checks expected path patterns against the fetched corpus.
- Add a discovered-file check after workspace discovery.
- Add graph node and chunk presence checks after indexing.
- Include preflight status per expectation in eval JSON.
- Classify misses as `discovery`, `chunking`, `embedding`, `query`, or `ranking` based on the deepest layer that contains the expected file.

Acceptance criteria:

- Rallly missing dashboard, database, or test paths report whether the file was fetched and indexed.
- Eval failure classes are not all collapsed into `ranking` when a file never entered the index.
- Synthetic eval reports full coverage for every expected file.

## Completed: Deterministic Hybrid Ranking Layer

Status: completed on 2026-05-16. Keep this section for validation history and regression checks.

Goal: make CLI and MCP semantic results deterministic, hybrid, evidence-aware, and explainable instead of raw vector ordering.

Why this matters: agents often use the first few results. Correct results buried below noisy neighbors still hurt usefulness.

Implementation notes:

- Candidate generation now combines semantic vector rows, lexical/path/name rows, exact symbols, graph relationships, reference/call/import/export/test evidence, caller/callee signals, and test-to-implementation pairs.
- Query intent is classified as implementation, caller, callee, test, app-flow, or broad semantic.
- Ranking uses deterministic RRF-style fusion plus code-aware boosts and demotions for exact symbols, SCIP/fusion evidence, graph confidence, app-flow paths, test/source file kind, weak mentions, fallback-only edges, generated/vendor paths, and duplicate file/chunk noise.
- CLI and MCP semantic results expose `metadata.ranking` with intent, source ranks, signals, reasons, scores, evidence, and demotions.
- Eval reports now include `MRR@10`, `Recall@K`, `nDCG@10`, expected totals, expected found or missing counts, and false-positive counts.

Acceptance criteria:

- Synthetic fixture tests prove deterministic ordering, exact-symbol priority, implementation intent, test intent, graph-backed ranking, dedupe, and false-positive suppression.
- Rallly required and target gates pass without weakening graph assertions.
- Ranking metadata explains why each result was promoted or demoted.
- Optional local reranking remains a later extension point, not the P0 default.

Completion evidence:

- Focused ranking verification passed across integration, evaluator, eval-gate, e2e eval, MCP, and CLI process tests.
- Hash-backed synthetic eval passes with `status: pass`, `blockingStatus: pass`, and `qualityStatus: pass`.
- Hash-backed Rallly eval passes with `status: pass`, `blockingStatus: pass`, `qualityStatus: pass`, 13 of 13 required gates, and 12 of 12 target gates.
- Rallly target ranking metrics after this pass are `MRR@10 0.904762`, `Recall@K 0.880952`, and `nDCG@10 0.808548`.
- The private API test-flow target now ranks `route.ts` first and `route.test.ts` second.

## P2: Ranking Generalization And Optional Reranker

Goal: improve ranking confidence across broader corpora without replacing deterministic rank evidence too early.

Why this matters: the current ranker is deterministic and eval-backed, but it is still rule-weighted. A reranker can improve final ordering only if the candidate pool already contains the right files and the eval suite can detect overfitting.

Implementation notes:

- Add more OSS app-flow packs before changing weights significantly.
- Track per-intent quality deltas across implementation, caller, callee, test, app-flow, and broad semantic searches.
- Consider configurable weights only when eval evidence shows one static policy is insufficient.
- Add optional local reranker support, such as a Jina reranker, after deterministic candidate recall is proven.
- Keep rank reasons and demotions visible even when an optional reranker is enabled.

Acceptance criteria:

- Broader corpora improve or stay neutral on `MRR@10`, `Recall@K`, and `nDCG@10`.
- Optional reranking cannot hide exact symbols, SCIP/fusion evidence, or required graph paths.
- CLI and MCP reports make it clear whether deterministic ranking or reranking produced the final order.

## P2: Skipped And Ignored File Reporting

Goal: make index omissions visible.

Why this matters: when a symbol is missing, the first question is whether the file was skipped, ignored, too large, excluded by tsconfig, or failed during parsing.

Implementation notes:

- Track skipped paths with reason codes.
- Include ignored directory counts.
- Include files skipped by tsconfig/jsconfig excludes.
- Include files skipped by size or unsupported extension.
- Surface this in `status`, `health`, and the manifest.

Acceptance criteria:

- `status --json` can explain skipped-file counts.
- `health --json` warns on parse, discovery, or size skips.
- Tests assert ignored generated files are reported when relevant.

## P2: Performance Batching And Parallelism

Goal: reduce index time after Jina and incremental updates are in place.

Implementation notes:

- Parallelize file reads and Tree-sitter chunking with bounded concurrency.
- Batch Jina embeddings more aggressively.
- Avoid re-reading source for unchanged chunks.
- Keep Ladybug writes batched.
- Add timing breakdowns to manifest health or verbose output.

Acceptance criteria:

- Index output reports timing by discovery, chunking, SCIP, embedding, and graph write.
- Jina-backed fixture and POC runs stay within documented local expectations.

## P2: Type Relationship Graph

Goal: enrich class, interface, type alias, and type-use relationships.

Implementation notes:

- Add `EXTENDS` and `IMPLEMENTS` edges from AST or SCIP facts.
- Add class-method ownership edges.
- Add type alias and generic usage edges where reliable.
- Add tests for known interface, class, and type alias relationships.

Acceptance criteria:

- Querying a class or interface shows inheritance and implementation neighbors.
- Methods are associated with their owning class or object shape.

## P3: MCP Agent Ergonomics

Goal: make MCP responses easier for agents to use correctly.

Implementation notes:

- Improve tool descriptions after query quality stabilizes.
- Add concise result summaries.
- Add confidence and evidence labels.
- Add suggested next query hints only when they are grounded in result data.
- Keep source excerpts bounded and opt-in.

Acceptance criteria:

- Agents can choose between exact search, semantic search, symbol lookup, and context expansion based on tool descriptions.
- MCP output stays schema-validated and bounded.

## P3: Standalone Packaging

Goal: prepare the tool to move into its own repository.

Implementation notes:

- Decide package name and repo layout.
- Add install and setup docs.
- Add model-cache docs.
- Add example MCP config.
- Add fixture corpus docs.
- Decide release and versioning policy.

Acceptance criteria:

- A clean clone can install, build, index fixtures, run MCP tests, and run evals from documented commands.
- Local-only capsule-org paths are not required for normal operation.
