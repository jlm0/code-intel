import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runEvalSuite } from "../../src/eval/evaluator.js";
import { indexWorkspace } from "../../src/indexer/indexer.js";
import { createQueryEngine, type QueryEngine } from "../../src/query/query-engine.js";
import type { CodeEdge, CodeNode } from "../../src/schema/schemas.js";
import { extractSourceFileFacts } from "../../src/treesitter/chunker.js";

const corpusRoot = resolve(__dirname, "../../eval-packs/js-ts-adversarial/corpus");

async function readFacts(relativePath: string) {
  return extractSourceFileFacts({
    relativePath,
    content: await readFile(join(corpusRoot, relativePath), "utf8"),
  });
}

function evidenceSourcesOf(edge: CodeEdge): string[] {
  const sources = new Set<string>();
  const raw = edge.metadata.evidenceSources;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === "string" && entry.length > 0) {
        sources.add(entry);
      }
    }
  }
  if (typeof edge.metadata.origin === "string" && edge.metadata.origin.length > 0) {
    sources.add(edge.metadata.origin);
  }
  return [...sources];
}

function findNode(nodes: CodeNode[], file: string, name: string, kind?: CodeNode["kind"]): CodeNode | undefined {
  const candidates = nodes.filter((node) =>
    node.file === file &&
    node.name === name &&
    (kind ? node.kind === kind : true),
  );
  if (kind) {
    return candidates[0];
  }
  const canonical = candidates.find((node) => node.kind !== "Chunk" && node.kind !== "Import" && node.kind !== "Export");
  return canonical ?? candidates[0];
}

function findFileNode(nodes: CodeNode[], file: string): CodeNode | undefined {
  return nodes.find((node) => node.kind === "File" && node.file === file);
}

function findPackageNode(nodes: CodeNode[], name: string): CodeNode | undefined {
  return nodes.find((node) => node.kind === "Package" && node.name === name);
}

function edgesBetween(
  edges: CodeEdge[],
  fromId: string | undefined,
  toId: string | undefined,
  kind: CodeEdge["kind"],
): CodeEdge[] {
  if (!fromId || !toId) {
    return [];
  }
  return edges.filter((edge) => edge.kind === kind && edge.fromId === fromId && edge.toId === toId);
}

