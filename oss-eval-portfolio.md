---
title: OSS Eval Portfolio
feature: code-intelligence-graph
created: 2026-05-16
last_updated: 2026-05-16
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
| Hermes Agent | 143 | 143 |

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

## Baseline Results

All new gates are target or scoreboard, so `blockingStatus` should pass even while `qualityStatus` fails. That is intentional. The failures are improvement targets, not harness failures.

| Pack | Provider | Blocking | Quality | Target | Scoreboard | Failure Classes |
| --- | --- | --- | --- | ---: | ---: | --- |
| Ghostfolio | hash | pass | fail | 6/8 | 0/1 | graph-traversal, ranking, test-linking |
| Ghostfolio | Jina | pass | fail | 6/8 | 0/1 | graph-traversal, ranking, test-linking |
| OpenStatus | hash | pass | fail | 5/8 | 0/1 | chunking, graph-traversal, ranking |
| OpenStatus | Jina | pass | fail | 5/8 | 0/1 | chunking, graph-traversal, ranking |
| Hermes Agent | hash | pass | fail | 5/8 | 0/1 | chunking, fusion, ranking, test-linking |
| Hermes Agent | Jina | pass | fail | 5/8 | 0/1 | chunking, fusion, ranking, test-linking |

## Expected First-Run Failures

The current first-run failures are useful because they are layer-classified:

- Ghostfolio exposes service-to-Prisma graph traversal and portfolio spec test-linking gaps.
- OpenStatus exposes AST extraction gaps in Hono route and monitor-tag service facts, plus route-to-database graph traversal.
- Hermes exposes hook AST extraction, hook reference fusion, gateway test-linking, and TUI gateway semantic ranking gaps.

These should be treated as future hardening targets. Do not graduate any of these gates to `required` until a direct regression test pins the same AST fact, edge, evidence set, or query result.

## Current Packs

| Pack | Repo | Commit |
| --- | --- | --- |
| `oss-ghostfolio-app-flow` | `https://github.com/ghostfolio/ghostfolio.git` | `bd2ca4aacdf715f53acb0950f30d69531a7e80a2` |
| `oss-openstatus-app-flow` | `https://github.com/openstatusHQ/openstatus.git` | `5f81fd9b7b5fab263abaacc7c621030f673057bc` |
| `oss-hermes-agent-ui` | `https://github.com/NousResearch/hermes-agent.git` | `3b39096904ae63a9e784b2403ad6ad27160bb2ef` |
