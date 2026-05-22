---
title: Code Intelligence Graph Feature Plan
feature: code-intelligence-graph
created: 2026-05-13
last_updated: 2026-05-22
status: active
---

# Code Intelligence Graph Feature Plan

## Objective

Create a local-first JS/TS code intelligence CLI with built-in MCP access. The work started as local operator tooling under the `capsule-org` workspace, with Para repositories as the first proof-of-concept corpus. The product direction is general-purpose JS/TS repository intelligence, and the implementation now lives as its own local repository.

The implementation must be production-shaped from the start: schema contracts, persistent local storage, deterministic indexing, query tests, health checks, and bounded MCP outputs.

## Implementation Location

Source:

```text
/Users/jordy/Documents/GitHub/code-intel/
```

Generated artifacts:

```text
<workspace>/.code-intel/
```

The tool should not be placed inside `docs-mintlify`, `js-monorepo`, or `user-management` because it is cross-repo local operator tooling. It is also not Para-specific product code.

## Package Shape

Package structure:

```text
code-intel/
  package.json
  tsconfig.json
  docs/
  src/
    cli/
      main.ts
      program.ts
    core/
    workspace/
    scip/
    treesitter/
    graph/
    vectors/
    search/
    mcp/
    eval/
    schema/
  tests/
    fixtures/
    integration/
    cli/
    mcp/
    unit/
```

The CLI and MCP server must call the same core library. MCP should not duplicate query logic.

Build the package with `tsc` into `dist/` and expose `code-intel` through the `package.json` `bin` field. Do not bundle the first implementation.

## Testing Strategy

`testing-strategy.md` is the source of truth for layer-by-layer validation. Implementation work must keep tests split by failure class so a miss can be traced to CLI parsing, output presentation, workspace discovery, precise indexing, syntax chunking, graph writes, vector search, query shaping, MCP transport, or eval quality.

Expected package scripts:

```text
test
test:unit
test:integration
test:cli
test:mcp
test:e2e
eval
```

The minimum readiness gate before agent use is unit tests, fixture integration tests, CLI process tests, MCP stdio tests, fixture end-to-end tests, and first proof-of-concept smoke queries.

The eval system now uses a layered pack portfolio:

- Synthetic fixture pack: `eval-packs/js-ts-general`. This is committed with the tool and remains the deterministic, small, fast regression suite.
- Adversarial packs: `eval-packs/js-ts-adversarial` and `eval-packs/oss-rallly-adversarial`. These pin syntax, graph, module, test-linking, ranking, MCP agent-readiness, CLI/MCP parity, type-precision, and false-positive edge cases without making every target part of the default blocking suite.
- First real app-flow pack: `eval-packs/oss-rallly-app-flow`. This commits pack metadata and expected cases only; the source repository is fetched on demand into an eval cache and pinned to a commit.
- Cross-OSS generalization packs: `oss-ghostfolio-app-flow`, `oss-openstatus-app-flow`, and `oss-hermes-agent-ui`.
- Holdout packs: `oss-dub-app-flow`, `oss-twenty-crm-flow`, and `oss-formbricks-survey-flow`.

The packs serve different jobs. The synthetic pack proves mechanical correctness and protects edge cases we intentionally design. Rallly proves app-flow usefulness against the first real pinned app. The adversarial and cross-OSS packs keep graph, ranking, discovery, module resolution, test-linking, and false-positive behavior from overfitting to one repo shape.

Eval cases now use `required`, `target`, and `scoreboard` gate metadata. Required gates are the blocking regression contract. Target gates capture active quality targets for fusion, graph traversal, ranking, and end-to-end app-flow work. Scoreboard gates are non-blocking trend metrics. Reports must summarize blocking status separately from quality status so a real-app target miss is actionable evidence instead of hidden noise or a false release blocker.

## Workstream 1: Feature Docs And Stack Lock

Create the local feature docs and stack reference before implementation.

Exit criteria:

- `feature-spec.md` exists.
- `feature-plan.md` exists.
- `feature-design-notes.md` exists.
- `verification-checklist.md` exists.
- `testing-strategy.md` exists.
- `research/01-local-stack-reference.md` exists.
- Jordy reviews and approves the stack decisions or requests revisions.

## Workstream 2: CLI Skeleton And Health

Build the CLI skeleton with no indexing yet.

Tooling:

- Use `commander` for the command tree.
- Use a `createCliProgram()` factory so command parsing can be tested without process globals.
- Keep command actions thin; all indexing, query, health, and MCP behavior should live behind core modules.
- Use `vitest` for command parser and presenter tests.
- Use `execa` for process-level CLI tests with stdio pipes.
- Test `isTTY` presenter behavior through unit tests. Add a terminal-control harness only if a future CLI feature needs raw input, resize handling, cursor movement, or progress UI.

Commands:

```text
code-intel status
code-intel health
code-intel progress
code-intel mcp
```

Health checks:

