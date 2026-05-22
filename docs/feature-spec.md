---
title: Code Intelligence Graph Feature Spec
feature: code-intelligence-graph
created: 2026-05-13
last_updated: 2026-05-21
status: active
---

# Code Intelligence Graph Feature Spec

## Purpose

Build a local-first JavaScript and TypeScript code intelligence CLI with a built-in MCP server. The tool should index one or more local JS/TS repositories, persist a code relationship graph, persist a semantic vector index, and expose structured query tools that LLM agents can consume.

The product direction is general-purpose JS/TS repository intelligence. The first proof-of-concept consumer was our local Codex workflow over Para repositories, and the tool now lives in its own local repository so it can be reused across other JS/TS workspaces.

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
- `tsconfig.base.json`
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
| Build output | TypeScript compiler to `dist/` | Keep the first package build simple and avoid bundling native database or parser bindings. |
| CLI command framework | `commander` | Subcommands, help output, async action handlers, strict option parsing, and a testable command factory. |
| Precise code index | `@sourcegraph/scip-typescript` | Compiler-aware JS/TS definitions, references, and symbol occurrence index. |
| Syntax parser | `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-javascript` | Syntax-aware chunks, fallback structure, function/class/component ranges, and robust parsing of partially broken code. |
| Graph and vector database | `@ladybugdb/core` | Embedded local property graph database with Cypher, on-disk persistence, full-text search, and native disk-based HNSW vector indexes. |
| Embeddings | `@huggingface/transformers` with `jinaai/jina-embeddings-v2-base-code` | Local code embeddings for natural-language-to-code retrieval. |
| Exact search | `ripgrep` via `rg --json` | Deterministic lexical search used by CLI commands and as a query-engine fallback. |
| Agent interface | `@modelcontextprotocol/sdk` | MCP stdio server exposing bounded structured code intelligence tools. |
| Schema validation | `zod` | Runtime validation for index records, MCP inputs, MCP outputs, and artifact versions. |
| Test runner | `vitest` | Unit, fixture, integration, schema, CLI, MCP, presenter, and eval tests. |
| Process test harness | `execa` plus Node `child_process` where lower-level control is needed | Spawn the CLI with stdio pipes, assert exit codes, stdout, stderr, timeouts, and MCP JSON-RPC behavior. |
| TTY rendering harness | `vitest` presenter tests | Validate current `isTTY` rendering branches without a native terminal harness. |

## Why These Tools

`scip-typescript` is the precise layer. It uses TypeScript project understanding to produce SCIP code navigation data. It should own definition, reference, and symbol occurrence facts.

Tree-sitter is the syntax layer. It should own chunk boundaries and structural extraction where exact compiler indexing is too narrow or unavailable.

LadybugDB through `@ladybugdb/core` is the graph and vector database. It gives a local embedded property graph with Cypher, strongly typed node and relationship tables, on-disk persistence, full-text search, and native disk-based HNSW vector indexes over node properties. SQLite is intentionally not part of the first stack because this feature is testing a graph database, not relational tables shaped like a graph. LanceDB is not selected for the first implementation because keeping graph and vector data in one local database is simpler and maps naturally to code chunks as graph nodes with embedding properties.

Jina code embeddings through Transformers.js provide local semantic retrieval without calling a hosted embedding API. The model can be cached locally after first download.

MCP is the agent interface. It is not the intelligence layer. It exposes the query engine to Codex, Claude Code, Cursor, or any other MCP-compatible agent.

Commander is the human CLI command framework. Command actions should be thin adapters that parse options and call the core library. The command tree should be created through a factory such as `createCliProgram()` so tests can exercise parsing without invoking process globals.

The package should emit compiled JavaScript with `tsc` and expose `code-intel` through the `package.json` `bin` field. Avoid bundling in the first implementation because LadybugDB and Tree-sitter may rely on native bindings or runtime file layout.

