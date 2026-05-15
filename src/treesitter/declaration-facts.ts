import type {
  ChunkSourceFileInput,
  SourceCallFact,
  SourceCallbackFact,
  SourceChunk,
  SourceDeclarationFact,
  SourceDeclarationKind,
  SourceMemberAccessFact,
  SourceOwnershipFact,
  SourceRange,
  SourceTestCaseFact,
  TreeSitterNode,
} from "./types.js";
import {
  children,
  classNameForMethod,
  containsRange,
  directChildText,
  factBase,
  firstIdentifierLikeChild,
  hashContent,
  legacyChunkIdSuffix,
  nearestAncestor,
  nearestContainingScope,
  objectNameForMember,
  rangeSize,
  sortFacts,
  sourceForRange,
  stableFactId,
  unique,
} from "./node-utils.js";

export function extractDeclarationFact(
  input: ChunkSourceFileInput,
  node: TreeSitterNode,
  ancestors: TreeSitterNode[],
): SourceDeclarationFact | undefined {
  const exportAncestor = nearestAncestor(ancestors, "export_statement");
  const exported = Boolean(exportAncestor);
  const defaultExport = Boolean(exportAncestor && directChildText(exportAncestor, "default"));
  const base = factBase(input, node);

  if (node.type === "function_declaration") {
    return namedDeclaration(base, node, "Function", exported, defaultExport);
  }
  if (node.type === "class_declaration") {
    return namedDeclaration(base, node, "Class", exported, defaultExport);
  }
  if (node.type === "interface_declaration") {
    return namedDeclaration(base, node, "Interface", exported, defaultExport);
  }
  if (node.type === "type_alias_declaration") {
    return namedDeclaration(base, node, "TypeAlias", exported, defaultExport);
  }
  if (node.type === "method_definition") {
    return methodDeclaration(node, ancestors, base);
  }
  if (node.type === "pair") {
    return objectPairDeclaration(node, ancestors, base);
  }
  if (node.type === "variable_declarator") {
    return variableDeclaration(node, base, exported, defaultExport);
  }
  return undefined;
}

export function buildChunks(input: {
  source: ChunkSourceFileInput;
  declarations: SourceDeclarationFact[];
  testCases: SourceTestCaseFact[];
  calls: SourceCallFact[];
}): SourceChunk[] {
  const declarationChunks = input.declarations
    .map((declaration) => chunkFromDeclaration(input.source, declaration, input.calls))
    .filter((chunk): chunk is SourceChunk => Boolean(chunk));
  const testChunks = input.testCases
    .filter((testCase) => testCase.kind === "Test")
    .map((testCase) => chunkFromTestCase(input.source, testCase, input.calls));
  return sortFacts([...declarationChunks, ...testChunks]);
}

export function assignContainment(input: {
  declarations: SourceDeclarationFact[];
  testCases: SourceTestCaseFact[];
  callbacks: SourceCallbackFact[];
  calls: SourceCallFact[];
  memberAccesses: SourceMemberAccessFact[];
  chunks: SourceChunk[];
}): void {
  const scopes = [
    ...input.declarations.map((declaration) => ({
      name: declaration.qualifiedName,
      range: declaration.range,
    })),
    ...input.testCases.map((testCase) => ({
      name: testCase.name,
      range: testCase.range,
    })),
  ];

  for (const declaration of input.declarations) {
    declaration.containingChunkIdSuffix = containingChunkId(input.chunks, declaration.range);
  }
  for (const testCase of input.testCases) {
    testCase.containingChunkIdSuffix = containingChunkId(input.chunks, testCase.range);
  }
  for (const callback of input.callbacks) {
    const containing = nearestContainingScope(scopes, callback.range);
    callback.containingChunkIdSuffix = containingChunkId(input.chunks, callback.range);
    callback.parentName ??= containing?.name;
  }
  for (const call of input.calls) {
    const containing = nearestContainingScope(scopes, call.range);
    call.containingDeclarationName = containing?.name;
    call.containingChunkIdSuffix = containingChunkId(input.chunks, call.range);
  }
  for (const memberAccess of input.memberAccesses) {
    const containing = nearestContainingScope(scopes, memberAccess.range);
    memberAccess.containingDeclarationName = containing?.name;
    memberAccess.containingChunkIdSuffix = containingChunkId(input.chunks, memberAccess.range);
  }
}

export function buildOwnerships(input: {
  source: ChunkSourceFileInput;
  declarations: SourceDeclarationFact[];
  testCases: SourceTestCaseFact[];
}): SourceOwnershipFact[] {
  const ownerships: SourceOwnershipFact[] = [];
  for (const declaration of input.declarations) {
    if (!declaration.parentName) {
      continue;
    }
    ownerships.push(ownershipFact(input.source, declaration.parentName, declaration.qualifiedName, declaration.range));
  }
  for (const testCase of input.testCases) {
    if (!testCase.parentName) {
      continue;
    }
    ownerships.push(ownershipFact(input.source, testCase.parentName, testCase.name, testCase.range));
  }
  return ownerships;
}

