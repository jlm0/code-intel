---
title: Code Intelligence Graph
feature: code-intelligence-graph
created: 2026-05-13
last_updated: 2026-05-15
status: active
---

# Code Intelligence Graph

This feature tracks a local-first JavaScript and TypeScript code intelligence tool for agent workflows.

The tool is intended to live in the local `capsule-org` orchestration workspace while it is being designed and tested, but the product direction is general-purpose JS/TS repository intelligence. Para repositories are the first proof-of-concept corpus, not the boundary of the tool. If the approach proves useful, the implementation should move from this local workspace into its own dedicated repository for maintenance and reuse across other work.

It should build a persistent local code graph, semantic search index, and MCP server so Codex and other LLM agents can ask structured questions about a target JavaScript or TypeScript repository instead of rediscovering relationships through repeated text search.

## Required Docs

- [Feature Spec](feature-spec.md)
- [Feature Plan](feature-plan.md)
- [Design Notes](feature-design-notes.md)
- [Verification Checklist](verification-checklist.md)
- [Testing Strategy](testing-strategy.md)
- [Future Improvements](future-improvements.md)

## Research

- [Local Stack Reference](research/01-local-stack-reference.md)
- [LadybugDB And LanceDB Comparison](research/02-ladybugdb-lancedb-comparison.md)

## Current Stack Decision

- Runtime and CLI: Node.js 20+ with TypeScript.
- CLI command framework: `commander`.
- Precise index: `@sourcegraph/scip-typescript`.
- Syntax facts and chunks: `tree-sitter`, `tree-sitter-typescript`, and `tree-sitter-javascript`.
- Graph and vector database: `@ladybugdb/core` with a persistent local `.lbug` database path.
- Embeddings: `@huggingface/transformers` using `jinaai/jina-embeddings-v2-base-code`.
- Exact search: `ripgrep` through `rg --json`.
- Agent interface: `@modelcontextprotocol/sdk` over stdio MCP.
- Testing: `vitest`, `execa` for pipe-based CLI and MCP process tests, and `node-pty` for TTY-only CLI behavior tests.

## Working Location

The intended local implementation location is:

```text
/Users/jordy/Documents/GitHub/capsule-org/local-tools/code-intel/
```

The intended generated artifact location is:

```text
/Users/jordy/Documents/GitHub/capsule-org/.code-intel/
```

## Current MVP

The first MVP now lives at:

```text
/Users/jordy/Documents/GitHub/capsule-org/local-tools/code-intel/
```

That folder has its own local git history on `main` so the implementation can be moved to a dedicated repository later with useful commit history intact.

Implemented surface:

- `code-intel` CLI with `index`, `update`, `status`, `health`, query commands, `eval`, and `mcp`.
- LadybugDB graph and native vector persistence under `.code-intel/code-intel.lbug`.
- SCIP raw artifact preservation, normalized occurrence facts, canonical symbol promotion, and evidence-backed relationship edges.
- Tree-sitter structural facts for TS, TSX, JS, JSX, partial syntax, static imports, dynamic imports, CommonJS imports and exports, re-exports, default exports, declarations, decorators, constructors, calls, member access, JSX component usage, ownership, tests, callbacks, and backward-compatible chunks.
- First-class Import and Export graph nodes, declaration-backed symbols for non-chunk declarations, owning-file edges, target-symbol fallback edges when SCIP does not emit a definition, and TypeScript-compatible module resolution for package exports, path aliases, re-exports, default/named/namespace imports, dynamic imports, and CommonJS where statically knowable.
- Generation-local structural facts in `facts/files.json`, normalized SCIP facts in `facts/scip.json`, resolved module/export facts in `facts/resolution.json`, and a separate `facts/embeddings.json` vector reuse cache.
- Hybrid semantic ranking that uses vector, symbol, path, file-kind, and graph-neighbor signals.
- MCP stdio tools backed by the same query engine as the CLI.
- Pack-based eval harness with a committed synthetic fixture pack and on-demand Rallly OSS app-flow pack, including gated `required`, `target`, and `scoreboard` reporting plus pinned AST fact cases for real Rallly files. Current hash-backed validation passes the synthetic required gates and the Rallly required plus target gates.
- First `js-monorepo/packages/react-sdk` smoke validation.
