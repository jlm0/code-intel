---
title: Adversarial Eval Packs and Codex Handoff
feature: code-intelligence-graph
created: 2026-05-16
last_updated: 2026-05-21
status: active
---

# Adversarial Eval Packs

This document is the handoff between the evaluation author (Claude) and the implementer (Codex). Eval design is intentionally separated from implementation so the eval surface stays adversarial and is not shaped to fit current impl.

## Multi-Agent Split

- **Claude**: writes evaluations. New adversarial cases must fail today and target a real capability gap. Evaluations live in `eval-packs/`.
- **Codex**: improves the `code-intel` implementation until adversarial gates pass. Implementation is in `src/`.
- **Graduation policy**: every new gate starts as `target` (non-blocking quality work). Once a gate passes consistently across hash and Jina runs, Codex may graduate it to `required` and append a regression test. Cases must not be deleted or weakened.

## Packs Authored

Two new packs sit alongside the existing `js-ts-general` and `oss-rallly-app-flow`. Neither modifies the existing packs or the tests that pin them.

### `js-ts-adversarial`

- Local synthetic pack. New 60-file corpus under `eval-packs/js-ts-adversarial/corpus/`.
- 4 packages: `@adv/syntax`, `@adv/dispatch`, `@adv/modules`, `@adv/testing`.
- Cases: 29 AST, 40 graph, 17 query, 7 ranking, 1 MCP workflow, 1 CLI/MCP parity workflow - 95 adversarial gates total.

### `oss-rallly-adversarial`

- External-git pack. Reuses the pinned Rallly checkout (`5017e6a3…`). Extends the same sparse paths.
- Cases: 6 AST, 6 graph, 5 query — 17 gates targeting real-code patterns.

## Invocation

The default and OSS app-flow packs are available through `--suite`. The adversarial packs still use `--eval-pack` so they can remain independent of the built-in suite list:

```bash
# Synthetic adversarial run (hash provider for determinism):
node dist/cli/main.js eval \
  --eval-pack eval-packs/js-ts-adversarial \
  --embedding-provider hash --json

# Rallly adversarial run (requires --fetch on first invocation):
node dist/cli/main.js eval \
  --eval-pack eval-packs/oss-rallly-adversarial \
  --eval-cache-path /tmp/code-intel-rallly-eval-cache \
  --embedding-provider hash --fetch --json
```

Both packs run independently of the existing CI test surface. `npm test` will continue to pass while quality work is in progress on the adversarial packs.

## Gate Taxonomy by Layer

### AST (Tree-sitter extraction) - `adversarial-ast.json` and `type-precision-ast.json`

Original gaps the cases attacked. The implementation column records the smallest change that was expected when the gate was authored; later sections record which gates now pass and which were promoted.

| Gate | Capability | Implementation |
| --- | --- | --- |
| `adv.target.ast.inline-type-specifier` | `import { type Foo, bar }` separates type and value bindings | Per-specifier `importKind` inside a mixed import |
| `adv.target.ast.type-reexport` | `export type { X } from` records `exportKind="type"` | Add `"type"` to `SourceExportFact.exportKind` enum; emit it for type re-exports |
| `adv.target.ast.namespace-decls` | TS namespace declarations | Add `"Namespace"` to `SourceDeclarationKind`; walk `internal_module`/`module` nodes; emit nested qualified names |
| `adv.target.ast.enum-decls` | TS enums | Add `"Enum"` declaration kind; emit ownership facts per member |
| `adv.target.ast.private-fields` | `#field`, `static {}` blocks | Add `"ClassField"`, `"ClassAccessor"`; record `static-block` ownership child |
| `adv.target.ast.overloads` | Collapse overload signatures into one logical declaration | Treat overload signature nodes as metadata, not separate declarations |
| `adv.target.ast.decorators` | Preserve decorator names on class/method/accessor declarations | `decorators` array on declaration facts is already in the type — populate it for accessor decorators and parameter decorators |
| `adv.target.ast.generators` | `function*`/`async function*`/`yield*` | Generator function declarations + delegating call fact |
| `adv.target.ast.abstract-class` | `abstract` classes/methods | Emit abstract methods as `ClassMethod` declarations (today they may be skipped) |
| `adv.target.ast.jsx-edge` | JSX fragments + spread + dynamic component | Emit `"Fragment"` JSX call; spread `memberAccess`; dynamic-component JSX call with resolved variable name |
| `adv.target.ast.type-position-references` | `keyof`, `typeof`, mapped types | Emit reference facts with `type-use` evidence |
| `adv.target.ast.ambient-module` | `declare module 'x'` produces ambient declaration | New `"AmbientModule"` declaration kind; emit module members |
| `adv.target.ast.side-effect-import` | `import './polyfills'` | `importKind` already includes `"side-effect"` — verify it is actually emitted |
| `adv.target.ast.dynamic-template` | `import(\`./x/${y}\`)` | Preserve template-shaped specifier; mark dynamic |
| `adv.target.ast.anonymous-default` | Anonymous default function/class | Synthesize stable name `"default"`; set `defaultExport=true` |
| `adv.target.ast.default-reexport` | `export { default } from` | Single export fact, `exportedName="default"`, with `moduleSpecifier` |
| `adv.target.ast.tagged-template` | Tagged template literals | New `callKind="tagged-template"`; emit for each tagged-template expression |
| `adv.target.ast.bind-call-apply` | `fn.bind/call/apply` preserves `receiver=fn`, `propertyName` | Already partially supported; verify `receiver`/`propertyName` are populated on member calls |
| `adv.target.ast.super-call` | `super.method()` | `receiver="super"` on member call fact |
| `adv.target.ast.this-call` | `this.method()` | `receiver="this"` on member call fact |
| `adv.target.ast.snapshot-test` | `toMatchSnapshot`/`toMatchInlineSnapshot` | Emit member-call facts and flag the test case with a snapshot signal |
| `adv.target.ast.mock-call` | `vi.mock('./x', ...)` | Member-call fact with first-arg specifier metadata on the fact |
| `adv.target.ast.spec-tests` | `*.spec.ts` is a test file; `.each` expansion | Extend test-file classification; emit test cases for `.each` patterns |
| `adv.target.ast.nested-describe` | Nested describes track parent chain | Populate `parentName` from enclosing describe |
| `adv.target.ast.storybook` | `*.stories.tsx` is a Storybook file | Detect default export with `component` field; mark named exports as stories (not tests) |
| `adv.target.ast.satisfies` | `satisfies` operator does not break extraction | Grammar fallback or fact-level recovery for postfix `satisfies` |

