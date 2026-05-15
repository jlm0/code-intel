import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveActiveGenerationPath } from "../../src/core/index-artifacts.js";
import { LadybugGraphStore } from "../../src/graph/ladybug-store.js";
import { readActiveIndexFacts } from "../../src/indexer/fact-cache.js";
import { indexWorkspace } from "../../src/indexer/indexer.js";
import { chunkSourceFile } from "../../src/treesitter/chunker.js";

const fixturePath = new URL("../fixtures/js-ts-workspace", import.meta.url).pathname;

type ExtractSourceFileFacts = (input: {
  relativePath: string;
  content: string;
}) => {
  language: string;
  chunks: Array<{ idSuffix: string; name: string; kind: string; calls: string[] }>;
  imports: Array<Record<string, unknown>>;
  exports: Array<Record<string, unknown>>;
  declarations: Array<Record<string, unknown>>;
  calls: Array<Record<string, unknown>>;
  memberAccesses: Array<Record<string, unknown>>;
  ownerships: Array<Record<string, unknown>>;
  testCases: Array<Record<string, unknown>>;
  callbacks: Array<Record<string, unknown>>;
  hasParseError: boolean;
};

const structuralSource = `import defaultWidget, * as widgetApi from "@fixture/widgets";
import { calculateGivingTotal as total, type GivingEntry } from "@fixture/core";
import "./polyfill";

export { createLedger as makeLedger } from "./ledger";
export { default as LegacyWidget } from "./legacy";

export default function DefaultWidget() {
  return widgetApi.createWidget(defaultWidget);
}

export const useWidgetSummary = (entries: GivingEntry[]) => {
  const normalized = entries.map((entry) => total([entry]));
  const store = new WidgetStore();
  return store.summarize(normalized);
};

export class WidgetStore {
  summarize(entries: GivingEntry[]) {
    return total(entries);
  }

  render() {
    return DefaultWidget();
  }
}

export const objectRegistry = {
  render() {
    return widgetApi.render();
  },
  build: () => defaultWidget(),
};

describe("WidgetStore", () => {
  it("summarizes entries", () => {
    expect(total([1, 2, 3])).toBe(6);
  });
});
`;

const advancedSyntaxSource = `import React from "react";
import dynamic from "next/dynamic";
import type { LoaderArgs } from "./types";

const legacyWidget = require("./legacy").default;
const { createLegacyThing: createThing } = require("./legacy-utils");
const LazyAdmin = dynamic(() => import("./admin-page").then((mod) => mod.AdminPage));

export * from "./star-source";
export * as adminApi from "./admin-api";
export type { LoaderArgs as AdminLoaderArgs } from "./types";
export { createThing };

@Injectable()
export default class {
  constructor(private readonly client: ApiClient) {}

  @Trace()
  async create() {
    const created = await this.client?.polls?.create?.({ title: "Demo" });
    return new PollCard(created);
  }
}

module.exports = legacyWidget;
exports.namedLegacy = createThing;

export function AdminPageLoader() {
  return (
    <>
      <PollBrandingFromContext />
      <LazyAdmin />
    </>
  );
}
`;

const commonJsSource = `const path = require("node:path");
const { join: joinPath } = require("node:path");

function createLegacyPoll(input) {
  return joinPath(input.base, input.slug);
}

module.exports = {
  createLegacyPoll,
};

exports.namedLegacyPoll = createLegacyPoll;
`;

