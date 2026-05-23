---
title: Agent Workflow Reference Index
feature: agent-workflows
created: 2026-05-18
last_updated: 2026-05-22
status: active
---

# Agent Workflow Reference Index

This folder holds reference detail for the repo-root `AGENTS.md`.

`AGENTS.md` is the directive layer. It states what to do, when to do it, and which checks are required. The files in this folder preserve supporting workflow detail without making the root instruction file too large.

## Files

- `development-workflow.md`: workstream-aware development flow, discovery, docs sequence, bug investigation, review phases, manual validation, and completion expectations.
- `tdd.md`: red/green/refactor rules, test selection, test quality gates, eval-driven work, and evidence expectations.
- `repo-verification.md`: code-intel verification commands and when to run focused, full, eval, benchmark, package, CLI, MCP, and presenter checks.
- `workstream-documentation.md`: required global workstream creation and execution skill flow, `.agent-workstream/` layout, document boundaries, evidence rules, and execution handoff rules.
- `local-documentation.md`: repo docs organization, naming conventions, front matter, and reference-doc maintenance.
- `coding-standards.md`: naming, responsibility, reuse, file size, architecture boundaries, parser/eval quality, and test quality.
- `pull-requests.md`: conventional commits, branch names, PR titles, PR descriptions, and pre-PR verification.

## Maintenance Notes

Keep mandatory behavior in `AGENTS.md`. Put supporting detail here.

When a workflow detail becomes an action trigger, move or duplicate the directive into `AGENTS.md` and leave this folder as the explanation layer.
