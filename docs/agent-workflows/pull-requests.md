---
title: Pull Request Reference
feature: agent-workflows
created: 2026-05-18
last_updated: 2026-05-22
status: active
---

# Pull Request Reference

Repo-root `AGENTS.md` contains mandatory commit and PR rules. This file preserves detail.

## Commit Messages

Commit messages use conventional commit format and stay concise. The subject should describe what is included in the commit.

Valid examples:

```text
fix: resolve stale generation reads
feat: add eval diagnostics
docs: update agent workflow
```

Invalid examples:

```text
fix(api): resolve stale generation reads
fix (api): resolve stale generation reads
fix [api]: resolve stale generation reads
fix: codex update workflow
fix: Jordy requested workflow update
```

## Branch Names

Branch names use conventional intent in git-safe slash form.

Valid examples:

```text
fix/stale-generation-reads
feat/eval-diagnostics
docs/update-agent-workflow
```

Do not include tool names, agent names, author names, repo names, issue labels, bracketed labels, or noisy prefixes in branch names unless explicitly asked.

## PR Titles

PR titles use conventional commit format:

```text
fix: resolve stale generation reads
feat: add eval diagnostics
```

Do not use scopes, bracketed labels, parenthetical labels, repo names, branch names, links, author names, tool names, or agent names in PR titles.

## PR Descriptions

The description body is human-readable GitHub Markdown prose. It describes what changed, why it changed, and how the implementation works at a high level when that context matters.

The description body is a single paragraph of 1-5 natural sentences unless a repo template requires additional checklist content outside the description.

Do not use markdown section headers, bullet lists, checklists, tool attribution, or author attribution in the main PR description unless explicitly asked.

## Pre-PR Verification

Before opening a PR, inspect `package.json` scripts and use `repo-verification.md` to choose relevant checks. The normal expectation is focused tests first, then broader build, test, eval, benchmark, and package checks as risk requires.

Do not treat a PR as ready when relevant local verification has not run. If a command is blocked by environment, dependency, network, sandbox, or known pre-existing failure, record the command and classification in the active workstream `validation.md` for workstream-scoped work and in the PR handoff.

Before pushing, inspect `git status --short --branch`, stage only intended changes, and verify the branch is not behind the target remote branch when a remote exists.