describe("adversarial eval — direct AST fact pins", () => {
  it("inline-type-specifier separates type and value bindings on a mixed import", async () => {
    const facts = await readFacts("packages/syntax/src/inline-type-consumer.ts");
    expect(facts.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          moduleSpecifier: "./inline-type",
          importedName: "InlineTypePayload",
          localName: "InlineTypePayload",
          importKind: "type",
        }),
        expect.objectContaining({
          moduleSpecifier: "./inline-type",
          importedName: "makeInlinePayload",
          localName: "makeInlinePayload",
          importKind: "value",
        }),
      ]),
    );
  });

  it("export type { X } from ... emits exportKind=\"type\"", async () => {
    const facts = await readFacts("packages/syntax/src/type-reexport.ts");
    const typeReexport = facts.exports.find((entry) => entry.exportedName === "InlineTypePayload");
    expect(typeReexport).toBeDefined();
    expect(typeReexport?.exportKind).toBe("type");
    expect(typeReexport?.moduleSpecifier).toBe("./inline-type");
  });

  it("TS namespace declarations emit kind=\"Namespace\" with qualified nested names", async () => {
    const facts = await readFacts("packages/syntax/src/namespace-enum.ts");
    const namespaceNames = facts.declarations
      .filter((declaration) => declaration.kind === "Namespace")
      .map((declaration) => declaration.qualifiedName);
    expect(namespaceNames).toEqual(expect.arrayContaining(["FileStatus", "FileStatus.Filters"]));
  });

  it("TS enums emit kind=\"Enum\" with member ownership", async () => {
    const facts = await readFacts("packages/syntax/src/namespace-enum.ts");
    const enumNames = facts.declarations
      .filter((declaration) => declaration.kind === "Enum")
      .map((declaration) => declaration.qualifiedName);
    expect(enumNames).toEqual(expect.arrayContaining(["Severity", "FastFlag"]));
    expect(facts.ownerships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ownerName: "Severity", childName: "Info" }),
        expect.objectContaining({ ownerName: "FastFlag", childName: "On" }),
      ]),
    );
  });

  it("private class fields are recorded as ClassField declarations", async () => {
    const facts = await readFacts("packages/syntax/src/private-fields.ts");
    const fieldNames = facts.declarations
      .filter((declaration) => declaration.kind === "ClassField")
      .map((declaration) => declaration.qualifiedName);
    expect(fieldNames).toEqual(
      expect.arrayContaining([
        "CountingCache.#instances",
        "CountingCache.#hits",
        "CountingCache.#store",
      ]),
    );
  });

  it("anonymous default export carries defaultExport=true", async () => {
    const facts = await readFacts("packages/modules/src/anonymous-default.ts");
    const anonymous = facts.declarations.find((declaration) => declaration.defaultExport);
    expect(anonymous).toBeDefined();
    expect(anonymous?.kind).toBe("Function");
    expect(anonymous?.exported).toBe(true);
  });

  it("side-effect import is recorded with importKind=\"side-effect\"", async () => {
    const facts = await readFacts("packages/modules/src/side-effect-host.ts");
    const sideEffect = facts.imports.find((entry) => entry.moduleSpecifier === "./polyfills");
    expect(sideEffect).toBeDefined();
    expect(sideEffect?.importKind).toBe("side-effect");
  });

  it("super.method() call records receiver=\"super\"", async () => {
    const facts = await readFacts("packages/dispatch/src/child-override.ts");
    const superGreet = facts.calls.find((call) =>
      call.propertyName === "greet" &&
      call.receiver === "super",
    );
    expect(superGreet).toBeDefined();
  });

  it("this.method() inside a class records receiver=\"this\"", async () => {
    const facts = await readFacts("packages/dispatch/src/self-dispatch.ts");
    const thisCalls = facts.calls.filter((call) => call.receiver === "this");
    const propertyNames = thisCalls.map((call) => call.propertyName);
    expect(propertyNames).toEqual(expect.arrayContaining(["normalize", "prefix"]));
  });

  it("tagged template literal records callKind=\"tagged-template\"", async () => {
    const facts = await readFacts("packages/dispatch/src/tagged-templates.ts");
    const taggedCallNames = facts.calls
      .filter((call) => call.callKind === "tagged-template")
      .map((call) => call.name);
    expect(taggedCallNames).toEqual(expect.arrayContaining(["html", "sqlTemplate"]));
  });

  it("vi.mock call records the mocked specifier", async () => {
    const facts = await readFacts("packages/testing/src/__tests__/mocked.test.ts");
    const mockCall = facts.calls.find((call) =>
      call.propertyName === "mock" && call.receiver === "vi",
    );
    expect(mockCall).toBeDefined();
    expect(mockCall?.memberPath).toBe("vi.mock");
  });

  it("dynamic template import preserves the template-shaped specifier", async () => {
    const facts = await readFacts("packages/modules/src/dynamic-template.ts");
    const dynamicTemplate = facts.imports.find((entry) =>
      entry.importKind === "dynamic" && entry.moduleSpecifier.includes("${lang}"),
    );
    expect(dynamicTemplate).toBeDefined();
  });
});