Package versioning is rooted in `package.json`. The CLI `--version` output must read the package version instead of duplicating a hardcoded value. Local releases are created through `npm run release:local`, which runs the regression gate, packs the current package into `.local-releases/v<version>/`, installs that exact tarball globally, verifies the installed CLI reports the same version, and writes a local release manifest. Future local versions are advanced through `npm run version:bump -- <patch|minor|major|x.y.z>`, which updates `package.json` and `package-lock.json` together. `.local-releases/` is local state and must not be committed.

Vitest is the primary test runner. Use Execa for normal CLI process tests because those tests need pipes, exit codes, stdout, stderr, and timeouts. Current TTY behavior is presenter-level formatting, so it is validated through unit tests by injecting `isTTY: true`. MCP stdio tests use the SDK client transport or JSON-RPC pipes.

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

Generated files should live under the selected workspace/index path, outside the indexed source packages unless explicitly configured otherwise:

```text
<workspace>/.code-intel/
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
        diagnostics.json
      code-intel.lbug/
  current.json
  models/
  cache/
  logs/
  eval/
```

The tool source now lives in its own local repository:

```text
/Users/jordy/Documents/GitHub/code-intel/
```

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

Tree-sitter file facts are generation-local and reusable by incremental indexing. Each file fact now carries chunks plus structured static imports, dynamic imports, CommonJS imports, exports, CommonJS exports, re-exports, declarations, decorators, constructor calls, function calls, member calls, JSX component usage, member accesses, type references, parent/child ownerships, test cases, callbacks, stable ranges, source hashes, owner file, and containing chunk provenance. Type references cover annotations, type aliases, generic constraints, generic defaults, type arguments, mapped types, conditional types, indexed access, `keyof`, `typeof`, and namespace-qualified type members. Structural facts are persisted in `facts/files.json` with their own facts schema version. Chunk vectors are persisted separately in `facts/embeddings.json` so the structural fact cache stays readable and does not grow around embedded vector arrays.

Embedding input preparation is part of the source-fact quality contract, not a lossy post-processing shortcut. The indexer must be able to report Jina-token counts for chunk embedding inputs before inference, including max tokens, percentile buckets, oversized input counts, and truncation or split status. Real source chunks must not be silently character-truncated for embedding. The default source embedding input target is 512 provider-tokenizer tokens, capped by the embedding provider's model maximum, so long real source is split for retrieval quality before it approaches model truncation. If a syntax unit is too large for the configured embedding budget, Tree-sitter-owned structural splitting must create smaller addressable child chunks while preserving repo, file, range, language, chunk kind, parent symbol, source hash, and source/context provenance. Last-resort truncation is allowed only for explicitly classified fallback inputs such as unparseable, minified, or otherwise non-structural content, and diagnostics must mark it as truncation rather than normal chunking.

This contract is tracked by reference label `workstream:jina-tree-sitter-embedding-input-hardening`.

SCIP facts are also generation-local. Normalized compiler facts are persisted in `facts/scip.json` with `factsSchemaVersion: code-intel.scip-facts.v1`. The raw SCIP role mask is preserved, unmarked references from `scip-typescript` are normalized as read references, and import/test role evidence is derived during AST/SCIP fusion when the syntax facts provide the missing source context. SCIP execution is planned from code-intel discovery into repo-relative project shards rather than a single root-wide TypeScript project. Each shard runs as its own `scip-typescript` child process with the repo root as `cwd`, a bounded default heap no larger than 1 GB, disabled global caches, and a raw output path keyed by repo and shard identity. Package shards cover package source; repo-level shards cover discovered source files outside workspace packages such as root tests or scripts. Inferred shard configs live under the index scratch area, extend the repo root TypeScript or JavaScript config when present, and apply the same generated/vendor directory exclusions as code-intel discovery so SCIP output cannot reintroduce ignored `.next`, `generated`, or `__generated__` documents. Shard ingestion is two-pass: definitions from all shard outputs build a repo-level symbol catalog first, then references from every shard are replayed against that catalog so cross-shard package references retain compiler evidence. SCIP-backed definitions promote matching Tree-sitter declaration nodes into canonical symbols instead of duplicating a second AST and SCIP symbol for the same definition. SCIP-backed `REFERENCES`, `CALLS`, `IMPORTS`, `EXPORTS`, `TESTS`, and `MENTIONS` edges carry relationship evidence metadata. Tree-sitter name matching is now a labeled fallback path when SCIP fails, when SCIP output is tiny or empty, or when SCIP succeeds but omits a target definition.