- Node.js version is 20 or newer.
- `rg` is installed.
- `scip-typescript` can be executed or resolved from package dependencies.
- Tree-sitter JS/TS parsers load.
- LadybugDB can open a persistent `.lbug` database path.
- LadybugDB vector extension is available and can be loaded.
- Transformers.js can load the configured embedding model or report model-cache setup status.
- MCP server starts over stdio without writing logs to stdout.
- Pipe-based CLI tests cover stdout, stderr, exit codes, `--json`, and errors.
- Presenter tests cover behavior that changes when stdout is a TTY.

Exit criteria:

- CLI runs locally from the workspace root.
- `health` reports actionable pass/fail checks.
- `mcp` registers a `health` tool.
- Non-TTY CLI output is deterministic.
- TTY-only output is verified where the CLI intentionally uses terminal capabilities.

## Workstream 3: Schema Contract

Define the canonical schema before writing index data.

Artifacts:

- `schemaVersion`
- node schemas
- edge schemas
- chunk schemas
- vector metadata schemas
- MCP input/output schemas
- index manifest schema

Exit criteria:

- All records pass `zod` validation before writes.
- Golden fixture JSON files exist for nodes, edges, semantic results, and MCP outputs.
- Invalid records fail tests with useful errors.
- Schema version appears in every generated artifact.

## Workstream 4: Workspace And Package Discovery

Implement workspace discovery for JS/TS repos.

Inputs:

- explicit CLI `--repo` paths
- optional workspace manifest
- `package.json`
- workspaces field
- package manager files
- `tsconfig.json` and `jsconfig.json`

Exit criteria:

- The tool can discover packages in `js-monorepo` as the first real proof-of-concept corpus.
- The tool can discover package names, paths, exports, dependencies, and source roots.
- Discovery results are written to the graph as `Repo`, `Package`, and `File` nodes.

## Workstream 5: Precise Index Ingestion

Run and ingest `scip-typescript`.

Requirements:

- Use `scip-typescript index` for TS projects.
- Plan SCIP with a repo-local shard model derived from code-intel discovery, not by passing the whole repo root as one TypeScript project.
- Run one `scip-typescript` child process per shard with the repo root as `cwd`, a bounded default heap no larger than 1 GB, and `--no-global-caches`.
- Preserve raw shard `.scip` outputs under paths keyed by repo and shard identity so package shards, root-file shards, and future config shards cannot overwrite each other.
- Include a repo-level shard for discovered files outside workspace packages, such as root tests, e2e tests, scripts, or config-adjacent source that discovery includes.
- Exclude generated and vendor directories from inferred shard configs using the same policy as code-intel discovery, including `.next`, `generated`, and `__generated__`.
- Ingest shard outputs with a two-pass repo-level symbol catalog so references in one shard can resolve definitions emitted by another shard.
- For repos without `tsconfig.json`, generate an inferred SCIP config under index scratch space and pass that config path to `scip-typescript index` instead of allowing `--infer-tsconfig` to write into the source repo.
- Use workspace flags when appropriate for Yarn or pnpm workspaces.
- Preserve raw `.scip` files under `.code-intel/scip/`.

Exit criteria:

- Definitions, references, occurrences, ranges, role masks, and normalized read/test facts from SCIP become generation-local facts.
- Cross-package references retain SCIP evidence when the referenced definition lives in a different shard.
- Root-level discovered files outside packages receive SCIP coverage when their imports are valid under the repo root config.
- Generated files ignored by discovery are absent from persisted SCIP facts even when TypeScript would include them through a broad shard config.
- Matching Tree-sitter declaration symbols are promoted to SCIP-backed canonical symbols instead of creating duplicate AST and SCIP symbols.
- SCIP-backed `REFERENCES`, `CALLS`, `IMPORTS`, `EXPORTS`, `TESTS`, and `MENTIONS` edges include evidence metadata.
- Tree-sitter name matching is used only as a labeled fallback when SCIP fails or when SCIP lacks a target definition.
- Non-chunk AST declarations become declaration-backed graph symbols so imports and exports can target variables, database clients, middleware values, and route aliases.
- Normalized SCIP facts are persisted under `facts/scip.json`.
- Known exported symbols can be resolved from `js-monorepo` as the first real proof-of-concept corpus.
- References point to stable file ranges.
- Missing or failed SCIP indexes are reported by `health`.

## Workstream 6: Tree-sitter Structural Facts

Parse source with Tree-sitter and build chunks plus reusable structural facts.

Chunk targets:

- functions
- classes
- interfaces
- type aliases
- top-level variable declarations
- exported constants
- React components
- hooks
- test cases
- import declarations
- dynamic imports
- CommonJS `require`
- export declarations
- CommonJS `module.exports` and `exports.foo`
- re-exports
- default exports
- namespace imports
- decorators where the bundled grammar supports them
- constructor calls
- object methods
- variable-declared functions
- member calls
- optional chained calls
- JSX component usage
- nested callbacks
- parent/child ownership

Exit criteria:

