import type { ChunkSourceFileInput, SourceExportFact, SourceImportFact, TreeSitterNode } from "./types.js";
import {
  children,
  directChild,
  directChildText,
  exportedDeclarationNames,
  factBase,
  hasDirectToken,
  moduleSpecifierForNode,
} from "./node-utils.js";

export function extractImportFacts(input: ChunkSourceFileInput, node: TreeSitterNode): SourceImportFact[] {
  const moduleSpecifier = moduleSpecifierForNode(node);
  if (!moduleSpecifier) {
    return [];
  }
  const clause = directChild(node, "import_clause");
  const statementIsTypeOnly = /^import\s+type\b/.test(node.text);
  if (!clause) {
    return [
      {
        ...factBase(input, node),
        moduleSpecifier,
        importKind: "side-effect",
        isDefault: false,
        isNamespace: false,
      },
    ];
  }

  const facts: SourceImportFact[] = [];
  for (const child of children(clause)) {
    if (child.type === "identifier") {
      facts.push({
        ...factBase(input, child),
        moduleSpecifier,
        importKind: statementIsTypeOnly ? "type" : "value",
        importedName: "default",
        localName: child.text,
        isDefault: true,
        isNamespace: false,
      });
    } else if (child.type === "namespace_import") {
      facts.push(extractNamespaceImport(input, child, moduleSpecifier, statementIsTypeOnly));
    } else if (child.type === "named_imports") {
      facts.push(...extractNamedImports(input, child, moduleSpecifier, statementIsTypeOnly));
    }
  }
  return facts;
}

export function extractExportFacts(input: ChunkSourceFileInput, node: TreeSitterNode): SourceExportFact[] {
  const moduleSpecifier = moduleSpecifierForNode(node);
  const exportClause = directChild(node, "export_clause");
  const namespaceExport = directChild(node, "namespace_export");
  const defaultExport = Boolean(directChildText(node, "default"));

  if (exportClause) {
    return children(exportClause)
      .filter((child) => child.type === "export_specifier")
      .map((specifier) => exportSpecifierFact(input, specifier, moduleSpecifier));
  }
  if (namespaceExport) {
    const exportedName = children(namespaceExport).find((child) => child.type === "identifier")?.text ?? "*";
    return [
      {
        ...factBase(input, namespaceExport),
        exportKind: moduleSpecifier ? "re-export" : "local",
        exportedName,
        localName: "*",
        moduleSpecifier,
      },
    ];
  }
  if (moduleSpecifier && directChildText(node, "*")) {
    return [
      {
        ...factBase(input, node),
        exportKind: "re-export",
        exportedName: "*",
        localName: "*",
        moduleSpecifier,
      },
    ];
  }

  return exportedDeclarationNames(node).map((localName) => ({
    ...factBase(input, node),
    exportKind: defaultExport ? "default" : "local",
    exportedName: defaultExport ? "default" : localName,
    localName,
    moduleSpecifier,
  }));
}

function extractNamespaceImport(
  input: ChunkSourceFileInput,
  node: TreeSitterNode,
  moduleSpecifier: string,
  statementIsTypeOnly: boolean,
): SourceImportFact {
  const localName = children(node).find((candidate) => candidate.type === "identifier")?.text;
  return {
    ...factBase(input, node),
    moduleSpecifier,
    importKind: statementIsTypeOnly ? "type" : "value",
    importedName: "*",
    localName,
    isDefault: false,
    isNamespace: true,
  };
}

function extractNamedImports(
  input: ChunkSourceFileInput,
  node: TreeSitterNode,
  moduleSpecifier: string,
  statementIsTypeOnly: boolean,
): SourceImportFact[] {
  return children(node)
    .filter((candidate) => candidate.type === "import_specifier")
    .flatMap((specifier) => {
      const identifiers = children(specifier).filter((candidate) => candidate.type === "identifier");
      const importedName = identifiers[0]?.text;
      const localName = identifiers.at(-1)?.text;
      if (!importedName) {
        return [];
      }
      return [
        {
          ...factBase(input, specifier),
          moduleSpecifier,
          importKind: statementIsTypeOnly || hasDirectToken(specifier, "type") ? "type" : "value",
          importedName,
          localName,
          isDefault: false,
          isNamespace: false,
        },
      ];
    });
}

function exportSpecifierFact(
  input: ChunkSourceFileInput,
  specifier: TreeSitterNode,
  moduleSpecifier: string | undefined,
): SourceExportFact {
  const identifiers = children(specifier).filter((candidate) => candidate.type === "identifier");
  const localName = identifiers[0]?.text;
  const exportedName = identifiers.at(-1)?.text ?? localName ?? "unknown";
  return {
    ...factBase(input, specifier),
    exportKind: moduleSpecifier ? "re-export" : "local",
    exportedName,
    localName,
    moduleSpecifier,
  };
}