Resolved module facts are generation-local. The fusion layer persists `facts/resolution.json` with `factsSchemaVersion: code-intel.resolved-facts.v1`. These facts record resolved modules, package export entries, import bindings, export bindings, CommonJS bindings, dynamic import status, target files, target packages, target symbols where known, unresolved status, and fallback reasons. TypeScript-compatible module resolution owns relative paths, `tsconfig`, `tsconfig.base`, or `jsconfig` path aliases, package names, package `exports` and `imports` maps, multi-hop re-exports, default imports, named imports, namespace imports, dynamic imports, and CommonJS cases where they are statically resolvable.

Diagnostics are generation-local. The indexer persists `facts/diagnostics.json` with `diagnosticsSchemaVersion: code-intel.diagnostics.v1`. Diagnostics record every discovered source candidate and skipped path the discovery layer can explain, including source inclusion, ignored directories, unsupported files, tsconfig exclusions, parse recovery, AST fact counts, SCIP occurrence counts, chunk counts, embedding counts, graph node and edge counts, exact queryability, symbol queryability, and semantic ranking readiness. CLI, eval, and MCP-facing workflows should use these diagnostics to distinguish missing corpus coverage from downstream AST, SCIP, fusion, graph, embedding, query, or ranking failures.

The graph writes first-class `Import` and `Export` nodes with owning-file edges. It also creates declaration-backed symbol nodes for non-chunk AST declarations so exported variables, database clients, middleware values, and route aliases can be graph targets. SCIP fusion owns canonical symbol identity and references when compiler facts exist. AST facts preserve syntax detail, ranges, source text hashes, import/export specifiers, member paths, containing chunks, and test context. Fusion combines both evidence sources into `IMPORTS`, `EXPORTS`, `REFERENCES`, `CALLS`, `TESTS`, and `MENTIONS` edges with confidence, owner file, containing chunk, SCIP evidence, AST evidence, module resolution evidence, local/exported names, member path, and fallback reason. Unresolved and dynamic cases are marked explicitly instead of guessed.

Graph edge meanings must stay consistent:

- `IMPORTS` means a file or import node imports a resolved file, package, or symbol.
- `EXPORTS` means a file, export node, or package exposes a resolved file or symbol.
- `REFERENCES` means source code refers to a target symbol, file, layout, or module target with evidence metadata.
- `CALLS` means observed call evidence exists from SCIP or AST call facts. An import alone must not create `CALLS`.
- `TESTS` means a test file or test chunk references, imports, or calls an implementation target with test-context evidence.
- `MENTIONS` means weaker local mention evidence and should rank below compiler, resolver, import, export, call, and test evidence.

Relationship metadata is now part of the graph contract. Compiler-backed type references emit `EXTENDS`, `IMPLEMENTS`, and type-use `REFERENCES` edges when SCIP proves the symbol target. AST type-reference facts also emit `REFERENCES` edges with `tree-sitter-type-reference` and `type-use` evidence for concrete type-position dependencies, including type alias dependencies, generic constraints/defaults/instantiations, mapped and conditional types, type-only imports and re-exports, and merged namespace/member type ownership. TypeScript module-resolution-backed calls and imports add relationship tags for package boundaries, type imports, member calls, property access, loader/action conventions, route handlers, and mutation-to-database usage where the static evidence supports the claim. AST-only convention relationships are allowed only when the syntax fact is concrete, such as `process.env.NAME`, `fetch(...)`, `app.post(...)`, or a loader/action declaration name. Runtime-only or unresolved cases must be represented as explicit unresolved callsite or module facts with `fallbackReason` rather than guessed target edges.