- Chunks align to complete syntax ranges.
- Chunks keep repo, file, range, language, symbol name when available, and source hash.
- File facts include static imports, dynamic imports, CommonJS imports, exports, CommonJS exports, declarations, decorators, constructor calls, function calls, member calls, JSX usage, member access, ownership, test cases, callbacks, stable ranges, source hashes, owner file, and containing chunk provenance.
- Duplicate method names keep backward-compatible chunk names while declaration facts carry qualified names such as `ClassName.method`.
- Test cases become explicit `Test` chunks when they can be parsed.
- Import and export facts are persisted and written to graph nodes with `IMPORTS` and `EXPORTS` edges from owning files.
- Structural facts persist to `facts/files.json` with a separate facts schema version, while reusable chunk embeddings persist to `facts/embeddings.json`.
- Pinned Rallly AST cases pass for representative API route, API mutation, database client, UI loader, middleware, and test files.
- Tree-sitter fallback chunks are linked to SCIP symbols when ranges overlap.
- Chunks are available through `get_context`.

## Workstream 7: Graph Persistence

Write the code relationship graph and vector-searchable chunks to LadybugDB.

Requirements:

- Open `@ladybugdb/core` with an on-disk path under `.code-intel/code-intel.lbug`.
- Create typed node tables for repositories, packages, files, symbols, chunks, and tests.
- Create typed relationship tables for imports, exports, definitions, references, calls, package dependencies, chunks, and test coverage.
- Use Cypher for relationship traversal, joins, recursive expansion where supported, and path-style queries.
- Keep node IDs, repo, package, file, and symbol-name fields indexed according to Ladybug schema rules.

Exit criteria:

- Graph can be rebuilt from scratch.
- Graph can be reopened after process exit.
- Generation-local `facts/resolution.json` records resolved modules, package exports, import bindings, export bindings, target files, target packages, target symbols, unresolved status, and fallback reasons.
- `IMPORTS`, `EXPORTS`, `REFERENCES`, `CALLS`, `TESTS`, and `MENTIONS` edges preserve SCIP, AST, and module-resolution evidence with owner file, range, confidence, containing chunk, specifier, local/exported names, member path, and fallback reason.
- `find_symbol`, `get_references`, `get_callers`, `get_callees`, and `trace_path` operate from graph data.
- Graph health catches dangling edges and missing node IDs.

## Workstream 8: Native Vector Indexing

Build the semantic index inside LadybugDB.

Requirements:

- Store embeddings on the `Chunk` node table as a typed float-array property.
- Load or verify the Ladybug `vector` extension.
- Create a native HNSW vector index on the chunk embedding property.
- Store node ID, repo, package, file, range, symbol, chunk kind, content hash, and embedding model version on the same chunk node.
- Generate embeddings locally through Transformers.js and `jinaai/jina-embeddings-v2-base-code`.
- Use mean pooling and normalized vectors.
- Query the vector index with `QUERY_VECTOR_INDEX` and then continue graph traversal from the returned `node`.

Exit criteria:

- `semantic` returns ranked chunk IDs and metadata.
- Results can be filtered by repo, package, file kind, or symbol kind.
- Semantic results are already graph nodes and can be expanded without joining a second database.
- Reindexing updates changed chunks without duplicating stale records.

## Workstream 9: Query Engine

Implement high-level queries over graph, vector, and exact search.

Required behaviors:

- `search_text` uses `rg --json` and normalizes results.
- `semantic_search` queries LadybugDB vector indexes and returns hybrid-ranked pointers using vector similarity, symbol text, path tokens, file-kind signals, and graph-neighbor evidence.
- `find_symbol` uses graph and SCIP-derived symbol records.
- `expand_context` walks graph edges from seed nodes.
- `get_context` returns bounded source excerpts for selected nodes.
- `trace_path` returns graph paths between two nodes when available.

Exit criteria:

- Query output is deterministic and schema-validated.
- Query outputs include enough evidence for an LLM to decide what to read next.
- Query outputs avoid large source dumps unless explicitly requested.

## Workstream 10: MCP Server

Expose query tools over MCP stdio.

Requirements:

- Use `@modelcontextprotocol/sdk`.
- Use `StdioServerTransport` for `code-intel mcp`.
- Register bounded tools with descriptions and `zod` input schemas.
- Do not use `console.log` in stdio mode.
- Return structured JSON payloads through MCP `structuredContent` and compatible text content.
- Enforce query limits.
- Test MCP through stdio pipes or the SDK client transport.

Exit criteria:

- MCP Inspector or a local MCP-compatible client can list and call tools.
- `health`, `semantic_search`, `find_symbol`, `get_relationships`, diagnostics tools, `trace_path`, `expand_context`, and `get_context` work through MCP.
- Tool descriptions are clear enough that an LLM can choose exact search, semantic search, or graph expansion appropriately.
- Tools advertise `outputSchema`, successful calls return `structuredContent`, and source excerpts remain bounded to context tools.
- Tests fail if the MCP process writes non-MCP content to stdout.

## Workstream 11: Eval Suite

Create repeatable local evaluations before using the tool for real agent work.

Fixture repo cases:

- simple exported function
- re-exported symbol
- path alias import
- React hook
- class method
- caller/callee chain
- test covering a function
- semantic query where no exact term is present
- false-positive guard

First proof-of-concept repo smoke cases:

- known SDK hook symbol
- known package export
- known test relationship
- known semantic concept query
- known cross-package dependency query

Required gate categories:

- Synthetic required gates for AST, SCIP, fusion, graph, ranking, and false-positive mechanics.
- Rallly required gates for route-to-mutation, mutation-to-database, middleware-to-route, UI-to-data/API, test-to-implementation, package-boundary imports, and canonical symbol resolution where focused graph or AST evidence should already pass.
- Rallly target gates for transitive graph traversal, hybrid ranking, and full app-flow retrieval.
- Adversarial required, target, and scoreboard gates for syntax edge cases, module/export resolution, graph evidence, test-linking, ranking intent, MCP agent-readiness, type-precision, and false-positive guards.
- Cross-OSS and holdout target/scoreboard gates for Ghostfolio, OpenStatus, Hermes, Dub, Twenty, and Formbricks app-flow patterns.

Exit criteria:

- `code-intel eval` passes against fixtures.
- At least five real queries from the first proof-of-concept corpus return expected files or symbols.
- Failures are classified by layer and gate status, including discovery, chunking, SCIP, fusion, graph, embedding, query, ranking, MCP, and app-flow.
- CLI JSON reports include `blockingStatus`, `qualityStatus`, gate status totals, per-gate summaries, per-capability summaries, rank summaries, and failure-class summaries.

## Workstream 12: Pre-Standalone Readiness

Before extracting the tool into a standalone repository, harden the operational surfaces that prove the green eval matrix is meaningful.

Required behaviors:

- Persist generation-local diagnostics for file lifecycle, skipped paths, graph writes, embeddings, and queryability.
- Expose `diagnose file`, `diagnose symbol`, and `eval --diagnostics` so misses can be classified as fetch, sparse-checkout, discovery, ignore, tsconfig, parse, AST, SCIP, fusion, graph, embedding, query, or ranking.
- Add a repeatable `benchmark` harness that copies an eval corpus and measures cold index, warm update, changed-file update, deleted-file update, query latency, optional MCP query latency, memory, batching, graph counts, Ladybug concurrent-read behavior, reader-during-update behavior, reader-after-publish behavior, retry counts, queue wait time, lock wait time, and failure classification.
- Harden concurrency before standalone packaging: bounded query-engine serialization, database-path-scoped Ladybug process locks, active-generation snapshot consistency, stale generation reads, stale lock recovery, and explicit lock-timeout reporting.
- Improve MCP tool descriptions and response guidance so agents understand when to use exact search, semantic search, symbol lookup, references, relationship browsing, diagnostics, graph expansion, path tracing, and context reads.
- Expose index/update progress through a shared progress artifact, CLI `progress`, `status`, MCP `index_progress`, and `workspace_overview` without treating in-flight writes as active generations.
- Add substep progress, append-only JSONL run events, queryable recent events, SCIP quality warnings, discovery summaries, rich failure details, and index write-lock state for hang diagnosis.

Exit criteria:

- Diagnostics are written under `facts/diagnostics.json` for every generation.
- Focused tests prove included files, ignored paths, tsconfig exclusions, unsupported files, parsed files, graph-written files, embedded chunks, queryable symbols, and ignored-file diagnosis.
- Eval JSON reports include diagnostics preflight when requested.
- Benchmark JSON reports include indexing, update, query, MCP, memory, batching, count, lock, queue, retry, concurrent read/write, and failure-classification fields.
- Focused concurrency tests prove parallel semantic/symbol/reference/caller reads, MCP parallel tool calls, reader-during-update, reader-after-publish, stale generation handling, live lock timeout reporting, and stale lock recovery.
- MCP tests prove response guidance metadata, structured output schemas, diagnostics tools, relationship browsing, stronger descriptions, bounded outputs, stdout protocol purity, and CLI/MCP result agreement.
- Progress tests prove atomic progress persistence, stale detection, coarse phase updates, substep updates, JSONL event persistence, recent event querying, failed update reporting with rich error details, SCIP quality evidence, discovery summaries, write-lock state, stderr-only live CLI progress, and MCP progress visibility.

## Workstream 13: Jina And Tree-sitter Embedding Input Hardening

Reference label: `workstream:jina-tree-sitter-embedding-input-hardening`

This hardening track exists to make Jina-backed semantic indexing fast enough, observable enough, and accurate enough for large local workspaces without bypassing the Jina path or replacing it with hash embeddings. The work must proceed through gated checkpoints. A later agent session should not start the next item until the current item has passing focused verification, updated docs, and a completed checklist entry in `verification-checklist.md`.

Implementation status as of 2026-05-21 23:33 CDT: completed. The indexer now excludes hidden/build/cache artifacts before chunking, counts embedding-input tokens with the active provider tokenizer, uses a 512-token embedding-input target capped by provider maximum, structurally splits long Tree-sitter-owned chunks instead of character-truncating real source, batches missing embedding inputs by measured token length, and publishes token/split/batch telemetry in progress, manifests, eval reports, and benchmark reports.

Sequencing:

