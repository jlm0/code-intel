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

Dub, Twenty, and Formbricks are the holdout validation phase. They were added after the Ghostfolio/OpenStatus/Hermes hardening pass and are meant to measure generalization before implementation is tuned to them:

| Pack | Repository Shape | What It Tests |
| --- | --- | --- |
| Dub | Next.js app, API routes, middleware, Prisma, Tinybird, webhook/payment handlers | link creation, redirect analytics/cache/database, webhook/payment, UI-to-server, and integration-test-to-route relationships |
| Twenty | React frontend, NestJS GraphQL backend, Nx-style packages, services, modules | React-to-GraphQL/API, resolver-to-service, service-to-query-runner, Nest provider/module, package-boundary, ranking, and service tests |
| Formbricks | Next.js app router, server actions, survey editor, shared packages, Prisma/database client, package tests | survey editor, response persistence, auth/organization permission, shared package usage, test-linking, and ranking |

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
| Dub | 39 | 39 |
| Twenty | 64 | 64 |
| Formbricks | 39 | 39 |

## Layer Mapping

| Layer | Ghostfolio | OpenStatus | Hermes Agent | Dub | Twenty | Formbricks |
| --- | --- | --- | --- | --- | --- | --- |
| AST | Nest controller/service facts, Angular component facts | Hono route facts, dashboard page facts, monitor-tag service facts | Gateway class facts, React/Ink component facts, hook facts | Next route, create-link service, link-builder hook | GraphQL resolver, Nest service, React widget | survey editor, server actions, organization actions |
| SCIP | Symbol search for implementation methods and gateway classes | Route registration and service symbols | GatewayClient and hook symbols | createLink symbol search | BarChartDataService symbol search | SurveyEditorPage symbol search |
| Fusion | Service references and package/module usage | service export and test references | hook usage references | route/service and middleware/analytics references | module/provider references | package test/helper references |
| Graph | controller to service, service to database, spec to factory | route registration, route to DB, service test links | app to hook, hook to hook, gateway test links | route to service, service to Prisma, redirect to analytics | resolver to service, service to query runner | editor to auth, response action to response service |
| Test-linking | portfolio calculator spec to factory | monitor-tag tests to implementation | gateway client tests to class | integration test to API route | service spec to service | package test to response utility |
| Ranking | Angular account-table semantic flow | dashboard create-monitor semantic flow | TUI gateway semantic flow | UI-to-server and webhook/payment semantic flows | React record-table GraphQL semantic flow | survey editor auth/response semantic flow |
| CLI/MCP | Same report shape as other eval packs | Same report shape as other eval packs | Same report shape as other eval packs | Same report shape as other eval packs | Same report shape as other eval packs | Same report shape as other eval packs |

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

The 2026-05-17 holdout validation phase added Dub, Twenty, and Formbricks after that hardening pass. These first runs were intentionally performed before tuning implementation to the new repos. All holdout packs have zero required gates, so they pass `blockingStatus` and fail `qualityStatus` as expected target evidence.

| Pack | Provider | Blocking | Quality | Target | Scoreboard | Failure Classes |
| --- | --- | --- | --- | ---: | ---: | --- |
| Dub | hash | pass | fail | 5/11 | 1/2 | fusion, graph-traversal, ranking, test-linking |
| Dub | Jina | pass | fail | 5/11 | 1/2 | fusion, graph-traversal, ranking, test-linking |
| Twenty | hash | pass | fail | 5/9 | 1/1 | fusion, graph-traversal, test-linking |
| Twenty | Jina | pass | fail | 5/9 | 1/1 | fusion, graph-traversal, test-linking |
| Formbricks | hash | pass | fail | 5/9 | 0/1 | fusion, graph-traversal, ranking, test-linking |
| Formbricks | Jina | pass | fail | 5/9 | 0/1 | fusion, graph-traversal, ranking, test-linking |

## Holdout Failure Classification

The current holdout failures are classified this way:

| Pack | Failure | Classification | Affected Layer |
| --- | --- | --- | --- |
| Dub | `createLink` and `recordClick` references do not include the route or middleware call sites | real tool gap | fusion |
| Dub | route-to-`createLink`, `createLink`-to-Prisma, and middleware-to-`recordClick` paths are missing | real tool gap | graph |
| Dub | create-link integration test does not link to the API route it exercises through `http.post({ path: "/links" })` | unsupported repo pattern | test-linking |
| Dub | UI-to-server semantic query misses route and service symbols in the requested ranks | ranking-only quality issue | ranking |
| Twenty | `BarChartDataService` references miss some Nest resolver/module provider relationships | real tool gap | fusion |
| Twenty | resolver-to-service and service-to-query-runner paths are missing | real tool gap | graph |
| Twenty | service spec does not link to `BarChartDataService` as the implementation under test | real tool gap | test-linking |
| Formbricks | `processResponseData` references miss the package test relationship | real tool gap | fusion |
| Formbricks | survey editor to auth and response action to response service paths are missing | real tool gap | graph |
| Formbricks | response utility package test does not link to implementation | real tool gap | test-linking |
| Formbricks | survey editor auth/response semantic query misses the expected service files in the requested ranks | ranking-only quality issue | ranking |

No open sparse-checkout gaps were observed in the corrected baseline. One eval gap was found and corrected before recording the final baseline: the Formbricks response-action case originally expected `getResponseDownloadFile`, but the selected pinned file imports and calls `getResponses`; the organization action declaration is also correctly a `VariableFunction`, not a plain `Variable`.

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
| `oss-dub-app-flow` | `https://github.com/dubinc/dub.git` | `3e669b19b42a903178baa19a9e16b4a9b02a968e` |
| `oss-twenty-crm-flow` | `https://github.com/twentyhq/twenty.git` | `62b347fc743fbd28d558b02ab0d47fac04095816` |
| `oss-formbricks-survey-flow` | `https://github.com/formbricks/formbricks.git` | `f90a9fb1315bc3819da86917e08ee5daee112ade` |
