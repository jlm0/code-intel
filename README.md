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
node dist/cli/main.js eval --suite js-ts-general --json
node dist/cli/main.js mcp --workspace /path/to/workspace --index-path /path/to/.code-intel/index
```

If `--repo` is omitted, `index` uses `--workspace-manifest` when provided and otherwise indexes the workspace root. Generated, build, log, dependency, and local-dev runtime folders are ignored by default; pass `--include-ignored` only when those paths should be indexed or searched.

`update` performs changed-file incremental reindexing. It fingerprints current files by bytes, reuses unchanged file chunk facts and cached embeddings, recomputes relationships into a fresh Ladybug generation, then atomically publishes that generation. Deleted files disappear because they do not contribute facts to the new generation.

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
```

The Rallly OSS app-flow pack is committed as metadata and cases only. It fetches the pinned external repository on demand into an eval cache:

```bash
node dist/cli/main.js eval --suite oss-rallly-app-flow --fetch --json
```

Use `--eval-cache-path /path/to/cache` to control where on-demand corpora are stored. Rallly is meant for real-world retrieval quality validation across frontend, API, package, database, middleware, and test paths; it is not a replacement for the synthetic regression gate.
