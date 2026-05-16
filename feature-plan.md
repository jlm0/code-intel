---
title: Code Intelligence Graph Feature Plan
feature: code-intelligence-graph
created: 2026-05-13
last_updated: 2026-05-15
status: active
---

# Code Intelligence Graph Feature Plan

## Objective

Create a local-first JS/TS code intelligence CLI with built-in MCP access. The work should start as local operator tooling under the `capsule-org` workspace, with Para repositories as the first proof-of-concept corpus. The product direction is general-purpose JS/TS repository intelligence, so the implementation should be shaped to move into its own dedicated repository if it proves useful.

The implementation must be production-shaped from the start: schema contracts, persistent local storage, deterministic indexing, query tests, health checks, and bounded MCP outputs.

## Implementation Location

Source:

```text
/Users/jordy/Documents/GitHub/capsule-org/local-tools/code-intel/
```

Generated artifacts:

```text
/Users/jordy/Documents/GitHub/capsule-org/.code-intel/
```

The tool should not be placed inside `docs-mintlify`, `js-monorepo`, or `user-management` because it is cross-repo local operator tooling. It is also not Para-specific product code; this local location is a proof-of-concept home before possible extraction into a standalone repository.

## Package Shape

Initial package structure:

```text
local-tools/code-intel/
  package.json
  tsconfig.json
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
    pty/
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
test:pty
test:e2e
eval
```

The minimum readiness gate before agent use is unit tests, fixture integration tests, CLI process tests, MCP stdio tests, fixture end-to-end tests, and first proof-of-concept smoke queries.

The P0 eval gate now uses two portable eval packs:

- Synthetic fixture pack: `local-tools/code-intel/eval-packs/js-ts-general`. This is committed with the tool and remains the deterministic, small, fast regression suite.
- Rallly OSS app-flow pack: `local-tools/code-intel/eval-packs/oss-rallly-app-flow`. This commits pack metadata and expected cases only; the source repository is fetched on demand into an eval cache and pinned to a commit.

The two packs serve different jobs. The synthetic pack proves mechanical correctness and protects edge cases we intentionally design. Rallly proves whether retrieval is useful on a real app across frontend, API, package, database, middleware, and test paths.

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
- Use `node-pty` only for TTY-specific tests.

Commands:

```text
code-intel status
code-intel health
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
- PTY-based tests cover only behavior that changes when stdout is a TTY.

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
- Use `scip-typescript index --infer-tsconfig` when indexing JS packages without TS config.
- Use workspace flags when appropriate for Yarn or pnpm workspaces.
- Preserve raw `.scip` files under `.code-intel/scip/`.

Exit criteria:

- Definitions, references, occurrences, ranges, role masks, and normalized read/test facts from SCIP become generation-local facts.
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
- Return structured JSON payloads in MCP content.
- Enforce query limits.
- Test MCP through stdio pipes or the SDK client transport, not through PTY.

Exit criteria:

- MCP Inspector or a local MCP-compatible client can list and call tools.
- `health`, `semantic_search`, `find_symbol`, `expand_context`, and `get_context` work through MCP.
- Tool descriptions are clear enough that an LLM can choose exact search, semantic search, or graph expansion appropriately.
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

Exit criteria:

- `code-intel eval` passes against fixtures.
- At least five real queries from the first proof-of-concept corpus return expected files or symbols.
- Failures are classified by layer and gate status, including discovery, chunking, SCIP, fusion, graph, embedding, query, ranking, and app-flow.
- CLI JSON reports include `blockingStatus`, `qualityStatus`, gate status totals, per-gate summaries, per-capability summaries, rank summaries, and failure-class summaries.

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
13. Decide whether to promote to a dedicated JS/TS code intelligence repository.

## MVP Implementation Status

The first MVP has been implemented under `local-tools/code-intel/` and initialized as its own local git repository on `main`.

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
```

Remaining follow-up after code review:

- Recheck `node-pty` on the target runtime because the installed binding cannot spawn even `/bin/echo` in this local environment.
- Decide whether model artifacts should be preseeded into `.code-intel/models` for extracted-repo usage.
- Keep adding eval cases as new app-flow patterns are discovered so ranking and graph traversal do not overfit to one Rallly flow.

Jina default migration status:

- `code-intel index` without `--embedding-provider` now creates a Jina-backed index.
- `code-intel eval --json` now reports the embedding provider, model, and dimension used for the fixture eval.
- Fast unit, integration, CLI, MCP, and PTY harnesses explicitly select `--embedding-provider hash` where deterministic local embeddings are the test target.
- `health` now warns when the existing index manifest uses hash embeddings, while query commands continue to infer the provider/model/dimension from the index manifest.

Incremental reindexing status:

- `code-intel update` now fingerprints current source files by bytes and compares against active generation facts.
- Unchanged file chunk facts and matching embeddings are reused, while added and changed files are rechunked and missing embeddings are generated. Structural facts and embedding vectors now persist in separate generation-local JSON files.
- Relationships are recomputed into a new Ladybug generation and then atomically published. The first implementation avoids in-place row deletion.
- Deleted files disappear from active query results because only current file facts contribute to the next generation.
- The manifest includes incremental counts for added, changed, deleted, unchanged, reused chunks, and embedded chunks.

Fusion and gated eval status:

- `facts/resolution.json` now persists generation-local resolved module and export facts with a dedicated resolved-facts schema version.
- Fusion uses TypeScript-compatible module resolution plus package export metadata for relative imports, path aliases, package names, default/named/namespace imports, re-exports, dynamic imports, and CommonJS cases where they are statically resolvable.
- SCIP remains the canonical symbol and reference source when compiler facts exist. AST detail is retained as evidence rather than discarded.
- Graph edges now include SCIP, AST, and module-resolution evidence metadata, confidence, owner file, ranges, containing chunk, specifiers, local/exported names, member paths, test context, and fallback reasons.
- Hybrid semantic ranking consumes graph, symbol, and path signals in addition to vector score.
- Hash-backed synthetic eval currently passes all required gates. Hash-backed Rallly eval currently passes all required and target gates in the gated pack, including transitive route-to-mutation-to-database app-flow expectations.

## Maintenance Rules

- Update `feature-design-notes.md` whenever stack decisions, schema shape, storage layout, or query semantics change.
- Update `verification-checklist.md` with commands and results for every implementation pass.
- Do not add hosted services without an explicit spec update.
- Do not expand beyond JS/TS without a new feature decision.
- Treat generated `.code-intel/` artifacts as local state, not child-repo changes.