1. Add Jina token telemetry.
2. Exclude generated, build, cache, and hidden artifact directories before chunking.
3. Add length-aware embedding batching.
4. Add truncation-loss eval targets before changing structural splitting.
5. Replace blind real-source truncation with token-aware Tree-sitter splitting.

### Item 1: Jina Token Telemetry

Required behaviors:

- Count tokens with the same Jina tokenizer used for embedding inputs.
- Report token percentile buckets, max tokens, oversized input count, reusable embedding input count, batch max tokens, and padding-waste indicators through diagnostics, benchmark output, or progress events.
- Keep embedding input text and retrieval behavior unchanged until the later structural-splitting item.

Completion checkpoint:

- Unit coverage proves token-stat aggregation, oversized classification, and report shape without requiring a model download.
- Integration or benchmark coverage proves the public report includes token telemetry for a fixture index.
- A local large-workspace observation records enough data to identify the files or chunk kinds creating the longest Jina inputs.
- Hash and Jina eval behavior is unchanged except for telemetry fields.

### Item 2: Generated And Hidden Artifact Exclusion

Required behaviors:

- Apply one shared ignore policy before Tree-sitter extraction, SCIP shard planning, exact search, graph writes, embeddings, evals, and benchmarks.
- Ignore generated, build, cache, vendor, local-runtime, and hidden dot-artifact directories by default, including `.next`, `.vercel`, `.nx`, `.turbo`, `.cache`, `.expo`, `dist`, `build`, `coverage`, `generated`, and `__generated__`.
- Preserve an explicit allowlist or configuration path for hidden directories that intentionally contain source-like inputs.
- Record skipped-path diagnostics with a stable reason so users can explain why a file was not indexed.

Completion checkpoint:

- Unit and integration coverage prove ignored artifact paths produce no chunks, no SCIP facts, no exact-search results, no graph nodes, and no embeddings.
- Coverage proves an allowlisted source-like hidden path can still be included intentionally.
- A large-workspace dry run or diagnostics pass shows artifact directories no longer dominate included file, chunk, or embedding counts.
- Existing source, graph, query, and eval gates remain green.

### Item 3: Length-aware Embedding Batching

Required behaviors:

- Group embedding inputs by token length or measured tokenizer length before provider inference.
- Preserve the same input strings, model, pooling, normalization, vector dimension, and chunk-to-vector assignment.
- Keep progress counters in original total units even when provider calls are reordered internally.

Completion checkpoint:

- Unit coverage proves batching groups similar lengths, preserves deterministic output assignment, and handles duplicate reusable inputs.
- Focused integration or benchmark coverage shows reduced padded-token cost, wall-clock time, or peak memory on a representative fixture or local benchmark.
- Jina eval results remain equivalent within normal floating-point and ranking tolerance.
- No source capture, chunk content, or ranking rule changes are made in this item.

### Item 4: Truncation-loss Eval Targets

Required behaviors:

- Add target eval cases where the relevant source evidence appears after the current blind character-truncation point.
- Add false-positive cases where generated or built artifacts contain similar text but raw source should win.
- Classify failures as discovery, chunking, embedding, query, or ranking so the next implementation pass knows whether the issue is source capture or retrieval.

Completion checkpoint:

- New evals fail against current behavior for the expected reason before structural splitting changes.
- Cases are committed as `target` or equivalent non-blocking quality gates until the implementation makes them consistently pass.
- Eval reports show the actual top results and failure class clearly enough to guide item 5.
- Existing required gates are not weakened or deleted.

### Item 5: Token-aware Tree-sitter Splitting For Oversized Source

Required behaviors:

- Replace blind character truncation for real source chunks with token-aware splitting under a documented embedding input budget.
- Split oversized functions, classes, route handlers, components, tests, and file-level fallback chunks under the 512-token target, preferring statement-like line boundaries before falling back to bounded long-line splits.
- Preserve parent context, symbol metadata, file range, source hash, and source/context provenance on every child chunk.
- Mark any last-resort fallback truncation explicitly in diagnostics and embedding telemetry.

Completion checkpoint:

- Unit and integration coverage prove oversized real source becomes multiple bounded chunks with stable ranges and no silent truncation.
- Eval targets from item 4 pass under Jina and continue to avoid generated-artifact false positives.
- Hash-backed required gates, Jina-backed semantic gates, and affected OSS/adversarial evals remain green or have documented target-only residuals.
- Benchmark output shows token counts, split counts, truncation fallback counts, embedding runtime, and peak memory so the runtime tradeoff is measurable.

## Workstream 14: Generation Publish Reliability And Interrupt Handling

Reference label: `workstream:generation-publish-reliability`

This workstream exists because the 0.4.0 `js-monorepo` proof run completed discovery, package SCIP, relationship graph construction, and all Jina embeddings, but failed the 30-minute acceptance gate during final Ladybug generation rebuild and publication before any manifest was published. The next implementation pass should treat a completed manifest as the only usable index boundary and make the final write/publish path observable, cancellable, and benchmarkable.

