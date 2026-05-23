---
title: Repo Verification Reference
feature: agent-workflows
created: 2026-05-18
last_updated: 2026-05-22
status: active
---

# Repo Verification Reference

Repo-root `AGENTS.md` defines when verification is required. Re-check `package.json` scripts before relying on this file because scripts can change.

## General Rule

Run verification from the worktree that contains the change.

Before committing or opening a PR, choose the relevant lint, typecheck, build, unit test, integration test, CLI test, MCP test, presenter test, eval, benchmark, and package checks for the changed behavior.

If a command cannot run, record the exact command, working directory, failure mode, and whether it is a product failure, test setup failure, dependency or network failure, environment limitation, pre-existing failure, or user-approved skip.

For workstream-scoped work, record commands and results in `.agent-workstream/<workstream-id>/validation.md`. Append only material validation consequences, decisions, or follow-ups to `notes.md`.

## Script Map

Current package scripts:

```bash
npm run build
npm test
npm run test:unit
npm run test:integration
npm run test:cli
npm run test:mcp
npm run test:e2e
npm run eval
```

## Default Verification

For most source changes:

```bash
npm run build
npm test
git diff --check
npm pack --dry-run
```

For docs-only or instruction-only changes:

```bash
git diff --check
```

Use broader checks if docs change package contents, CLI examples, eval contracts, or user-facing behavior.

For workstream execution, verification commands are evidence inputs for `$workstream-execution-validation` and `$workstream-execution-closure`. Passing commands do not complete the workstream unless required `T*`, `E*`, and `G*` items in `.agent-workstream/<workstream-id>/validation.md` are updated with exact evidence and the final gate is accepted.

## Focused Checks

Run focused tests first when the touched layer is known.

CLI:

```bash
npm run build
npm run test:cli
```

MCP:

```bash
npm run build
npm run test:mcp
```

Integration:

```bash
npm run build
npm run test:integration
```

Unit:

```bash
npm run test:unit
```

E2E:

```bash
npm run build
npm run test:e2e
```

TTY rendering is covered by presenter/unit tests. There is no native terminal harness script in the current package because the CLI does not have interactive terminal-control behavior.

## Eval Checks

For eval harness, ranking, graph, fusion, AST, SCIP, or relationship changes, run the affected eval packs with hash first:

```bash
npm run build
node dist/cli/main.js eval --suite js-ts-general --embedding-provider hash --json
node dist/cli/main.js eval --eval-pack eval-packs/js-ts-adversarial --embedding-provider hash --json
```

Run Jina when semantic behavior, embedding compatibility, or provider metadata is in scope:

```bash
node dist/cli/main.js eval --suite js-ts-general --embedding-provider jina --json
```

For OSS app-flow changes, run the affected on-demand pack:

```bash
node dist/cli/main.js eval --suite oss-rallly-app-flow --fetch --embedding-provider hash --json
node dist/cli/main.js eval --suite oss-dub-app-flow --fetch --embedding-provider hash --json
node dist/cli/main.js eval --suite oss-twenty-crm-flow --fetch --embedding-provider hash --json
node dist/cli/main.js eval --suite oss-formbricks-survey-flow --fetch --embedding-provider hash --json
```

Use `--eval-cache-path` when a stable cache is needed. Use `--diagnostics` when checking corpus coverage or explaining a miss.

## Benchmark Checks

For performance, concurrency, batching, lock, update, or packaging-readiness changes:

```bash
npm run build
node dist/cli/main.js benchmark --suite js-ts-general --embedding-provider hash --skip-mcp-latency --json
```

Run Jina benchmark when embedding cost or model-cache behavior is in scope:

```bash
node dist/cli/main.js benchmark --suite js-ts-general --embedding-provider jina --skip-mcp-latency --json
```

Treat `ladybugLock.concurrentRead`, `readerDuringUpdate`, or `readerAfterPublish` failures as standalone-readiness blockers unless the task explicitly scopes them out.

## Package Checks

Run package verification before claiming packaging or install readiness:

```bash
npm pack --dry-run
```

Confirm no `code-intel-*.tgz` artifact was left behind. If one appears, remove it before committing unless the user explicitly asked for a tarball.

## Workstream Evidence

Do not mark a validation item complete from intention, code inspection, or a broad command alone. Tie each result to the relevant workstream ID, validation item ID, command or manual evaluation, observed result, and blocker classification when applicable.

## Dirty Worktree Discipline

Before staging, inspect all modified and untracked paths.

Commit only intended source, tests, docs, eval packs, and durable tooling. Do not stage unrelated user changes, caches, generated indexes, model caches, local eval corpora, logs, build outputs, tarballs, or scratch artifacts.