describe("adversarial eval — graph edge and evidence pins", () => {
  let engine: QueryEngine;
  let indexPath: string;
  let nodes: CodeNode[];
  let edges: CodeEdge[];

  beforeAll(async () => {
    indexPath = await mkdtemp(join(tmpdir(), "code-intel-adv-regression-"));
    await indexWorkspace({
      workspaceRoot: corpusRoot,
      repoPaths: [corpusRoot],
      indexPath,
      embeddingProviderName: "hash",
    });
    engine = createQueryEngine({ indexPath });
    const repository = engine.getRepository();
    nodes = await repository.getNodes();
    edges = await repository.getEdges();
  }, 180_000);

  afterAll(async () => {
    await engine?.close();
    if (indexPath) {
      await rm(indexPath, { recursive: true, force: true });
    }
  });

  it("CALLS edge from ChildService.greet to BaseService.greet carries super-call evidence", () => {
    const fromNode = findNode(nodes, "packages/dispatch/src/child-override.ts", "greet");
    const toNode = findNode(nodes, "packages/dispatch/src/base-service.ts", "greet");
    const matches = edgesBetween(edges, fromNode?.id, toNode?.id, "CALLS");
    expect(matches.length).toBeGreaterThan(0);
    const evidence = matches.flatMap(evidenceSourcesOf);
    expect(evidence).toContain("super-call");
    expect(evidence).toContain("tree-sitter-member-call");
  });

  it("CALLS edge from SelfDispatcher.start to .normalize carries this-call evidence", () => {
    const fromNode = findNode(nodes, "packages/dispatch/src/self-dispatch.ts", "start");
    const toNode = findNode(nodes, "packages/dispatch/src/self-dispatch.ts", "normalize");
    const matches = edgesBetween(edges, fromNode?.id, toNode?.id, "CALLS");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.flatMap(evidenceSourcesOf)).toContain("this-call");
  });

  it("CALLS edge from callInvoker to multiply carries bind-call-apply evidence", () => {
    const fromNode = findNode(nodes, "packages/dispatch/src/bind-call-apply.ts", "callInvoker");
    const toNode = findNode(nodes, "packages/dispatch/src/bind-call-apply.ts", "multiply");
    const matches = edgesBetween(edges, fromNode?.id, toNode?.id, "CALLS");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.flatMap(evidenceSourcesOf)).toContain("bind-call-apply");
  });

  it("CALLS edge from runTagged to html carries tagged-template evidence", () => {
    const fromNode = findNode(nodes, "packages/dispatch/src/tagged-templates.ts", "runTagged");
    const toNode = findNode(nodes, "packages/dispatch/src/tagged-templates.ts", "html");
    const matches = edgesBetween(edges, fromNode?.id, toNode?.id, "CALLS");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.flatMap(evidenceSourcesOf)).toContain("tagged-template");
  });

  it("EXTENDS edge between Timed and Identified interfaces with type-relationship evidence", () => {
    const fromNode = findNode(nodes, "packages/dispatch/src/interface-hierarchy.ts", "Timed");
    const toNode = findNode(nodes, "packages/dispatch/src/interface-hierarchy.ts", "Identified");
    const matches = edgesBetween(edges, fromNode?.id, toNode?.id, "EXTENDS");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.flatMap(evidenceSourcesOf)).toContain("type-relationship");
  });

  it("IMPLEMENTS edges from AuditedRecord cover both Audited and Versioned", () => {
    const from = findNode(nodes, "packages/dispatch/src/interface-hierarchy.ts", "AuditedRecord");
    const auditedTarget = findNode(nodes, "packages/dispatch/src/interface-hierarchy.ts", "Audited");
    const versionedTarget = findNode(nodes, "packages/dispatch/src/interface-hierarchy.ts", "Versioned");
    expect(edgesBetween(edges, from?.id, auditedTarget?.id, "IMPLEMENTS")).not.toHaveLength(0);
    expect(edgesBetween(edges, from?.id, versionedTarget?.id, "IMPLEMENTS")).not.toHaveLength(0);
  });

  it("IMPORTS edge from side-effect host to polyfills carries side-effect evidence", () => {
    const fromFile = findFileNode(nodes, "packages/modules/src/side-effect-host.ts");
    const toFile = findFileNode(nodes, "packages/modules/src/polyfills.ts");
    const matches = edgesBetween(edges, fromFile?.id, toFile?.id, "IMPORTS");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.flatMap(evidenceSourcesOf)).toContain("side-effect");
  });

  it("DEPENDS_ON edge connects @adv/dispatch package to @adv/syntax via package-json", () => {
    const dispatch = findPackageNode(nodes, "@adv/dispatch");
    const syntax = findPackageNode(nodes, "@adv/syntax");
    const matches = edgesBetween(edges, dispatch?.id, syntax?.id, "DEPENDS_ON");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.flatMap(evidenceSourcesOf)).toContain("package-json");
  });

  it("TESTS edge from mocked.test.ts to mockedTarget carries mock evidence", () => {
    const testFile = findFileNode(nodes, "packages/testing/src/__tests__/mocked.test.ts");
    const target = findNode(nodes, "packages/testing/src/mocked-target.ts", "mockedTarget");
    const matches = edgesBetween(edges, testFile?.id, target?.id, "TESTS");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.flatMap(evidenceSourcesOf)).toContain("mock");
  });

  it("TESTS edge from snapshot.test.ts to snapshotTarget carries snapshot evidence", () => {
    const testFile = findFileNode(nodes, "packages/testing/src/__tests__/snapshot.test.ts");
    const target = findNode(nodes, "packages/testing/src/snapshot-target.ts", "snapshotTarget");
    const matches = edgesBetween(edges, testFile?.id, target?.id, "TESTS");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.flatMap(evidenceSourcesOf)).toContain("snapshot");
  });

  it("type-position REFERENCES from PayloadKeys to InlineTypePayload carry type-use evidence", () => {
    const fromNode = findNode(nodes, "packages/syntax/src/conditional-types.ts", "PayloadKeys");
    const toNode = findNode(nodes, "packages/syntax/src/inline-type.ts", "InlineTypePayload");
    const matches = edgesBetween(edges, fromNode?.id, toNode?.id, "REFERENCES");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.flatMap(evidenceSourcesOf)).toContain("type-use");
  });
});