Implementation status as of 2026-05-22 09:25 CDT: implemented for local graph-store publish reliability, interrupt cleanup, focused graph-store benchmarking, bounded SCIP package shard planning, embedding progress counter clarity, and MCP stdio close lifecycle. A follow-up capsule root proof run is still required before claiming the original `js-monorepo` acceptance gate is closed.

Sequencing:

1. Add Ladybug generation rebuild progress.
2. Add interrupt and cancellation cleanup.
3. Add a large graph-store publish benchmark.
4. Remediate large SCIP shard OOMs.
5. Tune Jina tail-batch economics and clarify counters.
6. Add MCP stdio lifecycle regression coverage.

### Item 1: Ladybug Generation Rebuild Progress

Required behaviors:

- Emit durable progress events inside the generation write path for schema setup, node writes, edge writes, vector-index creation, database close or checkpoint, active-pointer publish, and root manifest copy.
- Report persisted node, edge, and chunk batch counts as confirmed write progress instead of using planned graph sizes as `nodesWritten` and `edgesWritten`.
- Preserve stdout purity for `--json`; live progress remains stderr, progress artifacts, and MCP `index_progress`.

Completion checkpoint:

- Unit or integration coverage proves the graph-store writer emits ordered rebuild substeps.
- A large graph-store benchmark can identify whether time is spent in node writes, edge writes, vector-index creation, close/checkpoint, or publish.
- A failed or interrupted rebuild leaves enough progress evidence to identify the last confirmed write substep.

### Item 2: Interrupt And Cancellation Cleanup

Required behaviors:

- Handle `SIGINT` and `SIGTERM` during `index` and `update` by writing a terminal interrupted, cancelled, or failed progress event before process exit when possible.
- Close any open Ladybug connection, release the index write lock, and prevent partial generations from being treated as active.
- Tombstone or clean partial generation directories deterministically enough that the next run and `status` can classify them as failed local state, not a usable index.

Completion checkpoint:

- CLI process coverage proves interrupting an active index writes terminal progress and releases `.index-write.lock`.
- Status/progress coverage proves a partial generation without a manifest is reported as unusable.
- The next index attempt can recover without manual lock cleanup.

### Item 3: Large Graph-Store Publish Benchmark

Required behaviors:

- Add a focused benchmark or integration harness that exercises Ladybug rebuild at roughly the 0.4.0 failed-run scale without waiting on Jina inference.
- The harness should approximate tens of thousands of nodes, hundreds of thousands of edges, and thousands of chunk vectors using deterministic hash or fixture vectors.
- Report graph-store timings separately from discovery, SCIP, relationship construction, and embedding inference.

Completion checkpoint:

- Benchmark output includes node-write, edge-write, vector-index, close/checkpoint, publish, total rebuild time, peak RSS, and failure classification.
- The benchmark is cheap enough to run before the next real capsule root attempt.
- Performance regressions in graph-store publication can be detected without reindexing `js-monorepo`.

### Item 4: Large SCIP Shard OOM Remediation

Required behaviors:

- Investigate package/site shards that still fail `scip-typescript` near the default 1 GB heap limit.
- Prefer finer shard planning by source root, tsconfig, package sub-area, or bounded file groups before raising the default heap.
- If a configurable heap override is added, keep the default bounded and surface the override in progress, health, and diagnostics.

Completion checkpoint:

- Focused tests prove SCIP shard planning can split a large package without losing cross-shard reference merging.
- Failed SCIP shards still produce clear warning diagnostics and Tree-sitter fallback.
- A follow-up capsule run shows fewer or classified SCIP OOM gaps without returning to one root-wide compiler process.

### Item 5: Jina Tail-Batch Economics And Counter Clarity

Required behaviors:

- Benchmark token-budget and batch-size choices for the slow 512-token tail batches instead of changing the embedding provider.
- Clarify progress fields so unique embedding inputs and chunk assignments are not confused.
- Add elapsed-time and estimated-remaining-time telemetry where it can be computed from durable batch progress.

Completion checkpoint:

- Progress distinguishes unique inputs embedded from chunk assignments embedded.
- Benchmark evidence supports any new default batch-size or token-budget choice.
- Jina eval results remain equivalent within existing ranking tolerance.

### Item 6: MCP Stdio Lifecycle Regression

Required behaviors:

- Add process-level coverage that an MCP client closing stdin or closing the SDK transport causes `code-intel mcp` to exit.
- Ensure query-engine reuse timers and Ladybug handles do not keep the server process alive after the transport closes.
- Keep MCP stdout protocol purity unchanged.

Completion checkpoint:

- MCP tests assert subprocess exit after `client.close()`.
- No idle MCP process remains after a query or progress-only session.
- Existing MCP query and progress tools remain green.

## Rollout Plan

1. Create and review feature docs.
2. Build CLI skeleton, health checks, and the first unit/process test harness.
3. Add schema and fixture tests.
4. Add workspace/package discovery.
5. Add SCIP ingestion.
6. Add Tree-sitter chunking.
7. Add LadybugDB graph writes, persistence tests, and graph queries.
8. Add LadybugDB native vector indexing.
9. Add MCP server with stdio process tests.
10. Add fixture end-to-end tests.
11. Add eval suite and proof-of-concept smoke queries.
12. Use locally in Codex sessions.
13. Promote to a dedicated local JS/TS code intelligence repository.