Relationship edges and callsite nodes should preserve owner file, range, containing chunk, target symbol identity when known, evidence sources, confidence, relationship tags, and fallback reason. Evidence strength is ordered as SCIP/compiler and TypeScript module resolution first, AST structural facts second, and labeled framework or API-client convention fallback last.

Graph traversal must be typed and evidence-aware. Traversal APIs should accept allowed edge kinds, direction, max depth, evidence requirements, confidence and fallback rules, and return ordered path nodes with edge metadata. Path output should include edge kind, owner file, range, evidence sources, confidence, traversal direction, and fallback reason. Package nodes must not become accidental app-flow bridges unless package traversal is explicitly relevant.

## Indexing Pipeline

The indexer should run as a deterministic local batch process:

1. Discover repos from a workspace manifest or CLI arguments.
2. Detect package manager, package workspaces including recursive workspace globs, `package.json` names, exports, dependencies, and source roots.
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

Discovery ignore policy applies before every downstream indexing surface: Tree-sitter facts, SCIP shard planning, exact search, graph writes, embedding input generation, diagnostics, evals, and benchmarks. Generated, vendor, build, cache, local-runtime, and hidden dot-artifact directories should be excluded by default. Hidden directories that intentionally contain source-like project inputs must be included only through a documented built-in allowlist or explicit user configuration so artifact folders such as `.next`, `.vercel`, `.nx`, `.turbo`, `.cache`, and `.expo` cannot dominate chunks or embeddings by accident.

Embedding batches must be grouped by token length or an equivalent measured length bucket so one long input does not force many short inputs to pay the same padded-sequence inference cost. Length-aware batching must preserve the same input text, provider, normalization, embedding dimension, chunk-to-vector mapping, and deterministic output contracts; it is a runtime and memory optimization, not a retrieval-quality tradeoff.

`code-intel update` should preserve the same correctness as a clean `index` while avoiding repeated work where it is provably safe. The current P0 update model fingerprints source file bytes, reuses unchanged file chunk facts and matching embeddings, rechunks added and changed files, reruns SCIP at discovered project or package shard level, recomputes relationships from the current fact set, writes a fresh Ladybug generation, then publishes that generation atomically. Deleted files are removed by omission from the next generation rather than physical in-place row deletion.

The active generation manifest is the metadata authority for query, health, status, CLI, and MCP paths. The root manifest remains a convenience copy, not the only source readers should trust.

Index and update progress is persisted separately from the active generation under `<indexPath>/progress/current.json`. The progress artifact records `runId`, `operation`, `status`, `phase`, timestamps, `pid`, message, counters, optional `currentRepo`, optional `currentStep`, optional `startedStepAt`, optional error details, warnings, and optional stale reason. `running` progress never means the new generation is active. `succeeded` is written only after the new generation artifacts are written and the active pointer has been published. Readers derive `stale` at read time from a dead writer process, or from a stale phase-level heartbeat when no current step is active. A live writer PID inside a current step remains `running` so synchronous CPU-bound graph work is not falsely marked stale.

Progress phases stay intentionally coarse: `starting`, `discovering`, `planning`, `facts`, `scip`, `embeddings`, `graph`, `publishing`, `succeeded`, and `failed`. Fine-grained hang isolation is carried by `currentStep` and append-only events instead of expanding the phase enum. Required substeps include SCIP run/ingest/quality, module resolution, resolved-module graph application, framework graph application, relationship graph application, test-linking graph application, and final call evidence promotion. Synchronous graph hot blocks must write a durable `step_started` event before entering the block.

