# Code Intel Agent Instructions

## Scope And Authority

- Use this file as the repo-local instruction set for `/Users/jordy/Documents/GitHub/code-intel`.
- This repository is the standalone local-first JS/TS code intelligence CLI, MCP server, eval, diagnostics, and benchmark tool.
- These instructions replace the former workspace-level agent rules that governed the tool while it lived under a larger orchestration workspace.
- If this file conflicts with an active user request, follow the active user request first, then this file, then the referenced workflow docs.
- If a future repo-specific `CLAUDE.md` exists, read it as additional guidance, but do not treat it as a replacement for this file.

## Required Reference Reads

- Read `docs/agent-workflows/README.md` when changing this instruction system or adding new workflow reference docs.
- Read `docs/agent-workflows/development-workflow.md` before non-trivial workstream work, hardening, bug fixes, review passes, or manual validation.
- Read `docs/agent-workflows/tdd.md` before writing tests, changing production code for non-trivial work, fixing bugs, or judging whether test coverage is sufficient.
- Read `docs/agent-workflows/repo-verification.md` before selecting verification commands, committing changes, opening PRs, or deciding a verification command can be skipped.
- Read `docs/agent-workflows/workstream-documentation.md` before creating, updating, executing, validating, or migrating workstream docs.
- Read `docs/agent-workflows/local-documentation.md` before creating or updating non-workstream docs under `docs/`.
- Read `docs/agent-workflows/coding-standards.md` before broad refactors, new abstractions, CLI/MCP schema changes, parser changes, eval design, or test design.
- Read `docs/agent-workflows/pull-requests.md` before creating, updating, reviewing, or merging PRs.

## Start Every Task

- Confirm the repo path with `pwd` when repo context matters.
- Run `git status --short --branch` before editing, committing, or reviewing.
- Preserve unrelated dirty work. Do not revert, overwrite, reformat, or stage user changes unless explicitly asked.
- Use `rg` or `rg --files` first for searches.
- Inspect the actual code, config, test, eval pack, generated artifact, or docs before changing it.
- When asked where an error throws, answer with the exact file and line before proposing a fix.

## Source Of Truth

- `.agent-workstream/<workstream-id>/spec.md` is the behavioral source of truth for active workstream requirements and stable `R*` IDs.
- `.agent-workstream/<workstream-id>/validation.md` is the source of truth for required `T*` tests, `E*` evaluations, `G*` gates, evidence, results, blockers, and closure proof.
- `.agent-workstream/<workstream-id>/plan.md` tracks the current execution strategy, required `P*` steps, readiness, sequencing, and remaining implementation work.
- `.agent-workstream/<workstream-id>/notes.md` is append-only material history for decisions, changed assumptions, implementation findings, validation observations, and follow-ups.
- `docs/testing-strategy.md`, `docs/adversarial-evals.md`, and `docs/oss-eval-portfolio.md` govern eval and test strategy.
- Update the active workstream docs in the same session when behavior, architecture, eval contracts, validation evidence, remediation, or follow-up risks change.

## Development Workflow

- Treat workstream work, hardening, and bug fixes as requirements-first and test-driven.
- When defining a new workstream, use `$workstream-creation`, `$workstream-spec`, `$workstream-validation`, `$workstream-plan`, and `$workstream-notes` to create `.agent-workstream/<workstream-id>/spec.md`, `validation.md`, `plan.md`, and `notes.md` in that order.
- When asked to implement, complete, execute, or finish an existing workstream, use `$workstream-execution` with the workstream ID or `.agent-workstream/<workstream-id>/` path as the top-level orchestration flow.
- Do discovery before implementation.
- Use the current `.agent-workstream/<workstream-id>/` docs as the behavior, plan, validation, and material-history source of truth when the change affects product behavior, architecture, validation, or follow-up work.
- Execute workstreams validation-first: make required `T*` tests, `E*` evaluations, and `G*` gates real in the red phase before production implementation, complete required `P*` steps in the green phase, run QA, remediate blocking `Q*` findings through yellow `Y*` items, then run validation and closure.
- Use `$workstream-execution-delegation` only through red, green, or QA phase work when bounded subagent context helps. Keep final validation execution and closure as direct parent-session responsibilities unless the user explicitly asks otherwise.
- Derive tests or eval cases from the active workstream validation doc, bug trace, or confirmed acceptance criteria.
- For non-trivial production changes, write a failing test or failing eval gate first and confirm it fails for the expected behavioral reason when practical.
- Keep implementation scoped to the behavior demanded by the test, eval, or spec.
- Refactor only while focused tests stay green.
- Review for code reuse, quality, performance, determinism, and maintainability before handoff.