### Graph edges & evidence - `adversarial-graph.json` and `type-precision-graph.json`

| Gate | Capability | Implementation |
| --- | --- | --- |
| `adv.target.graph.super-call` | `CALLS` from override to parent method | Resolve `super.method` to parent class member; carry `super-call` evidence |
| `adv.target.graph.this-call` | `CALLS` from method to same-class member | Resolve `this.method` to class member with `this-call` evidence |
| `adv.target.graph.interface-extends` | `interface X extends Y` produces `EXTENDS` | Currently `EXTENDS` is only emitted for class inheritance; extend to interfaces |
| `adv.target.graph.interface-extends-path` | Multi-level interface hierarchy | Same as above; path-exists traversal works once edges are emitted |
| `adv.target.graph.multi-implements` | Multiple `implements` | Emit one `IMPLEMENTS` per implemented interface |
| `adv.target.graph.type-position-reference` | `keyof T` etc. produce `REFERENCES` with `type-use` | New evidence source `type-use` on type-position references |
| `adv.target.graph.enum-member-reference` | `E.M` references the member, not the enum | Resolve member-access through enum type; emit REFERENCES to the member symbol |
| `adv.target.graph.namespace-member` | `NS.Inner.f()` resolves through nested namespaces | Member-chain resolution through namespace symbol table |
| `adv.target.graph.side-effect-import` | `IMPORTS` with `side-effect` evidence | New evidence source on side-effect imports |
| `adv.target.graph.side-effect-no-calls` | Side-effect import does NOT produce `CALLS` | False-positive guard |
| `adv.target.graph.multi-hop-barrel` | 4-hop re-export still reaches origin | Iterative re-export resolution; cycle-safe |
| `adv.target.graph.cyclic-reexport` | Cyclic re-export safety | No self-loop edge through the cycle |
| `adv.target.graph.bind-call-apply` | bind/call/apply target the wrapped function | Member-call fact with `propertyName in {bind,call,apply}` resolves to `receiver` as target |
| `adv.target.graph.bind-call-apply-fp` | bind/call/apply does not bleed into unrelated `call` methods | False-positive guard |
| `adv.target.graph.tagged-template` | Tagged template creates `CALLS` to tag | Once AST emits the call, fusion writes the edge |
| `adv.target.graph.generic-instantiation` | `new C<T>()` references the type arg | Type-arg references via SCIP or `type-use` evidence |
| `adv.target.graph.anonymous-default` | `export { default } from` resolves to synthesized default | Default export symbol creation + cross-file edge |
| `adv.target.graph.ambient-resolution` | Imports of ambient-declared modules resolve | Index ambient `declare module` declarations into the module resolver |
| `adv.target.graph.conditional-exports` | Conditional exports map resolves the ESM condition | Honour `"import"`/`"require"`/`"default"`/`"types"` conditions during module resolution |
| `adv.target.graph.dynamic-template-unresolved` | Dynamic template import is marked unresolved-dynamic | Explicit fallback reason on the IMPORTS edge instead of a guessed target |
| `adv.target.test-linking.mock` | `vi.mock` creates `TESTS` with `mock` evidence | Mock-aware test-linking layer |
| `adv.target.test-linking.snapshot` | `toMatchSnapshot` carries `snapshot` evidence | Snapshot-aware test-linking |
| `adv.target.test-linking.spec` | `*.spec.ts` participates in test-linking | Extend test-file regex/classification |
| `adv.target.test-linking.orphan-mock-false-positive` | No phantom edge from mocking nonexistent module | False-positive guard |
| `adv.target.test-linking.storybook-not-tests` | Stories are not `TESTS` | False-positive guard |
| `adv.target.test-linking.storybook-references` | Stories produce `REFERENCES`/`IMPORTS` to the component | Standard import resolution covers this once stories are detected as non-tests |
| `adv.target.graph.package-depends-on` | `DEPENDS_ON` between packages from `package.json` | Read `dependencies`/`devDependencies` and emit `DEPENDS_ON` between Package nodes |
| `adv.target.graph.no-package-bridge` | Unrelated files do not connect through Package nodes | False-positive guard against package-hub bridging |
| `adv.target.graph.discriminated-union` | Discriminated narrowing references each variant | SCOREBOARD; long-tail type-narrowing precision |
| `adv.target.graph.recursive-type` | Recursive type does not produce a self-loop edge | Cycle-safe REFERENCES emission |