describe("adversarial eval — false-positive guards", () => {
  let engine: QueryEngine;
  let indexPath: string;
  let nodes: CodeNode[];
  let edges: CodeEdge[];

  beforeAll(async () => {
    indexPath = await mkdtemp(join(tmpdir(), "code-intel-adv-guards-"));
    await indexWorkspace({
      workspaceRoot: corpusRoot,
      repoPaths: [corpusRoot],
      indexPath,
      embeddingProviderName: "hash",
    });
    engine = createQueryEngine({ indexPath });
    const repository = engine.getRepository();
    nodes = await repository.getNodes();
    edges = await repository.getEdges();
  }, 180_000);

  afterAll(async () => {
    await engine?.close();
    if (indexPath) {
      await rm(indexPath, { recursive: true, force: true });
    }
  });

  it("side-effect import does NOT create a CALLS edge", () => {
    const fromFile = findFileNode(nodes, "packages/modules/src/side-effect-host.ts");
    const toFile = findFileNode(nodes, "packages/modules/src/polyfills.ts");
    expect(edgesBetween(edges, fromFile?.id, toFile?.id, "CALLS")).toHaveLength(0);
  });

  it("Storybook story file does NOT TESTS its underlying component", () => {
    const story = findFileNode(nodes, "packages/testing/src/story-component.stories.tsx");
    const target = findNode(nodes, "packages/testing/src/story-component.tsx", "StoryComponent");
    expect(edgesBetween(edges, story?.id, target?.id, "TESTS")).toHaveLength(0);
  });

  it("Orphan mock to a non-existent specifier does NOT create a TESTS edge to mocked-target", () => {
    const orphan = findFileNode(nodes, "packages/testing/src/orphan-mock.test.ts");
    const realTarget = findNode(nodes, "packages/testing/src/mocked-target.ts", "mockedTarget");
    expect(edgesBetween(edges, orphan?.id, realTarget?.id, "TESTS")).toHaveLength(0);
  });

  it("Cyclic re-export does not produce a same-symbol REFERENCES loop", () => {
    const symbol = findNode(nodes, "packages/modules/src/cyclic-a.ts", "cyclicFromA");
    expect(edgesBetween(edges, symbol?.id, symbol?.id, "REFERENCES")).toHaveLength(0);
  });

  it("Recursive type does not produce a self-loop REFERENCES edge", () => {
    const symbol = findNode(nodes, "packages/syntax/src/recursive.ts", "TreeNode");
    expect(edgesBetween(edges, symbol?.id, symbol?.id, "REFERENCES")).toHaveLength(0);
  });
});

describe("adversarial eval — aggregate sanity", () => {
  it("synthetic adversarial pack still passes every gate end-to-end", async () => {
    const report = await runEvalSuite({
      evalPack: "eval-packs/js-ts-adversarial",
      embeddingProvider: "hash",
    });

    expect(report.blockingStatus).toBe("pass");
    expect(report.qualityStatus).toBe("pass");
    expect(report.summary.gateStatuses.target.failed).toBe(0);
    expect(report.summary.gateStatuses.scoreboard.failed).toBe(0);
    expect(report.summary.gateStatuses.required.failed).toBe(0);

    const failedCaseIds = [
      ...report.astCases,
      ...report.graphCases,
      ...report.cases,
    ]
      .filter((testCase) => testCase.status === "fail")
      .map((testCase) => testCase.id);
    expect(failedCaseIds).toEqual([]);
  }, 180_000);
});