function namedDeclaration(
  base: Omit<SourceDeclarationFact, "name" | "qualifiedName" | "kind" | "exported" | "defaultExport">,
  node: TreeSitterNode,
  kind: SourceDeclarationKind,
  exported: boolean,
  defaultExport: boolean,
): SourceDeclarationFact | undefined {
  const name = node.childForFieldName("name")?.text;
  return name ? { ...base, name, qualifiedName: name, kind, exported, defaultExport } : undefined;
}

function methodDeclaration(
  node: TreeSitterNode,
  ancestors: TreeSitterNode[],
  base: ReturnType<typeof factBase>,
): SourceDeclarationFact | undefined {
  const name = node.childForFieldName("name")?.text;
  if (!name) {
    return undefined;
  }
  const className = classNameForMethod(ancestors);
  if (className) {
    return childDeclaration(base, name, className, "ClassMethod");
  }
  const objectName = objectNameForMember(ancestors);
  return objectName ? childDeclaration(base, name, objectName, "ObjectMethod") : undefined;
}

function objectPairDeclaration(
  node: TreeSitterNode,
  ancestors: TreeSitterNode[],
  base: ReturnType<typeof factBase>,
): SourceDeclarationFact | undefined {
  const value = node.childForFieldName("value");
  if (value?.type !== "arrow_function" && value?.type !== "function") {
    return undefined;
  }
  const name = node.childForFieldName("key")?.text ?? firstIdentifierLikeChild(node);
  const objectName = objectNameForMember(ancestors);
  return name && objectName ? childDeclaration(base, name, objectName, "ObjectMethod") : undefined;
}

function variableDeclaration(
  node: TreeSitterNode,
  base: ReturnType<typeof factBase>,
  exported: boolean,
  defaultExport: boolean,
): SourceDeclarationFact | undefined {
  const name = node.childForFieldName("name")?.text;
  const value = node.childForFieldName("value");
  if (!name || !value) {
    return undefined;
  }
  if (value.type === "arrow_function" || value.type === "function") {
    return { ...base, name, qualifiedName: name, kind: "VariableFunction", exported, defaultExport };
  }
  if (value.type === "object") {
    return { ...base, name, qualifiedName: name, kind: "Object", exported, defaultExport };
  }
  return undefined;
}

function childDeclaration(
  base: ReturnType<typeof factBase>,
  name: string,
  parentName: string,
  kind: "ClassMethod" | "ObjectMethod",
): SourceDeclarationFact {
  return {
    ...base,
    name,
    qualifiedName: `${parentName}.${name}`,
    kind,
    exported: false,
    defaultExport: false,
    parentName,
  };
}

function chunkFromDeclaration(
  input: ChunkSourceFileInput,
  declaration: SourceDeclarationFact,
  calls: SourceCallFact[],
): SourceChunk | undefined {
  const kind = chunkKindForDeclaration(declaration.kind, input.relativePath);
  if (!kind) {
    return undefined;
  }
  const content = sourceForRange(input.content, declaration.range);
  return {
    idSuffix: legacyChunkIdSuffix(declaration.range),
    name: declaration.name,
    kind,
    range: declaration.range,
    content,
    contentHash: hashContent(content),
    calls: callsInRange(calls, declaration.range),
  };
}

function chunkFromTestCase(
  input: ChunkSourceFileInput,
  testCase: SourceTestCaseFact,
  calls: SourceCallFact[],
): SourceChunk {
  const content = sourceForRange(input.content, testCase.range);
  return {
    idSuffix: legacyChunkIdSuffix(testCase.range),
    name: testCase.name,
    kind: "Test",
    range: testCase.range,
    content,
    contentHash: hashContent(content),
    calls: callsInRange(calls, testCase.range),
  };
}

function chunkKindForDeclaration(
  kind: SourceDeclarationKind,
  relativePath: string,
): SourceChunk["kind"] | undefined {
  if (kind === "Object") {
    return undefined;
  }
  if (relativePath.includes(".test.") || relativePath.includes(".spec.")) return "Test";
  if (kind === "Class") return "Class";
  if (kind === "Interface") return "Interface";
  if (kind === "TypeAlias") return "TypeAlias";
  return "Function";
}

function containingChunkId(chunks: SourceChunk[], range: SourceRange): string | undefined {
  return chunks
    .filter((chunk) => containsRange(chunk.range, range))
    .sort((left, right) => rangeSize(left.range) - rangeSize(right.range))[0]?.idSuffix;
}

function callsInRange(calls: SourceCallFact[], range: SourceRange): string[] {
  return unique(calls.filter((call) => containsRange(range, call.range)).map((call) => call.name)).sort();
}

function ownershipFact(
  input: ChunkSourceFileInput,
  ownerName: string,
  childName: string,
  range: SourceRange,
): SourceOwnershipFact {
  return {
    idSuffix: stableFactId("ownership", `${ownerName}->${childName}`, range),
    ownerName,
    childName,
    relationship: "contains",
    range,
    ownerFile: input.relativePath,
  };
}