### Query & ranking - `adversarial-queries.json`, `type-precision-queries.json`, and `adversarial-ranking.json`

| Gate | Capability | Implementation |
| --- | --- | --- |
| `adv.target.query.overload-dedupe` | One overloaded function returns one symbol | Symbol promotion picks the implementation signature |
| `adv.target.query.namespace-member` | Namespace members findable by short name | Symbol index includes qualified namespace paths |
| `adv.target.query.enum-member-symbol` | Enum members findable | Add enum members to symbol table |
| `adv.target.query.super-callers` | Super-callers surface in callers query | Implementation of `adv.target.graph.super-call` |
| `adv.target.query.this-callees` | This-callees surface in callees query | Implementation of `adv.target.graph.this-call` |
| `adv.target.query.bind-call-apply-callers` | Callers via bind/call/apply | Implementation of `adv.target.graph.bind-call-apply` |
| `adv.target.query.multi-hop-references` | References through 4-hop barrel | Multi-hop traversal in references query |
| `adv.target.query.type-only-references` | Type-only consumers in references | Carry through type-position evidence |
| `adv.target.query.enum-member-references` | Member-level reference precision | SCOREBOARD |
| `adv.target.query.ambient-references` | Ambient-resolved consumers | Implementation of `adv.target.graph.ambient-resolution` |
| `adv.target.query.tagged-template-callers` | Tag function callers | Implementation of `adv.target.graph.tagged-template` |
| `adv.target.query.anonymous-default-callers` | Anonymous default callers | SCOREBOARD |
| `adv.target.ranking.side-effect` | Side-effect semantic ranking | Embed `side-effect` metadata in chunk text |
| `adv.target.ranking.implementation-vs-test` | Real impl outranks test that mocks it | Intent classifier already favors source; verify weight |

### MCP agent-readiness - `mcp-agent-readiness.json`

| Gate | Capability | Implementation |
| --- | --- | --- |
| `adv.required.mcp-agent-readiness` | SDK stdio client can chain tools with structured outputs, diagnostics, relationship browsing, path evidence, invalid-input handling, and bounded context | MCP tools advertise `outputSchema`, return `structuredContent`, expose `diagnose_file`, `diagnose_symbol`, and `get_relationships`, and the eval harness runs a real SDK client against the built CLI |

### CLI/MCP parity - `cli-mcp-parity.json`

| Gate | Capability | Implementation |
| --- | --- | --- |
| `adv.required.cli-mcp-parity` | Built CLI JSON commands and MCP structured tools expose equivalent agent-ready results for the same workflow | The CLI exposes `relationships <seed>`, shares query-engine contracts with MCP, and the eval harness launches both a built CLI process and an SDK MCP client to compare stable IDs, files, symbols, ranking reasons, relationship evidence, path edges, diagnostics, limits, invalid-input behavior, and bounded context |
| `adv.target.ranking.intent-callers` | `where is X called` is callers intent | Intent classifier rule |
| `adv.target.ranking.intent-imports` | `who imports X` is imports intent | New imports-intent classification |
| `adv.target.ranking.path-fragment` | Path-fragment query ranks exact file #1 | Path-fragment detector in ranker |
| `adv.target.ranking.synonyms` | Synonym/abbreviation recall | SCOREBOARD; eval whether Jina handles it; otherwise vocab expansion |
| `adv.target.ranking.cross-package-disambiguation` | Same-name symbols in distinct packages | Stable ordering rule + symbol disambiguation by package |
| `adv.target.ranking.test-intent-snapshot` | Snapshot tests rank above impl for test intent | Snapshot evidence boosts test ranking |
| `adv.target.ranking.negative-intent` | `not a test` down-ranks tests | SCOREBOARD; negation handling |