Every run appends machine-readable events to `<indexPath>/logs/index-<runId>.jsonl`. Events include event type, phase, repo, step, message, timestamps, duration where known, counters, memory RSS and heap usage, bounded error details, discovery summaries, and SCIP quality reports. Step events include `step_started`, `step_progress`, `step_succeeded`, and `step_failed` so long synchronous or future chunked work can leave durable heartbeat evidence. `progress --events` and MCP `index_progress` with `includeEvents` expose bounded recent events. `progress` and `status` also expose `.index-write.lock/owner.json` state so callers can distinguish active work, waiting on a write lock, stale locks, and unlocked state.

SCIP progress must record output bytes, duration, exit code, bounded stdout/stderr summaries, and definition/reference/occurrence counts. A failed SCIP child process must not emit `step_succeeded`; it records warning evidence and falls back to Tree-sitter relationships. `ok: true` with tiny or empty output becomes an explicit `scip-empty-or-tiny` warning and also uses Tree-sitter fallback. Discovery progress must record repo/package summaries, included file counts, tsconfig-excluded file counts, ignored directory counts, unsupported file counts, and included files outside discovered package/source roots. CLI `index` and `update` may emit plain progress lines to stderr for humans, but stdout remains reserved for the final deterministic result. `--quiet` suppresses live progress output.

Embedding progress and diagnostics must report enough token and batch information to explain Jina runtime. Required counters include chunks visited, chunks embedded, reusable embedding inputs, batches completed, current batch size, current batch max tokens, token percentile summaries, oversized source-unit count, structural split count, truncation fallback count, and elapsed inference time where available. A live embedding phase must continue emitting batch or heartbeat evidence so status consumers can distinguish active ONNX inference from a stale or dead writer.

## Concurrency Contract

Reader concurrency is intentionally bounded, not free-form parallel access to the same embedded database handle. CLI and MCP query paths should serialize operations inside a `QueryEngine` instance, reuse one active generation snapshot for that engine, and close the Ladybug handle after queued reads complete. This prevents same-process readers from self-contending on a native Ladybug lock while keeping output deterministic.

The process-level Ladybug lock is scoped to the concrete `.lbug` database path, not the whole index root. A reader on the previously active generation can keep serving that immutable generation while `code-intel update` builds a new generation under a different path. Publishing is still done by atomically replacing the active pointer after the new generation is written and validated. A query engine created before publish may keep reading its old generation until closed; a new query engine must resolve the newly active generation.

Lock failures should be explicit and classified. The benchmark report records concurrent read status, reader-during-update status, reader-after-publish status, retry counts, queue wait time, process-lock wait time, and failure classification so standalone-readiness failures can be traced to Ladybug connection limits, graph-store lifecycle, active-generation pointer handling, MCP reuse, test harness behavior, or unknown causes.

## Query Model

The query engine should support exact, semantic, and relationship retrieval.

Required CLI commands:

```text
code-intel index
code-intel update
code-intel progress
code-intel status
code-intel health
code-intel search <pattern>
code-intel semantic <query>
code-intel find-symbol <name>
code-intel references <symbol-id-or-name>
code-intel relationships <seed>
code-intel callers <symbol-id-or-name>
code-intel callees <symbol-id-or-name>
code-intel expand-context <node-id>
code-intel get-context <node-id>
code-intel diagnose file <path>
code-intel diagnose symbol <name>
code-intel eval
code-intel benchmark
code-intel mcp
```

## Eval Pack Model

The eval harness is pack based. A pack defines corpus metadata, corpus source, and JSON case files. Eval cases carry gate metadata so quality progress is measured by capability instead of one repo-specific pass/fail label.

Gate statuses:

- `required`: blocking regression gate. Any required failure makes report `status` and `blockingStatus` fail.
- `target`: non-blocking development target. Failures remain visible in `qualityStatus`, gate summaries, ranks, and failure classes.
- `scoreboard`: non-blocking quality metric for trend tracking and broader comparison.

Gate metadata records `id`, `status`, `capability`, and `layer`. Capabilities are general JS/TS patterns such as route-to-mutation, mutation-to-database, middleware-to-route, UI-to-data/API, test-to-implementation, package-boundary imports, re-export/canonical symbol resolution, MCP agent readiness, CLI/MCP parity, and false-positive guards. Layers map to the current architecture: AST, SCIP, fusion, graph, ranking, MCP, CLI/MCP parity, and app-flow.

