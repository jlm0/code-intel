# code-intel

Local-first JavaScript and TypeScript code intelligence for CLI workflows and MCP agents.

`code-intel` indexes a JS/TS workspace into a local graph and vector store, then exposes the result through a CLI and an MCP stdio server. It is built for agents and developers that need grounded answers about symbols, references, call paths, imports, tests, diagnostics, and bounded source context without sending a codebase to a hosted indexing service.

## What It Provides

- JS/TS workspace indexing with Tree-sitter syntax facts and SCIP compiler facts.
- A persistent local LadybugDB graph/vector index under `.code-intel/`.
- Hybrid semantic search using local Jina embeddings by default, with a deterministic hash provider for tests and offline checks.
- Symbol lookup, references, callers, callees, relationship browsing, path tracing, and bounded context reads.
- Diagnostics for missing files, missing symbols, discovery skips, parse recovery, graph writes, and queryability.
- MCP tools backed by the same query engine and schema contracts as the CLI.
- Eval packs and benchmarks for regression testing graph, ranking, MCP, CLI parity, and app-flow behavior.

No hosted embedding API or hosted code index is used during normal indexing.

## Status

This is an early standalone tool. The CLI and MCP surfaces are usable, but package publishing and release automation are still being hardened. Install from the repository or a local tarball until an npm package is published.

## Install From Source

```bash
git clone https://github.com/jlm0/code-intel.git
cd code-intel
npm install
npm run build
npm link
```

Confirm the binary is available:

```bash
code-intel health --json
```

You can also test the packaged shape without publishing:

```bash
npm pack
npm install -g ./code-intel-0.1.0.tgz
```

## Quick Start

Index a workspace:

```bash
code-intel index \
  --workspace /path/to/workspace \
  --index-path /path/to/workspace/.code-intel/index \
  --json
```

Run common queries:

```bash
code-intel semantic "wallet signer" --workspace /path/to/workspace --index-path /path/to/workspace/.code-intel/index --json
code-intel find-symbol SomeSymbol --workspace /path/to/workspace --index-path /path/to/workspace/.code-intel/index --json
code-intel relationships SomeSymbol --workspace /path/to/workspace --index-path /path/to/workspace/.code-intel/index --direction both --json
code-intel trace-path SourceSymbol TargetSymbol --workspace /path/to/workspace --index-path /path/to/workspace/.code-intel/index --json
code-intel get-context node-id-or-file --workspace /path/to/workspace --index-path /path/to/workspace/.code-intel/index --json
```

Incrementally refresh after edits:

```bash
code-intel update --workspace /path/to/workspace --index-path /path/to/workspace/.code-intel/index --json
```

If `--repo` is omitted, `index` uses `--workspace-manifest` when provided and otherwise indexes the workspace root. Generated folders, dependency folders, build output, logs, and local runtime folders are ignored by default.

## MCP Usage

Start the MCP server:

```bash
code-intel mcp --workspace /path/to/workspace --index-path /path/to/workspace/.code-intel/index
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "code-intel": {
      "command": "code-intel",
      "args": [
        "mcp",
        "--workspace",
        "/path/to/workspace",
        "--index-path",
        "/path/to/workspace/.code-intel/index"
      ]
    }
  }
}
```

The MCP server uses stdio. Logs go to stderr or files so stdout remains valid MCP JSON-RPC traffic. Tool outputs include structured content, schema metadata, evidence fields, ranking reasons, and bounded result limits.

## Command Surface

Core commands:

```text
code-intel index
code-intel update
code-intel status
code-intel health
code-intel search
code-intel semantic
code-intel find-symbol
code-intel references
code-intel callers
code-intel callees
code-intel relationships
code-intel trace-path
code-intel expand-context
code-intel get-context
code-intel diagnose file
code-intel diagnose symbol
code-intel eval
code-intel benchmark
code-intel mcp
```

Use `--json` for deterministic machine-readable output. Human-readable output is intended for TTY use, while non-TTY and JSON modes stay stable for agent and script consumption.

Run `code-intel --help` or `code-intel <command> --help` for command details.

## Embeddings

The default embedding provider is local Jina through Transformers.js:

```text
jinaai/jina-embeddings-v2-base-code
```

The model is downloaded into the configured index model cache on first use unless it is already cached. Use the deterministic hash provider for fast regression checks, offline diagnostics, or comparison runs:

```bash
code-intel index --workspace /path/to/workspace --embedding-provider hash --json
```

## Evals And Benchmarks

Run the fast synthetic regression suite:

```bash
npm run build
code-intel eval --suite js-ts-general --embedding-provider hash --json
```

Run the adversarial pack:

```bash
code-intel eval --eval-pack eval-packs/js-ts-adversarial --embedding-provider hash --json
```

Run a benchmark:

```bash
code-intel benchmark --suite js-ts-general --embedding-provider hash --skip-mcp-latency --json
```

Evals include blocking `required` gates plus non-blocking `target` and `scoreboard` gates for quality tracking.

## Development

```bash
npm run build
npm test
git diff --check
npm pack --dry-run
```

Internal planning and verification notes are not published with the public repository.