### Jina/Tree-sitter embedding input quality

Reference label: `workstream:jina-tree-sitter-embedding-input-hardening`

| Gate | Capability | Implementation |
| --- | --- | --- |
| `adv.target.embedding.artifact-exclusion` | Generated, build, cache, and hidden artifact paths do not win semantic retrieval or contribute embedding noise | Shared discovery ignore policy applied before Tree-sitter, SCIP, exact search, graph writes, and embeddings |
| `adv.target.embedding.after-truncation-signal` | Query retrieves source evidence that appears after the old blind character-truncation point | Token-aware Tree-sitter splitting of oversized real source chunks |
| `adv.target.embedding.no-silent-truncation` | Real source chunks are structurally split or explicitly marked as fallback-truncated | Embedding-input diagnostics with token counts, split counts, and truncation fallback counts |
| `adv.target.embedding.length-aware-batching` | Jina provider batches do not pad short inputs behind unrelated long inputs | Token telemetry plus length-aware batch grouping, with unchanged input text and chunk-to-vector assignment |

### Rallly adversarial extensions

| Gate | Capability | Implementation |
| --- | --- | --- |
| `rallly.adv.target.ast.route-completeness` | Every external import + containing-declaration metadata | AST extractor completeness for variable + statement-level facts |
| `rallly.adv.target.ast.mutation-chain` | Full member-chain `receiver`/`propertyName` | Member-call extractor precision |
| `rallly.adv.target.ast.dual-export` | Named + default export with shared local name | Dual-export fact emission |
| `rallly.adv.target.ast.mock-target` | `vi.mock('./route', ...)` specifier preserved | Same as `adv.target.ast.mock-call` |
| `rallly.adv.target.ast.async-handler-decl` | Async handlers as `VariableFunction` | Declaration kind precision for `const x = async (...) => {}` |
| `rallly.adv.target.ast.dynamic-import-specifier` | `import('./admin-page')` specifier preservation | Dynamic import precision |
| `rallly.adv.target.graph.member-chain-precision` | createPoll → prisma with full evidence triple | Tight evidence: scip + tree-sitter-member-call + module-resolution |
| `rallly.adv.target.graph.middleware-boundary` | Package-boundary evidence on intra-app boundary | Module-resolution evidence on all cross-package edges |
| `rallly.adv.target.test-linking.mock-rallly` | Mock-derived TESTS edge on real Rallly | Same as synthetic mock test-linking |
| `rallly.adv.target.graph.no-billing-from-mutation` | No phantom path to billing | False-positive guard at depth ≤ 4 |
| `rallly.adv.target.test-linking.mock-chain` | Test reaches the deeper mutation via mock-chain | Combined mock + indirect test-linking |
| `rallly.adv.target.graph.next-dynamic` | `next/dynamic` resolves to the imported module | Dynamic import resolution preserved through `dynamic(() => import('./x'))` |
| `rallly.adv.target.query.prisma-callers` | Prisma callers include all mutation files | Implementation of stronger callers query |
| `rallly.adv.target.ranking.route-wiring` | Route → mutation → database ordering | Ranking on real route handler intent |
| `rallly.adv.target.query.middleware-callers` | Middleware callers include the wired route | Implementation of middleware ref discovery |
| `rallly.adv.target.query.qualified-symbol` | createPoll outranks the type CreatePollParams | Symbol type vs value precedence |
| `rallly.adv.target.query.prisma-no-billing-leakage` | References don't leak unrelated billing | False-positive guard |

## Schema/Enum Changes Implied

Some gates require widening or adding to existing enums. Codex must extend types deliberately rather than working around them.

- `SourceExportFact.exportKind` — add `"type"`.
- `SourceDeclarationKind` — add `"Namespace"`, `"Enum"`, `"ClassField"`, `"ClassAccessor"`, `"AmbientModule"`.
- `SourceCallFact.callKind` — add `"tagged-template"`.
- New evidence source strings (no enum, just `metadata.evidenceSources` values): `"super-call"`, `"this-call"`, `"type-use"` (already present in synthetic graph cases, ensure consistent emission), `"tagged-template"`, `"bind-call-apply"`, `"side-effect"`, `"conditional-exports"`, `"dynamic-template"`, `"unresolved"`, `"mock"`, `"snapshot"`, `"ambient-module"`.
- Stable node IDs for ambient modules, anonymous default exports, and enum members.