describe("Tree-sitter structural facts", () => {
  it("extracts deterministic import, export, declaration, call, ownership, and test facts", async () => {
    const extractSourceFileFacts = await loadExtractor();

    const facts = extractSourceFileFacts({
      relativePath: "packages/ui/src/WidgetStore.tsx",
      content: structuralSource,
    });

    expect(facts.imports.map(importShape)).toEqual([
      {
        importKind: "value",
        importedName: "default",
        isDefault: true,
        isNamespace: false,
        localName: "defaultWidget",
        moduleSpecifier: "@fixture/widgets",
      },
      {
        importKind: "value",
        importedName: "*",
        isDefault: false,
        isNamespace: true,
        localName: "widgetApi",
        moduleSpecifier: "@fixture/widgets",
      },
      {
        importKind: "value",
        importedName: "calculateGivingTotal",
        isDefault: false,
        isNamespace: false,
        localName: "total",
        moduleSpecifier: "@fixture/core",
      },
      {
        importKind: "type",
        importedName: "GivingEntry",
        isDefault: false,
        isNamespace: false,
        localName: "GivingEntry",
        moduleSpecifier: "@fixture/core",
      },
      {
        importKind: "side-effect",
        importedName: undefined,
        isDefault: false,
        isNamespace: false,
        localName: undefined,
        moduleSpecifier: "./polyfill",
      },
    ]);

    expect(facts.exports.map(exportShape)).toEqual([
      {
        exportKind: "re-export",
        exportedName: "makeLedger",
        localName: "createLedger",
        moduleSpecifier: "./ledger",
      },
      {
        exportKind: "re-export",
        exportedName: "LegacyWidget",
        localName: "default",
        moduleSpecifier: "./legacy",
      },
      {
        exportKind: "default",
        exportedName: "default",
        localName: "DefaultWidget",
        moduleSpecifier: undefined,
      },
      {
        exportKind: "local",
        exportedName: "useWidgetSummary",
        localName: "useWidgetSummary",
        moduleSpecifier: undefined,
      },
      {
        exportKind: "local",
        exportedName: "WidgetStore",
        localName: "WidgetStore",
        moduleSpecifier: undefined,
      },
      {
        exportKind: "local",
        exportedName: "objectRegistry",
        localName: "objectRegistry",
        moduleSpecifier: undefined,
      },
    ]);

    expect(facts.declarations.map(declarationShape)).toEqual([
      {
        defaultExport: true,
        exported: true,
        kind: "Function",
        name: "DefaultWidget",
        parentName: undefined,
        qualifiedName: "DefaultWidget",
      },
      {
        defaultExport: false,
        exported: true,
        kind: "VariableFunction",
        name: "useWidgetSummary",
        parentName: undefined,
        qualifiedName: "useWidgetSummary",
      },
      {
        defaultExport: false,
        exported: true,
        kind: "Class",
        name: "WidgetStore",
        parentName: undefined,
        qualifiedName: "WidgetStore",
      },
      {
        defaultExport: false,
        exported: false,
        kind: "ClassMethod",
        name: "summarize",
        parentName: "WidgetStore",
        qualifiedName: "WidgetStore.summarize",
      },
      {
        defaultExport: false,
        exported: false,
        kind: "ClassMethod",
        name: "render",
        parentName: "WidgetStore",
        qualifiedName: "WidgetStore.render",
      },
      {
        defaultExport: false,
        exported: true,
        kind: "Object",
        name: "objectRegistry",
        parentName: undefined,
        qualifiedName: "objectRegistry",
      },
      {
        defaultExport: false,
        exported: false,
        kind: "ObjectMethod",
        name: "render",
        parentName: "objectRegistry",
        qualifiedName: "objectRegistry.render",
      },
      {
        defaultExport: false,
        exported: false,
        kind: "ObjectMethod",
        name: "build",
        parentName: "objectRegistry",
        qualifiedName: "objectRegistry.build",
      },
    ]);

    expect(facts.calls.map(callShape)).toEqual(
      expect.arrayContaining([
        {
          containingDeclarationName: "DefaultWidget",
          memberPath: "widgetApi.createWidget",
          name: "createWidget",
        },
        {
          containingDeclarationName: "useWidgetSummary",
          memberPath: "store.summarize",
          name: "summarize",
        },
        {
          containingDeclarationName: "WidgetStore.summarize",
          memberPath: undefined,
          name: "total",
        },
        {
          containingDeclarationName: "objectRegistry.render",
          memberPath: "widgetApi.render",
          name: "render",
        },
        {
          containingDeclarationName: "it summarizes entries",
          memberPath: "expect(total([1, 2, 3])).toBe",
          name: "toBe",
        },
      ]),
    );

    expect(facts.memberAccesses.map(memberShape)).toEqual(
      expect.arrayContaining([
        { containingDeclarationName: "DefaultWidget", path: "widgetApi.createWidget", propertyName: "createWidget" },
        { containingDeclarationName: "useWidgetSummary", path: "store.summarize", propertyName: "summarize" },
        { containingDeclarationName: "objectRegistry.render", path: "widgetApi.render", propertyName: "render" },
      ]),
    );

    expect(facts.ownerships.map(ownershipShape)).toEqual(
      expect.arrayContaining([
        { childName: "WidgetStore.summarize", ownerName: "WidgetStore", relationship: "contains" },
        { childName: "WidgetStore.render", ownerName: "WidgetStore", relationship: "contains" },
        { childName: "objectRegistry.render", ownerName: "objectRegistry", relationship: "contains" },
        { childName: "objectRegistry.build", ownerName: "objectRegistry", relationship: "contains" },
        { childName: "it summarizes entries", ownerName: "describe WidgetStore", relationship: "contains" },
      ]),
    );

    expect(facts.testCases.map(testCaseShape)).toEqual([
      { kind: "Suite", name: "describe WidgetStore", parentName: undefined },
      { kind: "Test", name: "it summarizes entries", parentName: "describe WidgetStore" },
    ]);

    expect(facts.callbacks.map(callbackShape)).toEqual(
      expect.arrayContaining([
        { name: "map callback", parentName: "useWidgetSummary" },
        { name: "it callback", parentName: "it summarizes entries" },
      ]),
    );

    expect(facts.chunks.map((chunk) => ({ kind: chunk.kind, name: chunk.name }))).toEqual(
      expect.arrayContaining([
        { kind: "Test", name: "it summarizes entries" },
        { kind: "Function", name: "useWidgetSummary" },
        { kind: "Function", name: "summarize" },
        { kind: "Function", name: "render" },
      ]),
    );
  });

  it("keeps duplicate method chunk names but gives declarations unique stable provenance", async () => {
    const extractSourceFileFacts = await loadExtractor();
    const filePath = join(fixturePath, "packages/core/src/duplicateMethods.ts");
    const content = await readFile(filePath, "utf8");

    const facts = extractSourceFileFacts({
      relativePath: "packages/core/src/duplicateMethods.ts",
      content,
    });
    const renderDeclarations = facts.declarations
      .filter((declaration) => declaration.name === "render")
      .map(declarationShape);

    expect(renderDeclarations).toEqual([
      {
        defaultExport: false,
        exported: false,
        kind: "ClassMethod",
        name: "render",
        parentName: "PrimaryRenderer",
        qualifiedName: "PrimaryRenderer.render",
      },
      {
        defaultExport: false,
        exported: false,
        kind: "ClassMethod",
        name: "render",
        parentName: "SecondaryRenderer",
        qualifiedName: "SecondaryRenderer.render",
      },
    ]);
    expect(new Set(facts.declarations.map((declaration) => declaration.idSuffix)).size).toBe(
      facts.declarations.length,
    );

    const chunks = chunkSourceFile({
      relativePath: "packages/core/src/duplicateMethods.ts",
      content,
    });
    const renderChunks = chunks.filter((chunk) => chunk.name === "render");
    expect(renderChunks).toHaveLength(2);
    expect(new Set(renderChunks.map((chunk) => chunk.idSuffix)).size).toBe(2);
  });

  it("returns partial syntax facts without losing valid declarations", async () => {
    const extractSourceFileFacts = await loadExtractor();
    const filePath = join(fixturePath, "packages/core/src/broken.ts");
    const content = await readFile(filePath, "utf8");

    const facts = extractSourceFileFacts({
      relativePath: "packages/core/src/broken.ts",
      content,
    });

    expect(facts.hasParseError).toBe(true);
    expect(facts.declarations.map((declaration) => declaration.name)).toContain("partiallyWritten");
    expect(facts.chunks.map((chunk) => chunk.name)).toContain("partiallyWritten");
  });

  it("extracts A-grade JS/TS syntax facts for dynamic imports, CommonJS, decorators, constructors, optional calls, and JSX usage", async () => {
    const extractSourceFileFacts = await loadExtractor();

    const facts = extractSourceFileFacts({
      relativePath: "packages/ui/src/AdminPageLoader.tsx",
      content: advancedSyntaxSource,
    });

    expect(facts.language).toBe("tsx");
    expect(facts.imports.map(importShape)).toEqual(
      expect.arrayContaining([
        {
          importKind: "value",
          importedName: "default",
          isDefault: true,
          isNamespace: false,
          localName: "React",
          moduleSpecifier: "react",
        },
        {
          importKind: "type",
          importedName: "LoaderArgs",
          isDefault: false,
          isNamespace: false,
          localName: "LoaderArgs",
          moduleSpecifier: "./types",
        },
        {
          importKind: "commonjs",
          importedName: "default",
          isDefault: true,
          isNamespace: false,
          localName: "legacyWidget",
          moduleSpecifier: "./legacy",
        },
        {
          importKind: "commonjs",
          importedName: "createLegacyThing",
          isDefault: false,
          isNamespace: false,
          localName: "createThing",
          moduleSpecifier: "./legacy-utils",
        },
        {
          importKind: "dynamic",
          importedName: "default",
          isDefault: true,
          isNamespace: false,
          localName: undefined,
          moduleSpecifier: "./admin-page",
        },
      ]),
    );
    expect(facts.exports.map(exportShape)).toEqual(
      expect.arrayContaining([
        {
          exportKind: "re-export",
          exportedName: "*",
          localName: "*",
          moduleSpecifier: "./star-source",
        },
        {
          exportKind: "re-export",
          exportedName: "adminApi",
          localName: "*",
          moduleSpecifier: "./admin-api",
        },
        {
          exportKind: "re-export",
          exportedName: "AdminLoaderArgs",
          localName: "LoaderArgs",
          moduleSpecifier: "./types",
        },
        {
          exportKind: "default",
          exportedName: "default",
          localName: "default",
          moduleSpecifier: undefined,
        },
        {
          exportKind: "commonjs",
          exportedName: "module.exports",
          localName: "legacyWidget",
          moduleSpecifier: undefined,
        },
        {
          exportKind: "commonjs",
          exportedName: "namedLegacy",
          localName: "createThing",
          moduleSpecifier: undefined,
        },
      ]),
    );
    expect(facts.declarations.map(declarationWithDecoratorsShape)).toEqual(
      expect.arrayContaining([
        {
          decorators: ["@Injectable()"],
          defaultExport: true,
          exported: true,
          kind: "Class",
          name: "default",
          parentName: undefined,
          qualifiedName: "default",
        },
        {
          decorators: [],
          defaultExport: false,
          exported: false,
          kind: "ClassMethod",
          name: "constructor",
          parentName: "default",
          qualifiedName: "default.constructor",
        },
        {
          decorators: ["@Trace()"],
          defaultExport: false,
          exported: false,
          kind: "ClassMethod",
          name: "create",
          parentName: "default",
          qualifiedName: "default.create",
        },
        {
          decorators: [],
          defaultExport: false,
          exported: false,
          kind: "Variable",
          name: "LazyAdmin",
          parentName: undefined,
          qualifiedName: "LazyAdmin",
        },
        {
          decorators: [],
          defaultExport: false,
          exported: true,
          kind: "Function",
          name: "AdminPageLoader",
          parentName: undefined,
          qualifiedName: "AdminPageLoader",
        },
      ]),
    );
    expect(facts.calls.map(callEvidenceShape)).toEqual(
      expect.arrayContaining([
        {
          callKind: "constructor",
          containingDeclarationName: "default.create",
          memberPath: undefined,
          name: "PollCard",
          optionalChain: false,
          propertyName: undefined,
          receiver: undefined,
        },
        {
          callKind: "member",
          containingDeclarationName: "default.create",
          memberPath: "this.client?.polls?.create",
          name: "create",
          optionalChain: true,
          propertyName: "create",
          receiver: "this.client?.polls",
        },
        {
          callKind: "dynamic-import",
          containingDeclarationName: "LazyAdmin",
          memberPath: undefined,
          name: "import",
          optionalChain: false,
          propertyName: undefined,
          receiver: undefined,
        },
        {
          callKind: "jsx",
          containingDeclarationName: "AdminPageLoader",
          memberPath: undefined,
          name: "PollBrandingFromContext",
          optionalChain: false,
          propertyName: undefined,
          receiver: undefined,
        },
        {
          callKind: "jsx",
          containingDeclarationName: "AdminPageLoader",
          memberPath: undefined,
          name: "LazyAdmin",
          optionalChain: false,
          propertyName: undefined,
          receiver: undefined,
        },
      ]),
    );

    const jsFacts = extractSourceFileFacts({
      relativePath: "packages/legacy/src/commonjs.js",
      content: commonJsSource,
    });
    expect(jsFacts.language).toBe("javascript");
    expect(jsFacts.imports.map(importShape)).toEqual(
      expect.arrayContaining([
        {
          importKind: "commonjs",
          importedName: "default",
          isDefault: true,
          isNamespace: false,
          localName: "path",
          moduleSpecifier: "node:path",
        },
        {
          importKind: "commonjs",
          importedName: "join",
          isDefault: false,
          isNamespace: false,
          localName: "joinPath",
          moduleSpecifier: "node:path",
        },
      ]),
    );
    expect(jsFacts.exports.map(exportShape)).toEqual(
      expect.arrayContaining([
        {
          exportKind: "commonjs",
          exportedName: "module.exports",
          localName: undefined,
          moduleSpecifier: undefined,
        },
        {
          exportKind: "commonjs",
          exportedName: "namedLegacyPoll",
          localName: "createLegacyPoll",
          moduleSpecifier: undefined,
        },
      ]),
    );
    expect(jsFacts.declarations.map(declarationWithDecoratorsShape)).toContainEqual({
      decorators: [],
      defaultExport: false,
      exported: false,
      kind: "Function",
      name: "createLegacyPoll",
      parentName: undefined,
      qualifiedName: "createLegacyPoll",
    });
  });

  it("persists structural facts with file facts for incremental reuse", async () => {
    const indexPath = await mkdtemp(join(tmpdir(), "code-intel-ast-facts-"));
    try {
      await indexWorkspace({
        workspaceRoot: fixturePath,
        repoPaths: [fixturePath],
        indexPath,
        embeddingProviderName: "hash",
      });

      const facts = await readActiveIndexFacts(indexPath);
      const ledger = findFileFact(facts, "packages/core/src/ledger.ts");
      const barrel = findFileFact(facts, "packages/core/src/index.ts");
      const testFile = findFileFact(facts, "packages/core/src/tithe.test.ts");

      expect((ledger.imports ?? []).map(importShape)).toContainEqual({
        importKind: "value",
        importedName: "calculateGivingTotal",
        isDefault: false,
        isNamespace: false,
        localName: "calculateGivingTotal",
        moduleSpecifier: "./tithe",
      });
      expect((ledger.declarations ?? []).map(declarationShape)).toEqual(
        expect.arrayContaining([
          {
            defaultExport: false,
            exported: true,
            kind: "Class",
            name: "GivingLedger",
            parentName: undefined,
            qualifiedName: "GivingLedger",
          },
          {
            defaultExport: false,
            exported: false,
            kind: "ClassMethod",
            name: "summarize",
            parentName: "GivingLedger",
            qualifiedName: "GivingLedger.summarize",
          },
        ]),
      );
      expect((barrel.exports ?? []).map(exportShape)).toEqual(
        expect.arrayContaining([
          {
            exportKind: "re-export",
            exportedName: "calculateGivingTotal",
            localName: "calculateGivingTotal",
            moduleSpecifier: "./tithe",
          },
          {
            exportKind: "re-export",
            exportedName: "GivingLedger",
            localName: "GivingLedger",
            moduleSpecifier: "./ledger",
          },
        ]),
      );
      expect((testFile.testCases ?? []).map(testCaseShape)).toContainEqual({
        kind: "Test",
        name: "it calculates giving totals",
        parentName: undefined,
      });

      const generationPath = await resolveActiveGenerationPath(indexPath);
      expect(generationPath).toBeDefined();
      const filesJson = JSON.parse(
        await readFile(join(generationPath!, "facts", "files.json"), "utf8"),
      ) as Record<string, unknown>;
      const embeddingsJson = JSON.parse(
        await readFile(join(generationPath!, "facts", "embeddings.json"), "utf8"),
      ) as { chunks: Array<Record<string, unknown>> };
      expect(filesJson).toMatchObject({
        factsSchemaVersion: "code-intel.facts.v2",
      });
      const storedFiles = filesJson.files as Array<{ chunks: Array<Record<string, unknown>> }>;
      expect(storedFiles.flatMap((file) => file.chunks).some((chunk) => "embedding" in chunk)).toBe(false);
      expect(embeddingsJson).toMatchObject({
        factsSchemaVersion: "code-intel.embeddings.v1",
        embedding: {
          provider: "hash",
        },
      });
      expect(embeddingsJson.chunks.length).toBeGreaterThan(0);

      const store = new LadybugGraphStore(indexPath);
      try {
        const nodes = await store.getNodes();
        const edges = await store.getEdges();
        const ledgerImport = nodes.find(
          (node) =>
            node.kind === "Import" &&
            node.file === "packages/core/src/ledger.ts" &&
            node.metadata.moduleSpecifier === "./tithe",
        );
        const barrelExport = nodes.find(
          (node) =>
            node.kind === "Export" &&
            node.file === "packages/core/src/index.ts" &&
            node.metadata.exportedName === "GivingLedger",
        );
        const summarizeNode = nodes.find(
          (node) =>
            node.kind === "Function" &&
            node.file === "packages/core/src/ledger.ts" &&
            node.metadata.qualifiedName === "GivingLedger.summarize",
        );
        expect(ledgerImport).toBeDefined();
        expect(barrelExport).toBeDefined();
        expect(summarizeNode?.id).toContain("GivingLedger.summarize");
        expect(summarizeNode?.name).toBe("summarize");
        expect(edges).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "IMPORTS", toId: ledgerImport?.id }),
            expect.objectContaining({ kind: "EXPORTS", toId: barrelExport?.id }),
          ]),
        );
      } finally {
        await store.close();
      }
    } finally {
      await rm(indexPath, { recursive: true, force: true });
    }
  });
});

