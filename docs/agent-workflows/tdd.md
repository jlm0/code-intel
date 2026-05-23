---
title: Test-Driven Development Reference
feature: agent-workflows
created: 2026-05-18
last_updated: 2026-05-22
status: active
---

# Test-Driven Development Reference

This file is the detailed TDD contract for code-intel workstream execution, hardening, bug fixes, and non-trivial refactors.

## Goal

TDD is the mechanism for turning workstream requirements, validation items, and eval targets into executable proof.

For workstream execution, TDD maps directly to the `workstream-execution` flow: red phase makes required validation executable, green phase implements the smallest satisfying change, QA inspects quality, yellow phase remediates blocking review findings, and validation plus closure prove acceptance.

For code-intel work, TDD must:

- Prove the behavior described in `.agent-workstream/<workstream-id>/spec.md`.
- Protect sequencing and readiness expectations in `.agent-workstream/<workstream-id>/plan.md`.
- Use `.agent-workstream/<workstream-id>/validation.md` as the authoritative list of required tests, evals, gates, command evidence, and residual risks.
- Record material implementation decisions and tradeoffs in `.agent-workstream/<workstream-id>/notes.md`.
- Prefer behavior and contract tests over tests coupled to private implementation.
- Use the narrowest useful test first, then add boundary tests where real tool risk lives.

## When TDD Is Required

Use TDD for:

- New CLI behavior.
- New MCP behavior.
- Indexing, update, generation publishing, locking, and persistence changes.
- Tree-sitter AST extraction changes.
- SCIP ingestion or fusion changes.
- Module resolution, graph edge, traversal, test-linking, or ranking changes.
- Eval-pack parsing, report shape, diagnostics, benchmark, or corpus-fetch behavior.
- Schema, manifest, cache, and artifact format changes.
- Bug fixes and regressions.
- Refactors in weakly tested code.

Use judgment only for tiny mechanical edits such as typo fixes, comment corrections, formatting-only changes, or clearly non-behavioral docs edits. Do not classify behavior changes as mechanical to avoid tests.

## Inputs Before Tests

Before writing tests, identify the behavior source:

- Workstream work: `.agent-workstream/<workstream-id>/spec.md`, `.agent-workstream/<workstream-id>/validation.md`, and confirmed acceptance criteria.
- Bug fixes: exact failure path, failing input or state, and expected corrected behavior.
- Hardening: invariant, race, boundary condition, scale issue, eval gap, or failure mode.
- Refactor: current behavior that must remain stable.
- Docs or examples: documented developer-facing behavior and copy-pastable expected usage.

If expected behavior is unclear, update or clarify the owning workstream document before writing production code.

## Test List First

Before red/green/refactor, write or update the relevant `T*`, `E*`, or `G*` item in the active workstream validation document.

The list should identify:

- The first narrow test or eval to write.
- The behavior or invariant each check proves.
- Whether the check is unit, integration, CLI, MCP, presenter, eval, benchmark, package, or manual validation.
- Which risks are intentionally deferred.

Do not replace `validation.md` with an ad hoc list unless the validation document is first updated with the new or corrected item and the reason is recorded in `notes.md`.

## Red Phase Requirements

The red phase is valid only when the new or changed test fails before production code changes and fails for the expected behavioral reason.

Required behavior:

- Write one focused failing test or eval for the next behavior.
- Run it before editing production code.
- Confirm the failure proves missing or incorrect behavior.
- Fix test setup errors before counting the test as red.
- Do not count syntax errors, missing imports, stale fixtures, bad mocks, wrong assumptions, unavailable services, or environment failures as a valid red phase.
- If the test already passes, investigate whether the behavior already exists, the test is too weak, or the test targets the wrong seam.

For bug fixes, the red test must reproduce the bug or violated invariant. If exact reproduction is not practical, write the closest deterministic regression test and record the limitation.

Workstream red phase also covers evaluations and gates. Required `E*` items must have executable procedures, expected observations, pass/fail criteria, and evidence paths. Required `G*` items must aggregate the tests and evaluations needed for acceptance, including the final gate.

## Green Phase Requirements

The green phase is the smallest production change that satisfies the current failing test.

Required behavior:

- Change only the production code needed for the current failing test or eval.
- Do not add speculative branches, broad rewrites, future abstractions, or unrelated cleanup.
- Run the focused test and confirm it passes.
- Run nearby tests when adjacent behavior can regress.
- Do not weaken, delete, or rewrite the test just to get green.
- If the test is wrong, document why before changing it.

For workstreams, green phase should follow the required `P*` plan steps while staying tied to `R*` requirements and red-phase failures. If the implementation discovers that a `P*`, `T*`, `E*`, or `G*` item is wrong or incomplete, update the owning workstream document and add a material note before continuing.

## Refactor Phase Requirements

Refactor only after the focused test is green.

Required behavior:

- Preserve behavior while improving names, structure, duplication, boundaries, or test readability.
- Run focused tests after each meaningful refactor.
- Run the relevant broader suite before leaving the area.
- Do not change behavior during refactor. If behavior changes are needed, return to red with a new test.

QA findings that require code changes enter yellow phase, not silent cleanup. Track blocking `Q*` findings and `Y*` remediation, add missing regression validation when needed, then rerun the relevant red, green, QA, and validation checks narrowly before broader verification.

## Code Intel Test Mapping

Use unit tests for:

- Stable IDs, schemas, report summaries, rank scoring, intent classification, ignore rules, parsers, planners, and small transforms.

Use integration tests for:

- Workspace discovery, AST facts, SCIP ingestion, fusion, module resolution, graph writes, vector writes, diagnostics, benchmark behavior, query engine behavior, locking, and incremental update.

Use CLI tests for:

- Process behavior, stdout, stderr, exit codes, command parsing, JSON output, limits, and error handling.

Use MCP tests for:

- Tool registration, tool descriptions, stdio protocol purity, bounded response shapes, guidance metadata, and CLI/MCP result agreement.

Use eval tests for:

- Required gates, target gates, scoreboard gates, false-positive guards, failure classification, report shape, metrics, and external cache behavior.

Use presenter tests for:

- TTY rendering branches by injecting `isTTY: true`, while keeping machine-output and process behavior in CLI process tests.

## Eval Quality Gates

Tests must prove behavior, not implementation shape.

Eval gates should be general capability checks whenever possible:

- AST mechanics.
- SCIP symbol and occurrence correctness.
- Fusion and module resolution.
- Graph edge semantics and traversal.
- Test-linking.
- Ranking quality.
- Diagnostics and queryability.
- CLI and MCP contract behavior.

Required eval-quality behavior:

- Include positive expectations and false-positive guards.
- Require evidence when the relationship depends on evidence.
- Avoid repo trivia when a general capability can express the same expectation.
- Keep target and scoreboard failures visible.
- Do not weaken expected files, symbols, ranks, edge kinds, max depth, or evidence requirements unless the eval is proven wrong.

## Test Quality Gates

Required quality gates:

- Assert result count before using `every`, `some`, loops, or all-pass helpers.
- Test both true and false sides of conditionals.
- Use exact assertions for deterministic values.
- Include negative and cross-validation cases.
- Assert complete returned object shapes when shape is part of the contract.
- Include failure-path tests for validation, parsing, detection, protocol, and persistence logic.
- Use realistic fixtures that match generated project structures or real repo payloads.
- Avoid snapshots unless the snapshot is the clearest contract and small enough to review.
- Avoid broad mocks that make the test pass while the real integration is broken.
- Prefer deterministic clocks, ids, keys, and external inputs.
- Keep tests independent.