## Failure Class Mapping

Every adversarial case carries a `failureClassHint`. The summary report aggregates by failure class so Codex can attack the largest red bar first:

- `chunking` / `discovery` — AST coverage gaps
- `scip` / `fusion` — module resolution and symbol promotion
- `graph` / `graph-edge` / `graph-traversal` / `graph-evidence` — edge semantics and traversal
- `test-linking` — TESTS edges with the right evidence
- `query` / `ranking` — surface presentation
- `embedding` — semantic recall, embedding-input telemetry, length-aware batching, or chunk text capture
- `chunking` / `discovery` with embedding gates — source capture or artifact-exclusion failures before the vector layer

## Working Cadence

1. Codex runs both adversarial packs in a hash-provider session. Records baseline gate counts.
2. Pick the failure class with the largest blocking-adjacent count. Resolve gates in that class.
3. Re-run. New failures in adjacent classes are expected (e.g., adding namespace declarations may surface stale namespace ranking).
4. When a layer is consistently green across hash AND Jina runs, graduate its gates from `target` to `required` in the pack JSON and add a pinned regression test in `tests/integration/` or `tests/unit/`.
5. Claude appends new adversarial cases when Codex's improvements expose adjacent gaps. New cases enter as `target`.

For `workstream:jina-tree-sitter-embedding-input-hardening`, author truncation-loss target cases before changing structural splitting. A valid red phase shows the current implementation misses source evidence after the old truncation point or ranks generated artifacts above raw source. The green phase must pass those target cases with Jina without weakening existing required gates.

Implementation status as of 2026-05-21 23:33 CDT: the pack includes `adv.target.embedding.after-truncation-signal`, which places the relevant source evidence after the former 6k character embedding cutoff and adds a `.vercel` generated-artifact decoy. The green Jina and hash runs both pass required 46/46, target 45/45, and scoreboard 5/5; the new target ranks raw source first and keeps the `.vercel` decoy out of the top results.

## 2026-05-16 Implementation Result

The adversarial packs were committed before implementation work started:

- `05d1bff test: add adversarial eval packs` in `local-tools/code-intel`
- `f9e3b33 docs: add adversarial eval handoff` in `local-doc/code-intelligence-graph`

Those historical commits predate the standalone local repo move. Current eval packs live under `eval-packs/`, and these docs live under `docs/` in the `code-intel` repo.

The implementation now passes the authored target and scoreboard gates without weakening the eval-pack case files. No adversarial gate status was graduated from `target` to `required` in this pass, so the pack status mix remains unchanged.

Final adversarial gate evidence:

| Pack | Provider | Status | Blocking | Quality | Gate Counts |
| --- | --- | --- | --- | --- | --- |
| `js-ts-adversarial` | `hash` | pass | pass | pass | target 73/73, scoreboard 5/5 |
| `js-ts-adversarial` | `jina` | pass | pass | pass | target 73/73, scoreboard 5/5 |
| `oss-rallly-adversarial` | `hash` | pass | pass | pass | target 17/17 |
| `oss-rallly-adversarial` | `jina` | pass | pass | pass | target 17/17 |

The hardening work covered the intended implementation surface:

- AST extraction now covers the adversarial enum/type widening: `SourceExportFact.exportKind="type"`, `SourceDeclarationKind` values for namespaces, enums, class fields/accessors, and ambient modules, plus `SourceCallFact.callKind="tagged-template"`.
- Graph metadata now emits the new evidence strings exercised by the packs: `super-call`, `this-call`, `type-use`, `tagged-template`, `bind-call-apply`, `side-effect`, `conditional-exports`, `dynamic-template`, `unresolved`, `mock`, `snapshot`, and `ambient-module`.
- Relationship mapping now resolves side-effect imports, conditional exports, dynamic-template unresolved imports, package dependencies, ambient imports, anonymous defaults, super/this/member calls, bind/call/apply, type-use, enum/namespace members, mock and snapshot `TESTS`, and Rallly app-flow paths.
- Query/ranking now handles caller, imports, path-fragment, negative-intent, snapshot-test, same-name disambiguation, source-over-mock implementation preference, and graph-backed app-flow ranking.
- `tests/integration/adversarial-eval.test.ts` pins the synthetic adversarial pack as an in-process regression against the hash provider, while the external Rallly adversarial pack remains an on-demand CLI validation because it fetches and indexes a pinned OSS checkout.

