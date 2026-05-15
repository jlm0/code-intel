import {
  assignContainment,
  buildChunks,
  buildOwnerships,
  extractDeclarationFact,
} from "./declaration-facts.js";
import {
  extractCommonJsExportFact,
  extractCommonJsImportFacts,
  extractDynamicImportFact,
  extractExportFacts,
  extractImportFacts,
} from "./module-facts.js";
import {
  fallbackRange,
  hashContent,
  languageLabelForFile,
  parseSourceFile,
  sortFacts,
  truncateContent,
  visitWithAncestors,
} from "./node-utils.js";
import {
  extractCallFact,
  extractCallbackFact,
  extractMemberAccessFact,
  extractTestCaseFact,
} from "./reference-facts.js";
import type {
  ChunkSourceFileInput,
  SourceCallbackFact,
  SourceCallFact,
  SourceChunk,
  SourceDeclarationFact,
  SourceExportFact,
  SourceFileAstFacts,
  SourceImportFact,
  SourceMemberAccessFact,
  SourceTestCaseFact,
} from "./types.js";

export type {
  ChunkSourceFileInput,
  SourceCallbackFact,
  SourceCallFact,
  SourceChunk,
  SourceDeclarationFact,
  SourceDeclarationKind,
  SourceExportFact,
  SourceFileAstFacts,
  SourceImportFact,
  SourceMemberAccessFact,
  SourceOwnershipFact,
  SourceRange,
  SourceTestCaseFact,
} from "./types.js";

export function chunkSourceFile(input: ChunkSourceFileInput): SourceChunk[] {
  return extractSourceFileFacts(input).chunks;
}

export function extractSourceFileFacts(input: ChunkSourceFileInput): SourceFileAstFacts {
  const tree = parseSourceFile(input);
  if (!tree) {
    return fallbackFacts(input);
  }

  const declarations: SourceDeclarationFact[] = [];
  const imports: SourceImportFact[] = [];
  const exports: SourceExportFact[] = [];
  const calls: SourceCallFact[] = [];
  const memberAccesses: SourceMemberAccessFact[] = [];
  const testCases: SourceTestCaseFact[] = [];
  const callbacks: SourceCallbackFact[] = [];

  visitWithAncestors(tree.rootNode, [], (node, ancestors) => {
    if (node.type === "import_statement") {
      imports.push(...extractImportFacts(input, node));
      return;
    }
    if (node.type === "export_statement") {
      exports.push(...extractExportFacts(input, node));
    }
    if (node.type === "assignment_expression") {
      const commonJsExport = extractCommonJsExportFact(input, node);
      if (commonJsExport) {
        exports.push(commonJsExport);
      }
    }

    const declaration = extractDeclarationFact(input, node, ancestors);
    if (declaration) {
      declarations.push(declaration);
    }

    const testCase = extractTestCaseFact(input, node, ancestors);
    if (testCase) {
      testCases.push(testCase);
    }

    const callback = extractCallbackFact(input, node, ancestors);
    if (callback) {
      callbacks.push(callback);
    }

    if (node.type === "call_expression") {
      const dynamicImport = extractDynamicImportFact(input, node);
      if (dynamicImport) {
        imports.push(dynamicImport);
      }
      imports.push(...extractCommonJsImportFacts(input, node, ancestors));
    }

    if (
      node.type === "call_expression" ||
      node.type === "new_expression" ||
      node.type === "jsx_opening_element" ||
      node.type === "jsx_self_closing_element"
    ) {
      const call = extractCallFact(input, node);
      if (call) {
        calls.push(call);
      }
    }

    if (node.type === "member_expression") {
      const memberAccess = extractMemberAccessFact(input, node);
      if (memberAccess) {
        memberAccesses.push(memberAccess);
      }
    }
  });

  const chunks = buildChunks({ source: input, declarations, testCases, calls });
  assignContainment({ declarations, testCases, callbacks, calls, memberAccesses, chunks });

  return {
    relativePath: input.relativePath,
    language: languageLabelForFile(input.relativePath),
    chunks: chunks.length > 0 ? chunks : [fallbackChunk(input)],
    imports: sortFacts(imports),
    exports: sortFacts(exports),
    declarations: sortFacts(declarations),
    calls: sortFacts(calls),
    memberAccesses: sortFacts(memberAccesses),
    ownerships: sortFacts(buildOwnerships({ source: input, declarations, testCases })),
    testCases: sortFacts(testCases),
    callbacks: sortFacts(callbacks),
    hasParseError: Boolean(tree.rootNode.hasError),
  };
}

function fallbackFacts(input: ChunkSourceFileInput): SourceFileAstFacts {
  return {
    relativePath: input.relativePath,
    language: languageLabelForFile(input.relativePath),
    chunks: [fallbackChunk(input)],
    imports: [],
    exports: [],
    declarations: [],
    calls: [],
    memberAccesses: [],
    ownerships: [],
    testCases: [],
    callbacks: [],
    hasParseError: true,
  };
}

function fallbackChunk(input: ChunkSourceFileInput): SourceChunk {
  const range = fallbackRange(input);
  return {
    idSuffix: `1-${range.endLine}`,
    name: input.relativePath,
    kind: "Chunk",
    range,
    content: truncateContent(input.content),
    contentHash: hashContent(input.content),
    calls: [],
  };
}
