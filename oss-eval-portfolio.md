---
title: OSS Eval Portfolio
feature: code-intelligence-graph
created: 2026-05-16
last_updated: 2026-05-17
status: active
---

# OSS Eval Portfolio

This document tracks the on-demand OSS eval packs that broaden `code-intel` validation beyond Rallly. These packs are not meant to prove every layer is finished. They are target and scoreboard gates that expose whether the tool generalizes across different JS/TS repository shapes.

## Why These Packs Exist

The synthetic fixture remains the required regression gate. Rallly remains the first real app-flow gate. Ghostfolio, OpenStatus, and Hermes Agent add variety:

| Pack | Repository Shape | What It Tests |
| --- | --- | --- |
| Ghostfolio | Angular, NestJS, Prisma, Nx | Angular component to Nest controller and service to database relationships |
| OpenStatus | Next dashboard, Hono API, DB schema, monitor services | Monitoring route, API, edge/config, service, database, and test relationships |
| Hermes Agent | React/Ink TUI, gateway client, protocol types, hooks, web package | AI-agent UI/TUI, gateway-client, protocol-type, hook, package-boundary, and test-to-implementation relationships |

## Cache Contract

Each pack is an `external-git` eval pack pinned to a full commit SHA. The eval runner clones sparse corpora into the configured `--eval-cache-path`.

The corpus cache key includes:

- pack id
- pinned ref prefix
- corpus URL
- repo paths
- sparse paths

This prevents a changed sparse checkout from silently reusing an incompatible cached corpus at the same commit. Jina model artifacts are cached under the eval cache path as `_embedding-cache`, so repeated Jina evals do not redownload the model.

Example:

```bash
node dist/cli/main.js eval \
  --suite oss-openstatus-app-flow \
  --eval-cache-path /tmp/code-intel-oss-eval-cache \
  --embedding-provider hash \
  --fetch \
  --json
```

## Sparse Corpus Shape

The packs intentionally use narrowed sparse paths. They include the files under evaluation plus immediate package and module-resolution context. This keeps first-run cost reasonable and makes local Jina runs practical.

Current chunk counts after narrowing:

| Pack | Hash Chunks | Jina Chunks |
| --- | ---: | ---: |
| Ghostfolio | 65 | 65 |
| OpenStatus | 122 | 122 |
| Hermes Agent | 175 | 175 |

## Layer Mapping

| Layer | Ghostfolio | OpenStatus | Hermes Agent |
| --- | --- | --- | --- |
| AST | Nest controller/service facts, Angular component facts | Hono route facts, dashboard page facts, monitor-tag service facts | Gateway class facts, React/Ink component facts, hook facts |
| SCIP | Symbol search for implementation methods and gateway classes | Route registration and service symbols | GatewayClient and hook symbols |
| Fusion | Service references and package/module usage | service export and test references | hook usage references |
| Graph | controller to service, service to database, spec to factory | route registration, route to DB, service test links | app to hook, hook to hook, gateway test links |
| Test-linking | portfolio calculator spec to factory | monitor-tag tests to implementation | gateway client tests to class |
| Ranking | Angular account-table semantic flow | dashboard create-monitor semantic flow | TUI gateway semantic flow |
| CLI/MCP | Same report shape as other eval packs | Same report shape as other eval packs | Same report shape as other eval packs |

## Current Results

The 2026-05-17 cross-OSS hardening pass moved the Ghostfolio, OpenStatus, and Hermes Agent target and scoreboard gates to green for both hash and Jina providers. These gates remain target or scoreboard because they validate generalization and quality, not the required regression floor.

| Pack | Provider | Blocking | Quality | Target | Scoreboard | Failure Classes |
| --- | --- | --- | --- | ---: | ---: | --- |
| Ghostfolio | hash | pass | pass | 8/8 | 1/1 | none |
| Ghostfolio | Jina | pass | pass | 8/8 | 1/1 | none |
| OpenStatus | hash | pass | pass | 8/8 | 1/1 | none |
| OpenStatus | Jina | pass | pass | 8/8 | 1/1 | none |
| Hermes Agent | hash | pass | pass | 9/9 | 1/1 | none |
| Hermes Agent | Jina | pass | pass | 9/9 | 1/1 | none |

## Resolved First-Run Failures

The original first-run failures were useful because they were layer-classified. They were resolved by the 2026-05-17 hardening work and should stay documented as the historical signal that drove the cross-OSS fixes:

- Ghostfolio exposes service-to-Prisma graph traversal and portfolio spec test-linking gaps.
- OpenStatus exposes AST extraction gaps in Hono route and monitor-tag service facts, plus route-to-database graph traversal.
- Hermes exposes hook AST extraction, helper reference fusion, test file indexing or test-linking gaps for composer and gateway tests, and TUI gateway semantic ranking gaps.

## 2026-05-17 Eval Correction

The Hermes composer reference case was corrected after source inspection. `ui-tui/src/__tests__/useComposerState.test.ts` imports `looksLikeDroppedPath` from `ui-tui/src/app/useComposerState.ts`; it does not reference the `useComposerState` hook symbol. The query case now asks for `looksLikeDroppedPath`, and a separate graph target checks whether the composer test links to that helper implementation.

The corrected hash and Jina baselines initially passed blocking and failed quality with 5 of 9 target gates passing. The later cross-OSS hardening pass fixed the test discovery and test-linking path, so the current Hermes result is 9 of 9 target gates and 1 of 1 scoreboard gates passing for both providers.

These gates should remain as future regression candidates, but do not graduate any gate to `required` until a direct regression test pins the same AST fact, edge, evidence set, or query result.

## Current Packs

| Pack | Repo | Commit |
| --- | --- | --- |
| `oss-ghostfolio-app-flow` | `https://github.com/ghostfolio/ghostfolio.git` | `bd2ca4aacdf715f53acb0950f30d69531a7e80a2` |
| `oss-openstatus-app-flow` | `https://github.com/openstatusHQ/openstatus.git` | `5f81fd9b7b5fab263abaacc7c621030f673057bc` |
| `oss-hermes-agent-ui` | `https://github.com/NousResearch/hermes-agent.git` | `3b39096904ae63a9e784b2403ad6ad27160bb2ef` |