Additional regression and compatibility fixes from the verification loop:

- Exact-ID symbol lookup now resolves the exact node before broad text search so MCP `get_symbol` cannot return a nearby alias.
- Plain symbol reference queries no longer search all metadata by default, which avoids broad seed pollution for names like `GivingSummary`.
- Test-case facts preserve raw suite-title `parentName` for eval compatibility, while ownership facts resolve that raw title to the canonical suite fact name.
- Function-valued variable extraction distinguishes exported middleware or route factory calls from ordinary local collection transforms like `array.map(...)`.

## 2026-05-17 Hardening Pass

The adversarial gates that previously accepted `anyOf` evidence were tightened to `allOf` against the AST-derived tags so SCIP-only resolution can no longer mask a missing implementation. The synthetic regression test was rebuilt to pin individual facts, edges, and false-positive guards rather than aggregate pass counts.

### Tightened gates

| Gate | Before | After |
| --- | --- | --- |
| `adv.target.graph.super-call` | `anyOf: [scip-typescript, super-call, tree-sitter-member-call]` | `allOf: [super-call, tree-sitter-member-call]` |
| `adv.target.graph.this-call` (both `start→normalize` and `start→prefix` cases) | `anyOf: [scip-typescript, this-call, tree-sitter-member-call]` | `allOf: [this-call, tree-sitter-member-call]` |
| `adv.target.graph.interface-extends` | `anyOf: [scip-typescript, type-relationship]` | `allOf: [type-relationship, tree-sitter-declaration]` |
| `adv.target.graph.interface-extends-path` | `anyOf: [scip-typescript, type-relationship]` | `allOf: [type-relationship]` |
| `adv.target.graph.multi-implements` | `anyOf: [scip-typescript, type-relationship]` | `allOf: [type-relationship, tree-sitter-declaration]` |
| `adv.target.graph.bind-call-apply` | `anyOf: [scip-typescript, bind-call-apply, tree-sitter-member-call]` | `allOf: [bind-call-apply, tree-sitter-member-call]` |
| `adv.target.graph.tagged-template` | `anyOf: [scip-typescript, tagged-template, tree-sitter-call]` | `allOf: [tagged-template, tree-sitter-call]` |

All tightened gates still pass against both providers, proving the AST-derived evidence emission paths fire on the adversarial corpus rather than being silently shadowed by SCIP.

A sibling tightening on `rallly.adv.target.test-linking.mock-rallly` (`anyOf → allOf [mock, tree-sitter-test]`) was tried and reverted: on the real Rallly checkout the `mock` and `tree-sitter-test` evidence land on distinct edge records (file-level vs symbol-level), so `allOf` was over-strict. The synthetic mock gate already enforces the strict combination on the same edge; the Rallly gate retains its original `anyOf` strictness.

### Eval Runner Semantic Contracts

Two semantic shifts in the implementation surface that future case authors and reviewers must understand:

#### `src/eval/query-case.ts` — duplicate-expectation matching

When a single query case lists the same `(file, symbol, kind)` triple in both `expected` and `notExpected` with different `maxRank` values (e.g., expected at rank 1, not-expected at rank 2 — the canonical "exactly one" pattern), the runner now consumes matches sequentially. The first match against that triple is awarded to the `expected` entry; the `notExpected` entry checks the next match.

Without this, any gate of the shape "X must appear at rank 1 and must NOT appear at rank ≤ 2" was logically unfailable — the rank-1 occurrence trivially satisfied notExpected too. The change is implemented via a `skipMatches` count passed only to `notExpected` evaluation, computed by `matchingExpectedCount`.

Implication for case authors: when both arrays reference the same triple, the intent is "exactly one match in this region." Distinct triples evaluate independently, unchanged.

#### `getCallers` and `getCallees` — transitive results

These query methods now return transitive results in addition to direct callers/callees. Transitive results carry `metadata.relationship === "transitive-call"` and `evidenceSources` containing `transitive-call`. Direct results are unchanged in identity but the result set is larger.

This was required by `rallly.adv.target.query.prisma-callers` and the synthetic `adv.query.callers-multiply-via-bind-call-apply` so that real-world impact analysis can surface callers across one indirection. Consumers that need direct-only callees must filter by `metadata.relationship !== "transitive-call"` or check the evidence sources.

### Direct regression pins

`tests/integration/adversarial-eval.test.ts` was expanded from 39 lines (aggregate-only) to 29 specific tests across four `describe` blocks:

