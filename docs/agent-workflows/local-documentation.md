---
title: Local Documentation Reference
feature: agent-workflows
created: 2026-05-18
last_updated: 2026-05-22
status: active
---

# Local Documentation Reference

Repo documentation lives under `docs/`. Active workflow state lives under `.agent-workstream/`.

## Documentation Layout

Use `docs/` for stable product reference, CLI usage, eval strategy, research, and agent workflow guidance:

```text
docs/
  README.md
  testing-strategy.md
  adversarial-evals.md
  oss-eval-portfolio.md
  future-improvements.md
  research/
  agent-workflows/
```

Use `.agent-workstream/` for active workstream requirements, plans, validation, and material history:

```text
.agent-workstream/
  YYYY-MM-DD-NN-short-domain-short-purpose/
    spec.md
    validation.md
    plan.md
    notes.md
```

Read `workstream-documentation.md` before creating, updating, executing, validating, or migrating workstream docs.

## Retired Workflow Docs

Do not recreate the retired root feature-doc workflow:

- `docs/feature-spec.md`
- `docs/feature-plan.md`
- `docs/feature-design-notes.md`
- `docs/verification-checklist.md`

## Keeping Docs Current

Post-implementation hardening and improvements must keep the relevant workstream docs current.

- Update `spec.md` when behavior, API surface, data model, safety model, wire contracts, or non-goals change.
- Update `plan.md` when sequencing, readiness, strategy, or required implementation steps change.
- Update `validation.md` with commands, test evidence, eval evidence, manual validation, package checks, hardening results, gates, blockers, and remaining validation gaps.
- Update `notes.md` with material decisions, reversals, tradeoffs, scope changes, implementation discoveries, validation consequences, and follow-ups.
- Update `testing-strategy.md`, `adversarial-evals.md`, or `oss-eval-portfolio.md` when eval or test strategy changes.

Workstream notes are append-only material history. Preserve prior decisions and add new changes after older changes so the decision history stays traceable.

## Naming Detail

Use lowercase kebab-case for docs folders and filenames. Ordered research uses zero-padded numeric prefixes such as `01-local-stack-reference.md`.

## Front Matter Detail

Reusable reference markdown uses front matter with:

```yaml
---
title: Example Title
feature: feature-slug
created: YYYY-MM-DD
last_updated: YYYY-MM-DD
status: draft
---
```

Status values are plain and practical, such as `draft`, `active`, `complete`, `superseded`, or `archived`.

## Writing Style

Use concise technical writing. Keep current behavior separate from historical notes. Avoid references to former workspace locations unless the reference is explicitly historical verification evidence.
