---
title: Development Workflow Reference
feature: agent-workflows
created: 2026-05-18
last_updated: 2026-05-22
status: active
---

# Development Workflow Reference

Repo-root `AGENTS.md` contains the mandatory workflow triggers. This file preserves the detail behind the workflow.

## Requirements

Workstream-scoped work, hardening, bug fixes, and non-trivial refactors are handled through a requirements-first and test-driven workflow. Requirements define the tests and evals. The task description alone may not contain enough acceptance criteria, edge cases, or scope boundaries.

Active code-intel work uses `.agent-workstream/<workstream-id>/` as durable workflow state. The old root `docs/feature-*` documents are retained as imported history, not as the active source of truth for new work.

Use `$workstream-creation` when defining a new workstream. Use `$workstream-execution` when implementing, completing, executing, or finishing an existing workstream. Execution should consume the current `spec.md`, `validation.md`, `plan.md`, and `notes.md` rather than recreating the workstream.

The normal workstream definition sequence is:

1. Gather context and complete discovery.
2. Create or refresh the workstream docs when the task requires durable requirements, planning, validation, or history.
3. Confirm `spec.md` has stable `R*` requirements.
4. Confirm `validation.md` has required `T*` tests, `E*` evaluations, and `G*` gates.
5. Confirm `plan.md` has required `P*` steps mapped back to requirements and validation.
6. Keep `notes.md` minimal unless material findings already exist.

The normal workstream execution sequence is:

1. Read the relevant `spec.md`, `validation.md`, `plan.md`, `notes.md`, root `AGENTS.md`, and required workflow references.
2. Use validation as the red-phase driver. Materialize, confirm, or repair required `T*`, `E*`, and `G*` items before production implementation, and confirm failing tests or evals fail for the expected reason when practical.
3. Implement the smallest green-phase production changes that complete required `P*` steps and satisfy `R*` requirements.
4. Refactor only after focused checks are green.
5. Run QA across code review, security, performance, maintainability, architecture, testability, consistency, and simplicity. Record blocking `Q*` findings.
6. Route blocking QA findings through yellow-phase `Y*` remediation. Add or update regression validation when a QA finding exposes missing coverage.
7. Run focused checks first, then broader verification based on risk. Update every required `T*`, `E*`, and `G*` result with evidence or a classified blocker.
8. Close the workstream only after required `P*`, `T*`, `E*`, `G*`, `Q*`, and `Y*` items are complete, classified, or explicitly accepted.
9. Commit only intended repo-worthy changes when the user asks for a commit.

## Red, Green, Refactor

The detailed TDD contract lives in `tdd.md`. Read it before writing tests or changing production code for non-trivial work.

At the workflow level, the test is the specification. A test that passes before implementation proves little. A test written after the implementation and shaped to match it validates less than a true red phase.

Red means a failing test or eval captures the expected behavior and fails for the right reason. Green means the minimum production change makes that test or eval pass. Refactor means structure, naming, duplication, and boundaries improve while tests stay green.

## Bug Fixing

Bug fixing starts by tracing the actual code path from input to failure. Confirm the root cause from code, logs, runtime behavior, a failing test, or a failing eval before applying risky fixes.

For systemic bugs, a regression test is the minimum prevention mechanism. A stricter schema, type constraint, shared helper, or broader test pattern can be appropriate when the bug class appears in more than one place.

## Review Dimensions

Code reuse review looks for duplicated logic, redundant patterns, existing utilities that could replace new code, duplicate functions, hand-rolled parsing where helpers exist, and inline logic that should use established abstractions.

Code quality review looks for readability, structure, conventions, redundant state, parameter sprawl, copy-paste with variation, leaky abstractions, raw strings where typed constants exist, plan adherence, and safety.

Efficiency review looks for unnecessary work, missed batching, hot-path bloat, avoidable graph scans, time-of-check/time-of-use issues, memory leaks, and overly broad operations.

Eval-quality review checks whether new evals are general capability probes rather than repo trivia, whether false-positive guards exist, and whether failures classify the right layer.

Each finding is triaged before remediation. False positives, stylistic nits, and unproven theories do not become code changes.

## Completion Shape

A complete handoff reports what changed, which checks ran, what could not run, what docs changed, whether unrelated dirty work was left alone, what was committed, and what risk remains.

For workstream-scoped work, update `.agent-workstream/<workstream-id>/validation.md` with command and eval evidence before the final handoff. Append only material consequences, decisions, or follow-ups to `notes.md`.