## MVP Implementation Status

The first MVP was originally implemented under `local-tools/code-intel/` and initialized as its own local git repository on `main`. It now lives at `/Users/jordy/Documents/GitHub/code-intel/`.

Current commit chain:

```text
c49ce7a chore: scaffold code intel tool
6594ea3 feat: add cli schema contracts
fd68ff1 feat: add health and status commands
997ee2b feat: index fixture graph
1e4a830 feat: wire graph queries into cli
0d71508 feat: ingest scip index facts
829be67 feat: add mcp stdio tools
ba8a299 test: add pty health coverage
bcf3612 feat: add fixture eval suite
361234d fix: improve graph query robustness
cca3b00 fix: rank exact symbol matches first
1a2fa3b test: exclude fixture repo tests
6e4e880 test: cover graph context queries
11e3e2c fix: validate graph edge integrity
1cbd75a fix: harden code intel review gaps
bcbfd87 feat: default to jina embeddings
d9acc74 feat: add incremental reindexing
a68a2fd chore: ignore macos metadata
96e06a9 feat: add eval packs
0f72f31 feat: enrich tree-sitter ast facts
8b7a83b feat: harden ast structural facts
2fed907 feat: harden scip graph fusion
2e0acb0 feat: add gated eval reporting
8a11925 feat: harden fusion resolution
74e4994 test: add graph eval target gates
ea7313b feat: harden graph traversal
bde7dc5 feat: harden semantic ranking
151e3cc feat: harden test linking
9c1406c feat: harden relationship graph
05d1bff test: add adversarial eval packs
8e43768 feat: harden adversarial eval gates
dd5b8e4 test: harden adversarial eval regressions
a2ace2d test: add cross-oss eval packs
06daf51 feat: improve cross-oss code intelligence
ca06be1 test: add holdout OSS eval packs
441b85f feat: harden holdout relationship generalization
2cbf29b feat: add path-level ranking
c23669b feat: add readiness diagnostics and benchmarks
578c331 feat: harden concurrency locking
fa4f87d docs: move code intelligence docs
03fc4ce docs: update standalone code-intel references
29fb731 docs: add standalone agent instructions
```

Remaining follow-up after code review:

- Decide whether model artifacts should be preseeded into `.code-intel/models` for extracted-repo usage.
- Keep adding eval cases as new app-flow patterns are discovered so ranking and graph traversal do not overfit to the current OSS portfolio.

Jina default migration status:

- `code-intel index` without `--embedding-provider` now creates a Jina-backed index.
- `code-intel eval --json` now reports the embedding provider, model, and dimension used for the fixture eval.
- Fast unit, integration, CLI, and MCP harnesses explicitly select `--embedding-provider hash` where deterministic local embeddings are the test target.
- `health` now warns when the existing index manifest uses hash embeddings, while query commands continue to infer the provider/model/dimension from the index manifest.

Incremental reindexing status:

- `code-intel update` now fingerprints current source files by bytes and compares against active generation facts.
- Config fingerprints include `package.json`, `tsconfig.json`, `tsconfig.base.json`, and `jsconfig.json` so project-level resolution changes invalidate stale generations.
- Unchanged file chunk facts and matching embeddings are reused, while added and changed files are rechunked and missing embeddings are generated. Structural facts and embedding vectors now persist in separate generation-local JSON files.
- Relationships are recomputed into a new Ladybug generation and then atomically published. The first implementation avoids in-place row deletion.
- Deleted files disappear from active query results because only current file facts contribute to the next generation.
- The manifest includes incremental counts for added, changed, deleted, unchanged, reused chunks, and embedded chunks.

Fusion and gated eval status:

- `facts/resolution.json` now persists generation-local resolved module and export facts with a dedicated resolved-facts schema version.
- Fusion uses TypeScript-compatible module resolution plus package export metadata for relative imports, path aliases, package names, default/named/namespace imports, re-exports, dynamic imports, and CommonJS cases where they are statically resolvable.
- SCIP remains the canonical symbol and reference source when compiler facts exist. AST detail is retained as evidence rather than discarded.
- Graph edges now include SCIP, AST, and module-resolution evidence metadata, confidence, owner file, ranges, containing chunk, specifiers, local/exported names, member paths, test context, and fallback reasons.
- Deterministic hybrid semantic ranking now consumes semantic vectors, lexical/path/name matches, exact symbols, graph relationships, references, calls, imports, exports, tests, and test/source pair signals.
- Ranking exposes intent, fusion source ranks, reasons, demotions, matched signals, and numeric score in CLI and MCP semantic results.
- Eval ranking summaries now include `MRR@10`, `Recall@K`, `nDCG@10`, expected found or missing counts, and false-positive counts.
- Hash-backed synthetic eval currently passes all required gates, including implementation-intent, test-intent, and graph-backed ranking cases. Hash-backed Rallly eval currently passes all required and target gates in the gated pack, including transitive route-to-mutation-to-database, private API test-to-implementation, and UI-to-dashboard app-flow expectations.

