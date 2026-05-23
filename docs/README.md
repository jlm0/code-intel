---
title: Code Intelligence Graph
feature: code-intelligence-graph
created: 2026-05-13
last_updated: 2026-05-22
status: active
---

# Code Intelligence Graph

This feature tracks a local-first JavaScript and TypeScript code intelligence tool for agent workflows.

The tool started in the local `capsule-org` orchestration workspace, but the product direction is general-purpose JS/TS repository intelligence. Para repositories were the first proof-of-concept corpus, not the boundary of the tool. The implementation now lives as its own local repository so it can be maintained and reused across other work.

It should build a persistent local code graph, semantic search index, and MCP server so Codex and other LLM agents can ask structured questions about a target JavaScript or TypeScript repository instead of rediscovering relationships through repeated text search.

## Active Workflow State

Active requirements, implementation plans, validation evidence, and material history live in workstream folders under `.agent-workstream/` when a workstream is created. Use the global workstream creation skills to define workstreams and `$workstream-execution` to implement existing workstreams.

Agent workflow rules live in [Agent Workflows](agent-workflows/README.md), including the [Workstream Documentation Reference](agent-workflows/workstream-documentation.md).

## Product And Strategy References

- [Testing Strategy](testing-strategy.md)
- [Adversarial Evals (Codex handoff)](adversarial-evals.md)
- [CLI Reference](cli-reference.md)
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
- Testing: `vitest`, `execa` for pipe-based CLI process tests, MCP SDK stdio tests, and presenter/unit coverage for TTY rendering branches.

## Repository

Public repository:

```text
https://github.com/jlm0/code-intel
```

Current local development path:

```text
/Users/jordy/Documents/GitHub/code-intel/
```

Default generated artifact location is workspace-relative unless `--index-path` is provided:

```text
<workspace>/.code-intel/
```

## Current MVP

The first MVP now lives in the standalone repository:

```text
https://github.com/jlm0/code-intel
```

The repository has its own git history on `main` and now uses `.agent-workstream/` for active workflow state.

Implemented surface:

- `code-intel` CLI with `index`, `update`, `progress`, `status`, `health`, query commands including `relationships`, diagnostics, `eval`, `benchmark`, and `mcp`.
- LadybugDB graph and native vector persistence under `.code-intel/code-intel.lbug`.
- SCIP raw artifact preservation, normalized occurrence facts, canonical symbol promotion, and evidence-backed relationship edges.
- Tree-sitter structural facts for TS, TSX, JS, JSX, partial syntax, static imports, dynamic imports, CommonJS imports and exports, re-exports, default exports, declarations, decorators, constructors, calls, member access, JSX component usage, ownership, tests, callbacks, and backward-compatible chunks.
- First-class Import and Export graph nodes, declaration-backed symbols for non-chunk declarations, owning-file edges, target-symbol fallback edges when SCIP does not emit a definition, and TypeScript-compatible module resolution for package exports, path aliases, re-exports, default/named/namespace imports, dynamic imports, and CommonJS where statically knowable.
- Generation-local structural facts in `facts/files.json`, normalized SCIP facts in `facts/scip.json`, resolved module/export facts in `facts/resolution.json`, and a separate `facts/embeddings.json` vector reuse cache.
- Hybrid semantic ranking that uses vector, lexical, symbol, path, file-kind, test/source pairing, graph-neighbor, and bounded path-level app-flow signals.
- MCP stdio tools backed by the same query engine and result contracts as the CLI.
- Generation-local diagnostics, `diagnose file`, `diagnose symbol`, `eval --diagnostics`, and a corpus-copying benchmark harness for cold index, warm update, query latency, memory, batching, Ladybug lock behavior, and focused graph-store publish timing.
- Shared index/update progress under `<indexPath>/progress/current.json`, append-only run events under `<indexPath>/logs/index-<runId>.jsonl`, and queryable progress/event/lock-state surfaces through CLI `progress`, `status`, MCP `index_progress`, and `workspace_overview`.
- Pack-based eval harness with committed synthetic and adversarial packs plus on-demand OSS app-flow packs for Rallly, Ghostfolio, OpenStatus, Hermes, Dub, Twenty, and Formbricks. Current recorded hash and Jina validation passes the synthetic, adversarial, Rallly, cross-OSS, and holdout target/scoreboard matrix.
- First `js-monorepo/packages/react-sdk` smoke validation.
