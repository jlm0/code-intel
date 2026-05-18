# Code Intel

Local-first JavaScript and TypeScript code intelligence CLI with MCP access.

This package is intentionally standalone-shaped so it can be moved into a dedicated repository after the local proof of concept.

## Basic Usage

```bash
npm run build
node dist/cli/main.js index --workspace /path/to/workspace --repo /path/to/repo --index-path /path/to/.code-intel/index --json
node dist/cli/main.js update --workspace /path/to/workspace --repo /path/to/repo --index-path /path/to/.code-intel/index --json
node dist/cli/main.js find-symbol SomeSymbol --workspace /path/to/workspace --index-path /path/to/.code-intel/index --json
node dist/cli/main.js semantic "wallet signer" --index-path /path/to/.code-intel/index --filter-repo react-sdk --filter-package @getpara/react-sdk --json
node dist/cli/main.js diagnose file packages/core/src/tithe.ts --index-path /path/to/.code-intel/index --json
node dist/cli/main.js diagnose symbol SomeSymbol --index-path /path/to/.code-intel/index --json
node dist/cli/main.js eval --suite js-ts-general --json
node dist/cli/main.js benchmark --suite js-ts-general --embedding-provider hash --skip-mcp-latency --json
node dist/cli/main.js mcp --workspace /path/to/workspace --index-path /path/to/.code-intel/index
```

If `--repo` is omitted, `index` uses `--workspace-manifest` when provided and otherwise indexes the workspace root. Generated, build, log, dependency, and local-dev runtime folders are ignored by default; pass `--include-ignored` only when those paths should be indexed or searched.

`update` performs changed-file incremental reindexing. It fingerprints current files by bytes, reuses unchanged file chunk facts, structural AST facts, and cached embeddings, recomputes relationships into a fresh Ladybug generation, then atomically publishes that generation. Deleted files disappear because they do not contribute facts to the new generation.

The Tree-sitter layer exposes `extractSourceFileFacts()` for rich JS/TS structure and keeps `chunkSourceFile()` as the compatibility wrapper. File facts include imports, exports, declarations, calls, member access paths, ownership, tests, callbacks, stable ranges, source hashes, and containing chunk provenance. Import and export facts are also written as graph nodes with owning-file edges.

The fusion layer links Tree-sitter structural facts with SCIP compiler facts into resolved module and symbol evidence. It writes generation-local `facts/resolution.json`, resolves relative imports, path aliases, package exports, default/named/namespace imports, re-exports, dynamic imports, and CommonJS where statically knowable, and marks unresolved cases explicitly. Semantic search uses hybrid ranking over vector, symbol, path, file-kind, and graph-neighbor signals.

Each generation also writes `facts/diagnostics.json`. Diagnostics record file lifecycle status across discovery, ignore and tsconfig decisions, parsing, AST facts, SCIP facts, chunks, embeddings, graph writes, exact queryability, symbol queryability, and semantic ranking readiness. Use `diagnose file` when a file is missing from results, and `diagnose symbol` when a symbol query needs evidence about the indexed lifecycle behind it.

The default embedding provider is local Jina through Transformers.js with `jinaai/jina-embeddings-v2-base-code`. Use `--embedding-provider hash` only when you need the deterministic fast fallback for tests, offline diagnostics, or comparison runs:

```bash
node dist/cli/main.js index --workspace /path/to/workspace --repo /path/to/repo --index-path /path/to/.code-intel/index --embedding-provider hash --json
```

No hosted embedding API is used. The Jina model is downloaded into the configured index model cache on first use unless already cached.

## Eval Packs

`eval` runs pack-based quality checks. The default suite is `js-ts-general`, a committed synthetic corpus that stays small, deterministic, and fast enough for regression coverage:

```bash
node dist/cli/main.js eval --suite js-ts-general --json
node dist/cli/main.js eval --suite js-ts-general --embedding-provider hash --json
node dist/cli/main.js eval --suite js-ts-general --embedding-provider hash --diagnostics --json
```

The Rallly OSS app-flow pack is committed as metadata and cases only. It fetches the pinned external repository on demand into an eval cache:

```bash
node dist/cli/main.js eval --suite oss-rallly-app-flow --fetch --json
```

Use `--eval-cache-path /path/to/cache` to control where on-demand corpora are stored. Rallly is meant for real-world retrieval quality validation across frontend, API, package, database, middleware, and test paths; it is not a replacement for the synthetic regression gate.

Eval cases include gate metadata:

- `required` gates are blocking. Any required failure makes `status` and `blockingStatus` fail.
- `target` gates are non-blocking development targets for quality work.
- `scoreboard` gates are non-blocking trend metrics.

JSON reports include `qualityStatus` plus summaries by gate status, gate, capability, expected-rank coverage, and failure class. This lets the Rallly pack track app-flow and ranking gaps without hiding the current AST, SCIP, fusion, and graph regression signal.

`--diagnostics` adds a preflight section for every `expected` and `notExpected` file or symbol. It checks whether the file exists in the fetched or sparse corpus, was discovered, was indexed, was written to graph, has embedded chunks, and is exact, symbol, or semantic queryable. Misses are classified as fetch, sparse-checkout, discovery, ignore, tsconfig, parse, AST, SCIP, graph, embedding, query, or ranking where the evidence points.

## Benchmarks

`benchmark` copies an eval corpus into a temporary workspace and records cold index, warm update, one-file update, deleted-file update, query latency, optional MCP query latency, memory, node/edge/chunk counts, embedding batch size, graph write batch sizes, and Ladybug concurrent-read behavior:

```bash
node dist/cli/main.js benchmark --suite js-ts-general --embedding-provider hash --skip-mcp-latency --json
node dist/cli/main.js benchmark --suite oss-rallly-app-flow --fetch --eval-cache-path /tmp/code-intel-eval-cache --json
```

Use hash for fast repeatable mechanical benchmarking. Use Jina when measuring realistic local semantic indexing cost after the model cache is warm.

Recommended defaults before standalone extraction:

- Use `eval --diagnostics` on every required and target eval pack before trusting a green eval matrix.
- Use hash benchmarks for quick regression checks and Jina benchmarks for local semantic cost checks.
- Keep `--skip-mcp-latency` for focused index/update benchmarks, then run without it when validating MCP packaging.
- Treat `ladybugLock.concurrentRead: "fail"` as a scale signal to investigate before claiming concurrent-reader readiness.

## MCP Usage

The MCP server exposes the same query engine as the CLI over stdio. Tool responses include guidance with purpose, evidence fields, suggested next tools, and examples so agents can choose between exact search, semantic search, symbol lookup, references, graph expansion, path tracing, and context reads. Relationship and ranking metadata should be inspected before treating a result as strong evidence, especially `evidenceSources`, `confidence`, `fallbackReason`, `pathEdges`, and `metadata.ranking.reasons`.