## Code Intel Architecture Expectations

- Keep CLI command actions thin. Core behavior belongs in reusable modules under `src/`.
- CLI and MCP must use the same query engine and schema contracts.
- Preserve deterministic outputs for non-TTY CLI and JSON modes.
- Preserve MCP stdout protocol purity. Logs go to stderr or files, never MCP stdout.
- Keep indexing local-first. Do not add hosted embedding, hosted graph, hosted vector, or LLM calls to normal indexing.
- Use Tree-sitter for syntax facts, SCIP for compiler-aware symbol/reference facts, TypeScript-compatible module resolution for import/export targets, LadybugDB for graph/vector persistence, and deterministic hybrid ranking as the default ranking path.
- Mark unresolved or fallback relationships explicitly instead of guessing.

## Tests And Evals

- Use unit tests for pure logic, schemas, parsers, ranking math, planner logic, and small transforms.
- Use integration tests for indexing, Ladybug persistence, graph writes, query behavior, diagnostics, benchmarks, and eval-pack behavior.
- Use CLI process tests for command parsing, stdout, stderr, exit codes, JSON output, and process-level behavior.
- Use MCP stdio tests for MCP transport and tool contracts.
- Use presenter/unit tests for `isTTY` rendering branches unless the CLI later adds true terminal-control behavior such as raw input, resize handling, or progress UI.
- Required eval gates are blocking regression contracts. Target and scoreboard gates are quality signals that must remain visible.
- Do not weaken eval expectations, `requireEvidence`, `allowedKinds`, `maxDepth`, `expected`, or `notExpected` to make a test pass unless the eval is proven wrong and the correction is documented.

## Test Naming

- Put test files under the matching runner directory: `tests/unit`, `tests/integration`, `tests/cli`, `tests/mcp`, or `tests/e2e`.
- Name test files with lowercase kebab-case and the `.test.ts` suffix: `<behavior-or-contract>.test.ts`.
- Prefer durable behavior names such as `progress.test.ts`, `fusion-resolution.test.ts`, or `indexing-memory-contracts.test.ts`.
- Do not put workflow state, agent names, or temporary implementation status in filenames. Avoid suffixes such as `-red`, `-green`, `-wip`, `-fix`, or tool/agent labels.
- For broad hardening coverage, use `<area>-<risk-or-contract>.test.ts`, for example `indexing-oom-regressions.test.ts`.
- Keep `describe` names aligned with the behavior or contract under test; RED phase status belongs in verification notes, not permanent test names.

## Verification

- Inspect `package.json` scripts before choosing commands.
- For source, CLI, MCP, graph, eval, diagnostics, benchmark, ranking, or packaging changes, run the relevant focused tests first, then broader verification as risk requires.
- Normal high-confidence package verification is:

```bash
npm run build
npm test
git diff --check
npm pack --dry-run
```

- For eval-sensitive changes, run affected `node dist/cli/main.js eval ...` commands with hash, and use Jina where semantic behavior or embedding compatibility is in scope.
- If a command cannot run, record the command, working directory, failure mode, and whether it is a product failure, setup failure, dependency or network failure, sandbox limitation, pre-existing failure, or user-approved skip.
- For workstream-scoped work, record verification evidence in `.agent-workstream/<workstream-id>/validation.md` and append only material consequences to `notes.md`.

## Commits And PRs

- Use conventional commit format for all commit messages and PR titles.
- Keep commit messages concise and direct to what changed.
- Do not include tool names, agent names, author names, repo names, branch names, links, or extra labels in commit messages, branch names, PR titles, or PR descriptions unless explicitly asked.
- Use conventional branch names such as `fix/session-refresh`, `feat/eval-pack`, or `docs/update-agent-rules`.
- PR descriptions should be one concise paragraph describing what changed, why it changed, and how it works at a high level unless a template requires more.
- Before committing, stage only intended repo-worthy source, tests, docs, and durable tooling.

## Documentation

- Keep repo documentation under `docs/`.
- Keep durable workstream state under `.agent-workstream/` by using the global workstream skills. Do not recreate or continue the retired root `docs/feature-*` workflow for active work.
- Keep workstream artifacts inside the workstream folder, using `artifacts/` only when evidence files are needed.
- Keep non-workstream repo docs focused on stable product reference, eval strategy, CLI usage, research, and agent workflow guidance.
- Documentation markdown should use front matter when it is a reusable reference or product doc, with at least `title`, `feature`, `created`, `last_updated`, and `status`.
- Update `last_updated` when editing reusable reference docs.
- Use concise technical writing. Avoid former parent-workspace references unless they are explicitly historical.