Test-linking status:

- `TESTS` edges are now an explicit layer output, not only ranking inference. Direct test imports, direct test calls, SCIP references, AST test-case facts, bounded indirect implementation paths, and exact colocated test/source fallback all contribute labeled test relationships.
- Test-linking evidence records owner file, concrete test case name and range, target symbol or file, confidence, evidence sources, traversal path, and fallback reason when fallback is used.
- Hash-backed synthetic eval now passes all required test-linking regression gates. Hash-backed Rallly eval now passes the target test-linking gates for private route tests, route-to-mutation coverage, route-to-database coverage, middleware/API tests, implementation-to-test lookup, test-to-implementation lookup, and false-positive guards.

Relationship graph status:

- Type, member, boundary, framework convention, API-client, config/env, and mutation-to-database relationship metadata is now explicit graph output rather than implicit ranking inference.
- SCIP-backed type references emit `EXTENDS`, `IMPLEMENTS`, and type-use `REFERENCES` edges. AST type-reference facts now add `tree-sitter-type-reference` evidence for type alias dependencies, generic constraints/defaults/instantiations, mapped and conditional types, type-only imports/re-exports, and namespace-qualified type members. Module-resolution-backed usage emits member-call, property-access, package-boundary, loader/action, route-handler, and mutation-to-database relationship evidence where static facts prove it.
- Runtime-only API client calls are represented as unresolved `Callsite` nodes with `api-client` evidence and `fallbackReason: runtime-api-target-unresolved`, so the graph marks unresolved dynamic behavior instead of guessing a route target.
- Hash-backed synthetic eval now passes 33 of 33 required gates. Hash-backed Rallly eval now passes 13 of 13 required gates plus 20 of 20 target gates, including the stricter createPoll-to-prisma member-chain gate with mutation-to-database evidence.

Adversarial and OSS generalization status:

- The `js-ts-adversarial` pack passes the current hash and Jina provider gate set with required 46/46, target 44/44, and scoreboard 5/5 after the CLI/MCP parity track. The pack covers syntax, dispatch, module, graph, ranking, MCP, CLI/MCP parity, test-linking, type-precision, and false-positive edge cases.
- The `oss-rallly-adversarial` pack passes its real-code target gates for both hash and Jina providers.
- Ghostfolio, OpenStatus, Hermes, Dub, Twenty, and Formbricks target and scoreboard gates are green in the recorded hash and Jina matrix.
- The path-level app-flow ranking pass closed the remaining Dub webhook/payment and Formbricks survey editor auth/response scoreboard misses without weakening earlier AST, SCIP, fusion, graph, or test-linking cases.

Diagnostics, benchmark, and concurrency status:

- Every index generation now writes `facts/diagnostics.json`, and CLI/eval surfaces can explain missing files or symbols through discovery, ignore, tsconfig, parse, AST, SCIP, graph, embedding, queryability, and ranking stages.
- The CLI now exposes `relationships <seed>` with edge-kind and direction filters, plus a full CLI reference documenting command groups, JSON contracts, human output behavior, and agent chains.
- `benchmark` copies eval corpora and records cold index, warm update, changed-file update, deleted-file update, query latency, optional MCP latency, memory, batching, graph counts, and Ladybug lock behavior.
- Query and MCP reads are serialized inside a `QueryEngine`, Ladybug opens are single-flight, and process locks are scoped to each concrete `.lbug` database path so readers can finish on old generations while updates publish new ones.
- Index/update progress is persisted under `<indexPath>/progress/current.json`, run events are appended under `<indexPath>/logs/index-<runId>.jsonl`, and both are exposed through CLI and MCP. Current progress keeps coarse phases but adds substeps, recent event querying, SCIP quality evidence, discovery summaries, richer failure details, and write-lock state. Watch mode and ETA remain deferred.
- The standalone repo move is complete, with feature docs under `docs/` and repo-local workflow rules in `AGENTS.md` plus `docs/agent-workflows/`.

Versioned local release status:

- `0.1.0` is the first standalone local release baseline after the product spec, CLI, MCP, AST, SCIP, graph, ranking, diagnostics, benchmark, and packaging-readiness tracks reached their current complete state.
- `package.json` is the version source of truth, and `code-intel --version` reads that package version.
- `npm run version:bump -- <patch|minor|major|x.y.z>` is the controlled local bump path and updates `package.json` plus `package-lock.json`.
- `npm run release:local` is the local release path. It runs tests, packs `.local-releases/v<version>/code-intel-<version>.tgz`, installs that exact tarball globally, verifies the installed CLI version, and writes a local manifest.
- npm publishing remains a separate future decision. Current availability is source install, `npm link`, or versioned local tarball install.

## Maintenance Rules

- Update `feature-design-notes.md` whenever stack decisions, schema shape, storage layout, or query semantics change.
- Update `verification-checklist.md` with commands and results for every implementation pass.
- Do not add hosted services without an explicit spec update.
- Do not expand beyond JS/TS without a new feature decision.
- Treat generated `.code-intel/` artifacts as local state, not child-repo changes.
