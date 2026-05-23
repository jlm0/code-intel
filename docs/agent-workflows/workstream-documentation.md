---
title: Workstream Documentation Reference
feature: agent-workflows
created: 2026-05-22
last_updated: 2026-05-22
status: active
---

# Workstream Documentation Reference

Code Intel uses workstream-centered documentation for durable requirements, planning, validation, and material history. Active workflow state belongs under `.agent-workstream/`.

## Required Skill Flow

Use the global workstream skills when a task needs a new workstream definition:

1. `$workstream-creation` creates the workstream folder and orchestrates the child docs.
2. `$workstream-spec` creates or updates `spec.md` with current requirements and stable `R*` IDs.
3. `$workstream-validation` creates or updates `validation.md` with required tests, evaluations, gates, artifacts, evidence, and results.
4. `$workstream-plan` creates or updates `plan.md` with the current execution strategy mapped to `R*` IDs.
5. `$workstream-notes` creates or appends `notes.md` with material findings, decisions, changed assumptions, validation observations, and follow-ups.

Use `$workstream-execution` when a task points at an existing workstream and asks to implement, complete, execute, or finish it. The execution skill is the top-level orchestrator for the `workstream-execution-*` suite. It consumes the current definition docs and coordinates red phase, green phase, QA, yellow remediation, validation execution, and closure.

Do not call the red, green, QA, yellow, validation, closure, or delegation execution skills as the top-level workflow unless the user explicitly scopes the task to that phase. Normal implementation starts with `$workstream-execution` and a workstream ID or path.

## Folder Contract

Create workstreams under the nearest appropriate project root:

```text
.agent-workstream/
  YYYY-MM-DD-NN-short-domain-short-purpose/
    spec.md
    validation.md
    plan.md
    notes.md
    artifacts/
    execution/
      tasks/
      handoffs/
      remediation.md
```

Use `artifacts/` only when evidence files are needed, such as logs, traces, payloads, eval reports, benchmark reports, package dry-run output, or generated review material.

Use `execution/tasks/` and `execution/handoffs/` only when execution delegates bounded work or needs durable phase handoffs. Use `execution/remediation.md` only when QA creates blocking `Q*` findings that require yellow-phase `Y*` remediation.

## Document Boundaries

- `spec.md` owns the current target contract: requirements, scope, non-scope, success state, constraints, and open questions.
- `validation.md` owns proof: completion claims, requirement coverage, tests, evaluations, gates, evidence, and results.
- `plan.md` owns the current execution strategy: approach, likely touchpoints, steps, dependencies, risks, and checkpoints.
- `notes.md` owns append-only material history: findings, decisions, changes, blockers, deferrals, validation observations, implementation consequences, and follow-ups.

Keep the current-state docs current. When the target, plan, or validation contract changes, update the owning document and append the reason to `notes.md`.

## Execution Boundaries

Workstream execution is validation-led. `validation.md` is the red-phase driver, not after-the-fact paperwork.

- Red phase owns making required `T*` tests, `E*` evaluations, and `G*` gates executable, failing, or explicitly classified before production implementation.
- Green phase owns production implementation against required `P*` plan steps, `R*` requirements, and red-phase failures.
- QA owns quality review beyond pass/fail validation and records blocking `Q*` findings for code review, security, performance, maintainability, architecture, testability, consistency, and simplicity.
- Yellow phase owns tracked remediation for blocking `Q*` findings through narrow `Y*` items. If a QA finding exposes missing regression proof, update `validation.md` with the new or corrected `T*`, `E*`, or `G*` item before or alongside remediation.
- Validation execution owns running and updating every required `T*`, `E*`, and `G*` result with exact evidence or classified blockers.
- Closure owns the final done or blocked decision. Do not mark the workstream done until required `P*`, `T*`, `E*`, `G*`, `Q*`, and `Y*` items are complete, classified, or explicitly accepted.

Use `$workstream-execution-delegation` as a utility for red, green, or QA subtasks when isolated context or specialist review helps. Validation execution and closure should remain direct parent-session responsibilities unless the user explicitly asks otherwise.

## Retired Paths

Do not create or update these retired active-workflow files for new workstream definition or execution:

- `docs/feature-spec.md`
- `docs/feature-plan.md`
- `docs/feature-design-notes.md`
- `docs/verification-checklist.md`