Eval reports include suite identity, corpus source, embedding metadata, index stats, top-level `blockingStatus`, `qualityStatus`, per-case latency, expected result ranks, false-positive checks, failure class, and summary aggregates by gate status, gate, capability, rank, and failure class. Ranking reports also include `MRR@10`, `Recall@K`, `nDCG@10`, expected total, expected found or missing counts, and false-positive counts so ranking quality can be compared across implementation passes. Packs can include query, AST, graph, MCP, and CLI/MCP parity cases; parity cases launch the built CLI and an SDK MCP client against the same indexed corpus and compare stable IDs, files, symbols, ranking reasons, relationship evidence, path edges, diagnostics, limits, and bounded context.

The test-linking layer turns AST test facts, SCIP references, fusion facts, and graph traversal into explicit `TESTS` relationships. A valid test link records the owner file, concrete test case name and range when known, target symbol or file, confidence, evidence sources, traversal path for indirect links, and fallback reason for naming-based links. Direct compiler and AST evidence must outrank colocated naming fallback, and broad package, folder, or word overlap must not create `TESTS` edges on its own.

Built-in regression and quality packs:

- `js-ts-general`: committed synthetic JS/TS corpus under `eval-packs/js-ts-general`. This is the deterministic regression pack. It covers exported symbols, re-exports, path alias references, React hooks, class methods, caller relationships, test relationships, semantic concept retrieval, implementation-intent ranking, test-intent ranking, graph-backed semantic ranking, and duplicate-method false-positive guards.
- `oss-rallly-app-flow`: committed metadata, query case files, and AST fact case files under `eval-packs/oss-rallly-app-flow`. The Rallly source is not vendored. The CLI fetches the pinned external repository on demand into an eval cache when `--fetch` is provided. This pack is the real-world app-flow pack for frontend, API, package, database, middleware, and test retrieval quality.
- `js-ts-adversarial` and `oss-rallly-adversarial`: adversarial packs under `eval-packs/` that pin syntax, module, graph, test-linking, ranking, MCP agent-readiness, CLI/MCP parity, type-precision, and false-positive edge cases. They are invoked with `--eval-pack` so they can remain independent of the default suite list.
- `oss-ghostfolio-app-flow`, `oss-openstatus-app-flow`, and `oss-hermes-agent-ui`: on-demand OSS generalization packs for Angular/Nest, Hono/Next, and React/Ink/gateway-client repository shapes.
- `oss-dub-app-flow`, `oss-twenty-crm-flow`, and `oss-formbricks-survey-flow`: on-demand holdout packs added after earlier hardening to validate generalization across Next.js API flows, Nest GraphQL services, server actions, package utilities, and test-linking patterns.

Useful commands:

```text
code-intel eval --suite js-ts-general --json
code-intel eval --suite js-ts-general --embedding-provider hash --json
code-intel eval --suite oss-rallly-app-flow --fetch --json
code-intel eval --suite oss-rallly-app-flow --eval-cache-path /tmp/code-intel-rallly-eval-cache --embedding-provider hash --json
code-intel eval --suite oss-dub-app-flow --fetch --json
code-intel eval --eval-pack eval-packs/js-ts-adversarial --embedding-provider hash --json
```

The synthetic pack is the hard regression gate. Its cases are `required` so regressions block the report. The `js-ts-adversarial` pack also has required type-precision gates for type alias dependencies, generic constraints/defaults/instantiations, mapped and conditional type references, type-only re-exports, enum member precision, merged namespace members, recursive/self-reference false-positive guards, a required MCP agent-readiness workflow gate, and a required CLI/MCP parity workflow gate. Rallly mixes `required` gates for focused AST, SCIP, fusion, and graph relationship correctness with `target` gates for ranking, graph traversal, and full app-flow usefulness. The other OSS and adversarial packs mostly use `target` and `scoreboard` gates so generalization work stays visible without silently expanding the blocking regression floor. Target and scoreboard failures can fail `qualityStatus`, but they do not fail `blockingStatus` unless the case is intentionally promoted to `required`.

