import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LadybugGraphStore } from "../../src/graph/ladybug-store.js";
import { readActiveIndexFacts } from "../../src/indexer/fact-cache.js";
import { indexWorkspace } from "../../src/indexer/indexer.js";
import { chunkSourceFile } from "../../src/treesitter/chunker.js";

const fixturePath = new URL("../fixtures/js-ts-workspace", import.meta.url).pathname;

type ExtractSourceFileFacts = (input: {
  relativePath: string;
  content: string;
}) => {
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
        expect(ledgerImport).toBeDefined();
        expect(barrelExport).toBeDefined();
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

function callShape(fact: Record<string, unknown>): Record<string, unknown> {
  return {
    containingDeclarationName: fact.containingDeclarationName,
    memberPath: fact.memberPath,
    name: fact.name,
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
