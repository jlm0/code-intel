import type { ChunkSourceFileInput, SourceExportFact, SourceImportFact, TreeSitterNode } from "./types.js";
import {
  children,
  directChild,
  directChildText,
  exportedDeclarationNames,
  factBase,
  hasDirectToken,
  moduleSpecifierForCallArgument,
  moduleSpecifierForNode,
  nearestAncestor,
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
  const typeOnlyExport = /^export\s+type\b/.test(node.text);

  if (exportClause) {
    return children(exportClause)
      .filter((child) => child.type === "export_specifier")
      .map((specifier) => exportSpecifierFact(input, specifier, moduleSpecifier, typeOnlyExport));
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

  const declarationNames = exportedDeclarationNames(node);
  if (declarationNames.length > 0) {
    return declarationNames.map((localName) => ({
      ...factBase(input, node),
      exportKind: typeOnlyExport ? "type" : defaultExport ? "default" : "local",
      exportedName: defaultExport ? "default" : localName,
      localName,
      moduleSpecifier,
    }));
  }

  if (defaultExport) {
    const localName = children(node).find((child) => child.type === "identifier")?.text ?? "default";
    return [
      {
        ...factBase(input, node),
        exportKind: "default",
        exportedName: "default",
        localName,
        moduleSpecifier,
      },
    ];
  }

  return [];
}

export function extractDynamicImportFact(
  input: ChunkSourceFileInput,
  node: TreeSitterNode,
): SourceImportFact | undefined {
  if (node.type !== "call_expression" || node.childForFieldName("function")?.text !== "import") {
    return undefined;
  }
  const moduleSpecifier = moduleSpecifierForCallArgument(node);
  if (!moduleSpecifier) {
    return undefined;
  }
  return {
    ...factBase(input, node),
    moduleSpecifier,
    importKind: "dynamic",
    importedName: "default",
    isDefault: true,
    isNamespace: false,
  };
}

export function extractCommonJsImportFacts(
  input: ChunkSourceFileInput,
  node: TreeSitterNode,
  ancestors: TreeSitterNode[],
): SourceImportFact[] {
  if (node.type !== "call_expression" || node.childForFieldName("function")?.text !== "require") {
    return [];
  }
  const moduleSpecifier = moduleSpecifierForCallArgument(node);
  if (!moduleSpecifier) {
    return [];
  }
  const declarator = nearestAncestor(ancestors, "variable_declarator");
  const nameNode = declarator?.childForFieldName("name");
  if (!nameNode) {
    return [
      {
        ...factBase(input, node),
        moduleSpecifier,
        importKind: "commonjs",
        importedName: "default",
        isDefault: true,
        isNamespace: false,
      },
    ];
  }

  if (nameNode.type === "object_pattern") {
    return children(nameNode).flatMap((child) => commonJsPatternImport(input, node, child, moduleSpecifier));
  }

  return [
    {
      ...factBase(input, node),
      moduleSpecifier,
      importKind: "commonjs",
      importedName: "default",
      localName: nameNode.text,
      isDefault: true,
      isNamespace: false,
    },
  ];
}

export function extractCommonJsExportFact(
  input: ChunkSourceFileInput,
  node: TreeSitterNode,
): SourceExportFact | undefined {
  if (node.type !== "assignment_expression") {
    return undefined;
  }
  const left = node.childForFieldName("left") ?? children(node)[0];
  const right = node.childForFieldName("right") ?? children(node).at(-1);
  const leftText = left?.text;
  if (!leftText) {
    return undefined;
  }
  if (leftText === "module.exports") {
    return {
      ...factBase(input, node),
      exportKind: "commonjs",
      exportedName: "module.exports",
      localName: right?.type === "identifier" ? right.text : undefined,
    };
  }
  if (leftText.startsWith("exports.")) {
    return {
      ...factBase(input, node),
      exportKind: "commonjs",
      exportedName: leftText.slice("exports.".length),
      localName: right?.type === "identifier" ? right.text : undefined,
    };
  }
  if (leftText.startsWith("module.exports.")) {
    return {
      ...factBase(input, node),
      exportKind: "commonjs",
      exportedName: leftText.slice("module.exports.".length),
      localName: right?.type === "identifier" ? right.text : undefined,
    };
  }
  return undefined;
}

function commonJsPatternImport(
  input: ChunkSourceFileInput,
  node: TreeSitterNode,
  child: TreeSitterNode,
  moduleSpecifier: string,
): SourceImportFact[] {
  if (child.type === "pair_pattern") {
    const identifiers = children(child).filter(
      (candidate) => candidate.type === "identifier" || candidate.type === "property_identifier",
    );
    const importedName = identifiers[0]?.text;
    const localName = identifiers.at(-1)?.text;
    if (!importedName) {
      return [];
    }
    const base = factBase(input, node);
    return [
      {
        ...base,
        idSuffix: `${base.idSuffix}:${importedName}`,
        moduleSpecifier,
        importKind: "commonjs",
        importedName,
        localName,
        isDefault: false,
        isNamespace: false,
      },
    ];
  }
  if (child.type === "shorthand_property_identifier_pattern") {
    const base = factBase(input, node);
    return [
      {
        ...base,
        idSuffix: `${base.idSuffix}:${child.text}`,
        moduleSpecifier,
        importKind: "commonjs",
        importedName: child.text,
        localName: child.text,
        isDefault: false,
        isNamespace: false,
      },
    ];
  }
  return [];
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
      const identifiers = children(specifier).filter(
        (candidate) => candidate.type === "identifier" || candidate.type === "type_identifier",
      );
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
  statementIsTypeOnly: boolean,
): SourceExportFact {
  const identifiers = children(specifier).filter(
    (candidate) => candidate.type === "identifier" || candidate.type === "type_identifier",
  );
  const localName = identifiers[0]?.text;
  const exportedName = identifiers.at(-1)?.text ?? localName ?? "unknown";
  return {
    ...factBase(input, specifier),
    exportKind: statementIsTypeOnly || hasDirectToken(specifier, "type") ? "type" : moduleSpecifier && exportedName === "default" ? "default" : moduleSpecifier ? "re-export" : "local",
    exportedName,
    localName,
    moduleSpecifier,
  };
}