async function loadExtractor(): Promise<ExtractSourceFileFacts> {
  const module = (await import("../../src/treesitter/chunker.js")) as Record<string, unknown>;
  expect(module.extractSourceFileFacts).toBeTypeOf("function");
  return module.extractSourceFileFacts as ExtractSourceFileFacts;
}

function importShape(fact: Record<string, unknown>): Record<string, unknown> {
  return {
    importKind: fact.importKind,
    importedName: fact.importedName,
    isDefault: fact.isDefault,
    isNamespace: fact.isNamespace,
    localName: fact.localName,
    moduleSpecifier: fact.moduleSpecifier,
  };
}

function exportShape(fact: Record<string, unknown>): Record<string, unknown> {
  return {
    exportKind: fact.exportKind,
    exportedName: fact.exportedName,
    localName: fact.localName,
    moduleSpecifier: fact.moduleSpecifier,
  };
}

function declarationShape(fact: Record<string, unknown>): Record<string, unknown> {
  return {
    defaultExport: fact.defaultExport,
    exported: fact.exported,
    kind: fact.kind,
    name: fact.name,
    parentName: fact.parentName,
    qualifiedName: fact.qualifiedName,
  };
}

function declarationWithDecoratorsShape(fact: Record<string, unknown>): Record<string, unknown> {
  return {
    decorators: fact.decorators,
    ...declarationShape(fact),
  };
}