- **AST fact pins (12)**: inline-type-specifier import split, type re-export `exportKind`, namespace and enum declaration kinds, private-field declarations, anonymous default flag, side-effect import kind, super-call/this-call receiver fields, tagged-template callKind, vi.mock memberPath, dynamic-template specifier preservation.
- **Graph edge & evidence pins (12)**: super-call/this-call/bind-call-apply/tagged-template CALLS with their AST evidence; EXTENDS between interfaces with type-relationship; multi-implements coverage; side-effect IMPORTS evidence; DEPENDS_ON Package edges via package-json; mock and snapshot TESTS evidence; type-position REFERENCES with type-use evidence.
- **False-positive guards (5)**: side-effect import has no CALLS; story file has no TESTS edges; orphan mock has no phantom TESTS edges; cyclic re-export does not create self-loop REFERENCES; recursive type does not create self-loop REFERENCES.
- **Aggregate sanity (1)**: full eval suite still pass for blocking, quality, all gate-status `failed === 0`.

These pins query the in-process graph repository directly. A future change that loosens a `requireEvidence` clause in the case JSON would not silently weaken coverage because the regression test checks the underlying edge metadata independently of the eval runner.

### Graduation history

The following gates were graduated from `target` to `required` after they (a) passed under tightened evidence requirements on both hash and Jina providers, and (b) gained a direct vitest regression pin in `tests/integration/adversarial-eval.test.ts`.

| Gate ID | Layer | Capability | Regression test |
| --- | --- | --- | --- |
| `adv.target.ast.inline-type-specifier` | AST | type-only-import-specifier | inline-type-specifier separates type and value bindings |
| `adv.target.ast.type-reexport` | AST | type-only-export | export type from emits exportKind=type |
| `adv.target.ast.namespace-decls` | AST | ts-namespace-extraction | TS namespace declarations emit kind=Namespace |
| `adv.target.ast.enum-decls` | AST | ts-enum-extraction | TS enums emit kind=Enum with member ownership |
| `adv.target.ast.private-fields` | AST | private-fields-and-static-blocks | private class fields recorded as ClassField declarations |
| `adv.target.ast.anonymous-default` | AST | anonymous-default-export | anonymous default export carries defaultExport=true |
| `adv.target.ast.side-effect-import` | AST | side-effect-import-kind | side-effect import recorded with importKind=side-effect |
| `adv.target.ast.super-call` | AST | super-call-extraction | super.method() records receiver=super |
| `adv.target.ast.this-call` | AST | this-call-extraction | this.method() inside a class records receiver=this |
| `adv.target.ast.tagged-template` | AST | tagged-template-as-call | tagged template literal records callKind=tagged-template |
| `adv.target.ast.mock-call` | AST | mock-target-extraction | vi.mock records the mocked specifier |
| `adv.target.ast.dynamic-template` | AST | dynamic-import-template | dynamic template import preserves specifier |
| `adv.target.graph.super-call` | graph | super-call-resolution | CALLS ChildService.greet→BaseService.greet with super-call evidence |
| `adv.target.graph.this-call` | graph | this-call-resolution | CALLS SelfDispatcher.start→.normalize with this-call evidence |
| `adv.target.graph.bind-call-apply` | graph | bind-call-apply-target | CALLS callInvoker→multiply with bind-call-apply evidence |
| `adv.target.graph.tagged-template` | graph | tagged-template-call | CALLS runTagged→html with tagged-template evidence |
| `adv.target.graph.interface-extends` | graph | interface-extends-interface | EXTENDS Timed→Identified with type-relationship evidence |
| `adv.target.graph.multi-implements` | graph | multiple-implements | IMPLEMENTS edges from AuditedRecord cover both interfaces |
| `adv.target.graph.side-effect-import` | graph | side-effect-import-edge | IMPORTS side-effect-host→polyfills with side-effect evidence |
| `adv.target.graph.side-effect-no-calls` | graph | false-positive-guard | side-effect import does not create CALLS edge |
| `adv.target.graph.package-depends-on` | graph | package-dependency-edges | DEPENDS_ON @adv/dispatch→@adv/syntax via package-json |
| `adv.target.graph.type-position-reference` | graph | type-position-reference | REFERENCES PayloadKeys→InlineTypePayload with type-use evidence |
| `adv.target.graph.cyclic-reexport` | graph | cyclic-reexport-safety | cyclic re-export does not produce same-symbol loop |
| `adv.target.graph.recursive-type` | graph | false-positive-guard | recursive type does not produce self-loop REFERENCES |
| `adv.target.test-linking.mock` | test-linking | mock-derived-test-link | TESTS mocked.test.ts→mockedTarget with mock evidence |
| `adv.target.test-linking.snapshot` | test-linking | snapshot-test-evidence | TESTS snapshot.test.ts→snapshotTarget with snapshot evidence |
| `adv.target.test-linking.storybook-not-tests` | test-linking | false-positive-guard | Storybook story file does not produce TESTS edges |
| `adv.target.test-linking.orphan-mock-false-positive` | test-linking | false-positive-guard | orphan mock does not produce phantom TESTS edges |