CLI behavior requirements:

- Global options should include `--workspace <path>`, `--repo <path...>`, `--index-path <path>`, `--json`, `--quiet`, and `--verbose` where they apply.
- Human commands may render friendly text when stdout is a TTY.
- Machine-readable commands should support stable JSON through `--json`.
- Non-TTY output must be deterministic and free of spinners, progress animation, and terminal control codes.
- Live indexing progress must use stderr only. JSON stdout for `index`, `update`, `progress`, and `status` must remain parseable.
- Command handlers must return explicit result objects to the presenter layer before writing output.
- `relationships <seed>` is the CLI graph relationship browser. It accepts optional `--edge-kind <kind...>`, optional `--direction outgoing|incoming|either`, and bounded `--limit`; it uses the same query-engine method and result contract as MCP `get_relationships`.
- TTY query output should summarize query, result count, symbol or file locations, matched signals, relationship evidence, and ranking evidence without changing the JSON contract.

Required MCP tools:

- `workspace_overview`
- `health`
- `index_progress`
- `search_text`
- `semantic_search`
- `find_symbol`
- `get_symbol`
- `get_references`
- `get_callers`
- `get_callees`
- `get_relationships`
- `expand_context`
- `get_context`
- `trace_path`
- `diagnose_file`
- `diagnose_symbol`

Semantic search should return ranked pointers, not large source dumps. The default ranking path is deterministic hybrid retrieval: overfetch semantic vector candidates, add lexical/path/name candidates, exact symbol candidates, graph relationship candidates, reference/call/import/export/test candidates, and test-to-implementation paired candidates, then fuse ranks with code-aware boosts and demotions. Query intent is classified as implementation, caller, callee, test, app-flow, or broad semantic. Ranking should boost exact symbols, SCIP/fusion/module-resolution evidence, high-confidence graph edges, app-flow paths, source or test file-kind matches, and paired test/source evidence. Ranking should demote weak mention-only candidates, fallback-only evidence, generated or vendor paths, import/export wrappers, tests for non-test intents, source files for unpaired test intents, and duplicate file/chunk noise. CLI and MCP semantic results expose `matchedSignals`, numeric score, and `metadata.ranking` with intent, fusion source ranks, reasons, and demotions. Optional local model reranking, such as a Jina reranker, is a later extension point after deterministic ranking and candidate recall are strong. Context expansion should walk graph relationships. Source text should be returned only by `get_context` or a bounded `expand_context` call.

## MCP Response Contract

MCP tools must advertise `outputSchema` and return the same schema-validated payload in `structuredContent` and text `content` for compatibility with both structured MCP clients and text-only clients. The payload wrapper contains `schemaVersion`, `tool`, optional guidance metadata, and the tool result. Query tools use the same `QueryResultSchema` returned by CLI/query-engine paths; diagnostics tools use the same diagnostics result contracts as `diagnose file` and `diagnose symbol`.

`get_relationships` is the general relationship-browser MCP tool. It accepts a seed stable ID, symbol name, or qualified name, optional `allowedEdgeKinds`, optional direction, and bounded limit. Returned items include `metadata.relationship` with edge kind, traversal direction, evidence sources, confidence, owner file, range, fallback reason, and other edge metadata when available. Dedicated tools such as `get_references`, `get_callers`, and `get_callees` remain narrower shortcuts over the same graph evidence.

`code-intel mcp` must start an MCP server with `StdioServerTransport`. The MCP client launches the command as a subprocess with stdin, stdout, and stderr pipes. MCP stdout is reserved for newline-delimited JSON-RPC messages. Logs go to stderr or files only.

