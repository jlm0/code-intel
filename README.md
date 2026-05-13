# Code Intel

Local-first JavaScript and TypeScript code intelligence CLI with MCP access.

This package is intentionally standalone-shaped so it can be moved into a dedicated repository after the local proof of concept.

## Basic Usage

```bash
npm run build
node dist/cli/main.js index --workspace /path/to/workspace --repo /path/to/repo --index-path /path/to/.code-intel/index --json
node dist/cli/main.js find-symbol SomeSymbol --workspace /path/to/workspace --index-path /path/to/.code-intel/index --json
node dist/cli/main.js semantic "wallet signer" --index-path /path/to/.code-intel/index --filter-repo react-sdk --filter-package @getpara/react-sdk --json
node dist/cli/main.js mcp --workspace /path/to/workspace --index-path /path/to/.code-intel/index
```

If `--repo` is omitted, `index` uses `--workspace-manifest` when provided and otherwise indexes the workspace root. Generated, build, log, dependency, and local-dev runtime folders are ignored by default; pass `--include-ignored` only when those paths should be indexed or searched.

The default embedding provider is `hash`, which is deterministic and fast for tests. Use `--embedding-provider jina` to run local Transformers.js embeddings with `jinaai/jina-embeddings-v2-base-code`:

```bash
node dist/cli/main.js index --workspace /path/to/workspace --repo /path/to/repo --index-path /path/to/.code-intel/index --embedding-provider jina --json
```

No hosted embedding API is used. The Jina model is downloaded into the configured index model cache on first use unless already cached.