function callShape(fact: Record<string, unknown>): Record<string, unknown> {
  return {
    containingDeclarationName: fact.containingDeclarationName,
    memberPath: fact.memberPath,
    name: fact.name,
  };
}

function callEvidenceShape(fact: Record<string, unknown>): Record<string, unknown> {
  return {
    callKind: fact.callKind,
    ...callShape(fact),
    optionalChain: fact.optionalChain,
    propertyName: fact.propertyName,
    receiver: fact.receiver,
  };
}

function memberShape(fact: Record<string, unknown>): Record<string, unknown> {
  return {
    containingDeclarationName: fact.containingDeclarationName,
    path: fact.path,
    propertyName: fact.propertyName,
  };
}

function ownershipShape(fact: Record<string, unknown>): Record<string, unknown> {
  return {
    childName: fact.childName,
    ownerName: fact.ownerName,
    relationship: fact.relationship,
  };
}

function testCaseShape(fact: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: fact.kind,
    name: fact.name,
    parentName: fact.parentName,
  };
}

function callbackShape(fact: Record<string, unknown>): Record<string, unknown> {
  return {
    name: fact.name,
    parentName: fact.parentName,
  };
}

function findFileFact(
  facts: Awaited<ReturnType<typeof readActiveIndexFacts>>,
  relativePath: string,
): Record<string, Array<Record<string, unknown>>> {
  const fact = facts?.files.find((file) => file.fingerprint.relativePath === relativePath);
  expect(fact).toBeDefined();
  return fact as unknown as Record<string, Array<Record<string, unknown>>>;
}