MCP tests should use the MCP TypeScript SDK client transport or a small JSON-RPC harness over stdio pipes, matching how real MCP clients communicate with the server.

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
      "metadata": {
        "ranking": {
          "intent": "implementation",
          "finalScore": 0.87,
          "sourceRanks": { "semantic": 2, "symbol": 1, "graph": 3 },
          "reasons": [
            { "signal": "symbol_exact", "weight": 18, "detail": "exact symbol token match" },
            { "signal": "graph_calls", "weight": 8, "detail": "CALLS edge evidence" }
          ],
          "demotions": []
        }
      },
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
- Default ignore list for `node_modules`, `.git`, hidden dot-artifact directories, `dist`, `build`, `.next`, `coverage`, generated SDK outputs, caches, and local-dev runtime state.
- MCP tools must not expose arbitrary shell execution.
- MCP tools must enforce result limits, depth limits, and token budgets.
- Stdio MCP server must log to stderr or files, not stdout.

## Validation Model

The feature must be validated by layer before it is used as trusted agent context. `testing-strategy.md` defines the detailed test matrix.

Minimum validation layers:

- Unit tests for stable IDs, schemas, command parsing, output presenters, ignore rules, and query result shaping.
- Fixture integration tests for workspace discovery, SCIP ingestion, Tree-sitter chunking, LadybugDB schema setup, graph writes, vector writes, exact search parsing, and model-cache status.
- Fixture integration tests for generated and hidden artifact exclusion before Tree-sitter, SCIP, exact search, graph writes, and embeddings.
- Fixture and eval tests for Jina-token telemetry, length-aware embedding batching, token-aware structural splitting, and retrieval where relevant source appears after the old character-truncation point.
- Database persistence tests that write a temp `.lbug`, close it, reopen it, and verify graph, full-text, and vector queries still work.
- CLI process tests that run the built `code-intel` binary through stdio pipes.
- Presenter tests that cover TTY rendering branches without native terminal allocation.
- MCP stdio tests through the SDK client transport or JSON-RPC pipes.
- End-to-end fixture tests that index, query through CLI, query through MCP, restart the process, and confirm stable IDs and results remain consistent.
- Proof-of-concept smoke queries against selected local JS/TS packages after fixture correctness passes.

## Current MVP Behavior

The first implementation is a working local MVP under `/Users/jordy/Documents/GitHub/code-intel/` with its own git history. It provides the CLI, MCP stdio server, fixture indexer, LadybugDB graph persistence, LadybugDB vector index, SCIP artifact preservation and ingestion, Tree-sitter structural fact extraction, TypeScript-compatible fusion resolution, exact search, hybrid semantic search, relationship browsing, diagnostics, context expansion, and eval suite.

The MVP now uses `jinaai/jina-embeddings-v2-base-code` through Transformers.js as the default semantic provider. Chunk embeddings are generated locally, stored as 768-dimension vectors on Ladybug `CodeNode` chunk records, and queried through the same manifest metadata from CLI and MCP paths. The deterministic `local-hash-v1` provider remains available only as an explicit `--embedding-provider hash` fallback for fast tests, offline diagnostics, and comparison runs.

Health now reports both the configured embedding provider and the existing index embedding provider. A hash-backed index is treated as a warning with a rebuild message, and a forced Jina query against a hash index fails with an embedding provider mismatch rather than silently mixing vector spaces.

LadybugDB is the live graph and vector store. A short database-open retry remains for native Ladybug lock handoff, and the query path now uses bounded in-process serialization plus database-path-scoped process locks. MCP can reuse a query engine briefly across nearby tool calls, but close waits for queued operations before releasing the handle. Updates write a fresh generation under a different Ladybug path, so active readers on an older generation do not block the rebuild.

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
- Preserve or improve Jina-backed semantic retrieval while reducing generated-artifact noise, eliminating silent real-source embedding truncation, and making embedding runtime measurable by token and batch.
- Improve local agent discovery compared with repeated `rg` searches for at least five real debugging or orientation queries from the first proof-of-concept corpus.