Graduated gates remain in the case JSON with `status: "required"`. They must continue to pass on every adversarial run; a regression flips both the eval `blockingStatus` AND the corresponding direct vitest assertion, leaving two independent signals of breakage.

## 2026-05-18 Type Precision Hardening

The type-precision track is now a dedicated required regression surface inside `js-ts-adversarial`, backed by new fixtures under `packages/syntax/src/type-precision*.ts` and `packages/syntax/src/merged-declarations.ts`.

The track adds direct AST, graph, and query gates for:

- Type alias dependencies across type-only imports.
- Generic constraints, defaults, and instantiations.
- Mapped, conditional, indexed-access, `keyof`, and `typeof` type-position references.
- Type-only imports and re-exports.
- Enum member precision for `Severity.Error` without cross-talk from `Severity.Info`.
- Namespace/member ownership for merged interface and namespace declarations.
- Recursive/self-reference false-positive guards.

The implementation added `typeReferences` to persisted Tree-sitter file facts and emits `REFERENCES` edges with `tree-sitter-type-reference` plus `type-use` evidence when the AST proves a type-position dependency. Query seeding now prefers exact qualified symbol metadata before broad text matching, which lets `Severity.Error` resolve to the enum member rather than the enum container.

Red-phase evidence was captured before the implementation: the focused integration run failed because `typeReferences` were absent and the new graph edges lacked `tree-sitter-type-reference` evidence, and an old-dist hash eval failed the new required type-precision gates after schema setup was corrected. Current hash and Jina validation both pass `js-ts-adversarial` with required 44/44, target 44/44, and scoreboard 5/5. `js-ts-general` also passes required 33/33 under both hash and Jina.

## 2026-05-18 MCP Agent-Readiness Track

MCP agent readiness is now a dedicated required regression surface inside `js-ts-adversarial`, backed by `cases/mcp-agent-readiness.json`. The case runs a real `@modelcontextprotocol/sdk` stdio client against the built `code-intel mcp` command after the eval harness indexes the adversarial corpus.

The MCP case asserts that an agent can run a realistic chain from `workspace_overview` and `health` through `semantic_search`, `find_symbol`, `get_references`, `get_callers`, `get_callees`, `get_relationships`, `trace_path`, `diagnose_file`, `diagnose_symbol`, invalid input handling, and bounded `get_context`. It requires every listed tool to advertise `outputSchema`, every successful call to return `structuredContent` matching the text payload, relationship results to carry evidence, trace results to carry path edges, semantic results to carry ranking reasons, non-context tools to avoid source excerpts, and context excerpts to stay bounded.

The implementation added MCP `outputSchema`/`structuredContent`, `diagnose_file`, `diagnose_symbol`, and `get_relationships`. The eval harness now supports `mcpCaseFiles` and reports MCP workflow results alongside query, AST, and graph cases. Current hash and Jina validation pass `js-ts-adversarial` with required 45/45, target 44/44, scoreboard 5/5, and 94/94 total.

## 2026-05-18 CLI/MCP Parity Track

CLI/MCP parity is now a dedicated required regression surface inside `js-ts-adversarial`, backed by `cases/cli-mcp-parity.json`. The case runs the built CLI with `--json` and an `@modelcontextprotocol/sdk` stdio client against the same indexed adversarial corpus, then compares normalized results step by step.

The parity case asserts that `semantic`, `find-symbol`, `relationships`, `trace-path`, `diagnose file`, `diagnose symbol`, invalid input handling, and bounded `get-context` stay equivalent to MCP `semantic_search`, `find_symbol`, `get_relationships`, `trace_path`, `diagnose_file`, `diagnose_symbol`, and `get_context`. It checks stable IDs, files, symbols, ranking reasons, relationship evidence, path edges, limits, diagnostics, absence of source excerpts outside context tools, and bounded source excerpts.

The implementation added the CLI `relationships <seed>` command, TTY query summaries, `cliMcpCaseFiles` eval-pack support, and CLI/MCP parity result reporting. Current hash and Jina validation pass `js-ts-adversarial` with required 46/46, target 44/44, scoreboard 5/5, and 95/95 total.

## Do-Not List

- Do not delete adversarial cases. If a case is wrong, file it as a comment in this doc, then fix the case rather than removing it.
- Do not narrow `requireEvidence` to make a gate pass. Tightening evidence is the goal; weakening it is regression.
- Do not collapse multiple expectations into one. Each `expected` entry exists for a distinct capability.
- Do not move case files out of `eval-packs/*/cases/`. Pack loaders resolve relative paths from each pack's root.
