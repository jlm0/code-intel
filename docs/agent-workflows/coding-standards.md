---
title: Coding Standards Reference
feature: agent-workflows
created: 2026-05-18
last_updated: 2026-05-18
status: active
---

# Coding Standards Reference

Repo-root `AGENTS.md` carries the mandatory coding directives. This file preserves the detail.

## Naming

Names should reveal intent without explanatory comments. Whole words are preferred over abbreviations. Classes, types, and variables use nouns. Functions and methods use verbs. Match existing TypeScript and repo-local conventions.

Examples:

- `discoverWorkspace` instead of `discWs`
- `embeddingProvider` instead of `embProv`
- `buildIndexDiagnostics` for a function
- `ResolvedModuleFact` for a type

## Single Responsibility

A function should do one thing. A function that discovers files, parses facts, writes graph records, and ranks results needs splitting. A name that needs "and" is a signal that the function may be doing too much.

## Reuse

New code should start with a search for existing methods, utilities, helpers, constants, and patterns. Duplicate logic tends to become inconsistent. Shared logic belongs in reusable functions or established local abstractions.

## File Size

Prefer keeping hand-written files under 300 lines where practical. Existing dense modules may need gradual extraction, but do not add unrelated refactors to a behavior change unless the refactor is needed for correctness or testability.

## Code Intel Boundaries

- CLI parsing and presentation belong under `src/cli/`.
- MCP tool definitions and response shaping belong under `src/mcp/`.
- Query behavior belongs under `src/query/`.
- Indexing orchestration and fact production belong under `src/indexer/`.
- Tree-sitter extraction belongs under `src/treesitter/`.
- SCIP ingestion belongs under `src/scip/`.
- Graph persistence and traversal primitives belong under `src/graph/`.
- Embedding providers belong under `src/vectors/`.
- Workspace discovery and ignore policy belong under `src/workspace/`.
- Eval parsing and scoring belong under `src/eval/`.
- Diagnostics belong under `src/diagnostics/`.

Do not duplicate query logic between CLI and MCP. Do not make eval behavior depend on CLI rendering. Do not let tests reach through private helpers when a public contract gives the same confidence.

## Parser And Graph Quality

Use structured APIs and parsers instead of ad hoc string matching whenever possible.

Preferred evidence order:

1. SCIP compiler-aware symbol and reference facts.
2. TypeScript-compatible module resolution facts.
3. Tree-sitter structural facts.
4. Labeled fallback heuristics.

Fallbacks must be explicit. Ambiguous dynamic cases should be marked unresolved instead of guessed.

## Ranking Quality

Ranking changes must remain deterministic unless a future feature explicitly introduces a local reranker. Weights should be typed, named, and explainable in result metadata. Add eval or integration coverage before changing ranking behavior.

## Test Quality

High-value tests define behavior and fail when behavior is broken. They assert positive and negative cases, exact deterministic values, complete output shapes, and realistic fixtures.

Avoid tests that only prove implementation shape, vacuous truth, or loose matching. Eval tests should include false-positive guards when relationship or ranking quality is the point.
