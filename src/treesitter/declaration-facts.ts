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
  SourceTypeReferenceFact,
  TreeSitterNode,
} from "./types.js";
import {
  children,
  classNameForMethod,
  containsRange,
  decoratorsForNode,
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
  const directlyExported = isDirectExportWrapper(ancestors);
  const exported = Boolean(exportAncestor && directlyExported);
  const defaultExport = Boolean(exportAncestor && directlyExported && directChildText(exportAncestor, "default"));
  const base = factBase(input, node);
  const decorators = decoratorsForNode(node, ancestors);
  const namespaceName = namespaceNameForDeclaration(ancestors);

  if (
    node.type === "function_declaration" ||
    node.type === "generator_function_declaration" ||
    node.type === "function_signature" ||
    node.type === "function_expression" ||
    (node.type === "function" && node.childCount > 0)
  ) {
    return namedDeclaration(base, node, "Function", exported, defaultExport, decorators, namespaceName);
  }
  if (
    node.type === "class_declaration" ||
    node.type === "abstract_class_declaration" ||
    node.type === "class_expression" ||
    (node.type === "class" && node.childCount > 0)
  ) {
    return namedDeclaration(base, node, "Class", exported, defaultExport, decorators, namespaceName);
  }
  if (node.type === "interface_declaration") {
    return namedDeclaration(base, node, "Interface", exported, defaultExport, decorators, namespaceName);
  }
  if (node.type === "type_alias_declaration") {
    return namedDeclaration(base, node, "TypeAlias", exported, defaultExport, decorators, namespaceName);
  }
  if (node.type === "internal_module") {
    return namespaceDeclaration(base, node, exported, decorators, namespaceName);
  }
  if (node.type === "module" && nearestAncestor(ancestors, "ambient_declaration")) {
    return ambientModuleDeclaration(base, node);
  }
  if (node.type === "enum_declaration") {
    return namedDeclaration(base, node, "Enum", exported, defaultExport, decorators, namespaceName);
  }
  if (node.type === "public_field_definition") {
    return classFieldDeclaration(node, ancestors, base, decorators);
  }
  if (node.type === "statement_block" || node.type === "class_static_block") {
    return staticBlockDeclaration(node, ancestors, base);
  }
  if (node.type === "abstract_method_signature") {
    return methodSignatureDeclaration(node, ancestors, base, decorators);
  }
  if (node.type === "method_definition") {
    return methodDeclaration(node, ancestors, base, decorators);
  }
  if (node.type === "pair") {
    return objectPairDeclaration(node, ancestors, base);
  }
  if (node.type === "variable_declarator") {
    return variableDeclaration(input, node, ancestors, base, exported, defaultExport);
  }
  return undefined;
}

function isDirectExportWrapper(ancestors: TreeSitterNode[]): boolean {
  const parent = ancestors.at(-1);
  const grandparent = ancestors.at(-2);
  return (
    parent?.type === "export_statement" ||
    ((parent?.type === "lexical_declaration" || parent?.type === "variable_declaration") &&
      grandparent?.type === "export_statement")
  );
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
  typeReferences: SourceTypeReferenceFact[];
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
    call.containingDeclarationName = call.name === "super" && call.callKind === "constructor" && containing?.name.endsWith(".constructor")
      ? containing.name.slice(0, -".constructor".length)
      : containing?.name;
    call.containingChunkIdSuffix = containingChunkId(input.chunks, call.range);
  }
  for (const memberAccess of input.memberAccesses) {
    const containing = nearestContainingScope(scopes, memberAccess.range);
    memberAccess.containingDeclarationName = containing?.name;
    memberAccess.containingChunkIdSuffix = containingChunkId(input.chunks, memberAccess.range);
  }
  for (const typeReference of input.typeReferences) {
    const containing = nearestContainingScope(scopes, typeReference.range);
    typeReference.containingDeclarationName = containing?.name;
    typeReference.containingChunkIdSuffix = containingChunkId(input.chunks, typeReference.range);
  }
  assignRouteCallContainment(input.declarations, input.calls, input.memberAccesses);
}

function assignRouteCallContainment(
  declarations: SourceDeclarationFact[],
  calls: SourceCallFact[],
  memberAccesses: SourceMemberAccessFact[],
): void {
  const routeOwners = routeOwnerAliases(declarations);
  if (routeOwners.size === 0) {
    return;
  }
  for (const call of calls) {
    if (call.memberPath && isRouteRegistrationCall(call) && call.receiver) {
      call.containingDeclarationName = routeOwners.get(call.receiver) ?? call.containingDeclarationName;
    }
  }
  const routeCalls = calls.filter((call) => call.containingDeclarationName && isRouteRegistrationCall(call));
  for (const call of calls) {
    if (call.containingDeclarationName) {
      continue;
    }
    const containingRoute = routeCalls.find((routeCall) => containsRange(routeCall.range, call.range));
    call.containingDeclarationName = containingRoute?.containingDeclarationName;
  }
  for (const access of memberAccesses) {
    if (access.containingDeclarationName) {
      continue;
    }
    const containingRoute = routeCalls.find((routeCall) => containsRange(routeCall.range, access.range));
    access.containingDeclarationName = containingRoute?.containingDeclarationName;
  }
}

function routeOwnerAliases(declarations: SourceDeclarationFact[]): Map<string, string> {
  const aliases = new Map<string, string>();
  const owners = declarations.filter((declaration) =>
    declaration.exported &&
    (declaration.sourceText.includes("new Hono") || /routes?$/i.test(declaration.name) || /polls/i.test(declaration.name))
  );
  for (const owner of owners) {
    aliases.set(owner.name, owner.qualifiedName);
  }
  for (const declaration of declarations) {
    const match = declaration.sourceText.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;?/) ??
      declaration.sourceText.match(/^([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;?$/);
    const target = match?.[2] ? aliases.get(match[2]) : undefined;
    if (match?.[1] && target) {
      aliases.set(match[1], target);
    }
  }
  return aliases;
}

function isRouteRegistrationCall(call: SourceCallFact): boolean {
  return call.callKind === "member" &&
    Boolean(call.propertyName && ["all", "delete", "get", "patch", "post", "put", "route", "use"].includes(call.propertyName));
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
    ownerships.push(
      ownershipFact(
        input.source,
        declaration.parentName,
        declaration.name === "static-block" || declaration.kind === "Variable" ? declaration.name : declaration.qualifiedName,
        declaration.range,
      ),
    );
  }
  for (const testCase of input.testCases) {
    if (!testCase.parentName) {
      continue;
    }
    const parentSuite = input.testCases
      .filter((candidate) =>
        candidate.kind === "Suite" &&
        candidate.title === testCase.parentName &&
        containsRange(candidate.range, testCase.range)
      )
      .sort((left, right) => rangeSize(left.range) - rangeSize(right.range))[0];
    ownerships.push(ownershipFact(input.source, parentSuite?.name ?? testCase.parentName, testCase.name, testCase.range));
  }
  return ownerships;
}

function namedDeclaration(
  base: Omit<
    SourceDeclarationFact,
    "name" | "qualifiedName" | "kind" | "exported" | "defaultExport" | "decorators"
  >,
  node: TreeSitterNode,
  kind: SourceDeclarationKind,
  exported: boolean,
  defaultExport: boolean,
  decorators: string[],
  parentName?: string,
): SourceDeclarationFact | undefined {
  const name = node.childForFieldName("name")?.text ?? (defaultExport ? "default" : undefined);
  return name
    ? {
        ...base,
        name,
        qualifiedName: parentName ? `${parentName}.${name}` : name,
        kind,
        exported,
        defaultExport,
        decorators,
        parentName,
      }
    : undefined;
}

function methodDeclaration(
  node: TreeSitterNode,
  ancestors: TreeSitterNode[],
  base: ReturnType<typeof factBase>,
  decorators: string[],
): SourceDeclarationFact | undefined {
  const name = node.childForFieldName("name")?.text;
  if (!name) {
    return undefined;
  }
  const className = classNameForMethod(ancestors);
  if (className) {
    return childDeclaration(base, name, className, isAccessorMethod(node) ? "ClassAccessor" : "ClassMethod", decorators);
  }
  const objectName = objectNameForMember(ancestors);
  return objectName ? childDeclaration(base, name, objectName, "ObjectMethod", decorators) : undefined;
}

function methodSignatureDeclaration(
  node: TreeSitterNode,
  ancestors: TreeSitterNode[],
  base: ReturnType<typeof factBase>,
  decorators: string[],
): SourceDeclarationFact | undefined {
  const name = node.childForFieldName("name")?.text ?? firstIdentifierLikeChild(node);
  const className = classNameForMethod(ancestors);
  return name && className ? childDeclaration(base, name, className, "ClassMethod", decorators) : undefined;
}

function classFieldDeclaration(
  node: TreeSitterNode,
  ancestors: TreeSitterNode[],
  base: ReturnType<typeof factBase>,
  decorators: string[],
): SourceDeclarationFact | undefined {
  const className = classNameForMethod(ancestors);
  if (!className) {
    return undefined;
  }
  if (node.text.trim().startsWith("static {")) {
    return childDeclaration(base, "static-block", className, "ClassField", decorators);
  }
  const name = node.childForFieldName("name")?.text ?? firstIdentifierLikeChild(node);
  if (!name) {
    return undefined;
  }
  return childDeclaration(base, name, className, /\baccessor\s+[#A-Za-z_$]/.test(node.text) ? "ClassAccessor" : "ClassField", decorators);
}

function staticBlockDeclaration(
  node: TreeSitterNode,
  ancestors: TreeSitterNode[],
  base: ReturnType<typeof factBase>,
): SourceDeclarationFact | undefined {
  const className = classNameForMethod(ancestors);
  if (!className) {
    return undefined;
  }
  if (node.type !== "class_static_block") {
    return undefined;
  }
  return childDeclaration(base, "static-block", className, "ClassField", []);
}

function namespaceDeclaration(
  base: ReturnType<typeof factBase>,
  node: TreeSitterNode,
  exported: boolean,
  decorators: string[],
  parentName: string | undefined,
): SourceDeclarationFact | undefined {
  const name = node.childForFieldName("name")?.text ?? firstIdentifierLikeChild(node);
  return name
    ? {
        ...base,
        name,
        qualifiedName: parentName ? `${parentName}.${name}` : name,
        kind: "Namespace",
        exported,
        defaultExport: false,
        decorators,
        parentName,
      }
    : undefined;
}

function ambientModuleDeclaration(
  base: ReturnType<typeof factBase>,
  node: TreeSitterNode,
): SourceDeclarationFact | undefined {
  const stringName = children(node).find((child) => child.type === "string")?.text.replace(/^['"]|['"]$/g, "");
  const name = stringName ?? firstIdentifierLikeChild(node);
  return name
    ? {
        ...base,
        name,
        qualifiedName: name,
        kind: "AmbientModule",
        exported: false,
        defaultExport: false,
        decorators: [],
      }
    : undefined;
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
  return name && objectName ? childDeclaration(base, name, objectName, "ObjectMethod", []) : undefined;
}

function variableDeclaration(
  input: ChunkSourceFileInput,
  node: TreeSitterNode,
  ancestors: TreeSitterNode[],
  base: ReturnType<typeof factBase>,
  exported: boolean,
  defaultExport: boolean,
): SourceDeclarationFact | undefined {
  const nameNode = node.childForFieldName("name");
  if (
    nameNode?.type !== "identifier" &&
    nameNode?.type !== "property_identifier" &&
    nameNode?.type !== "type_identifier"
  ) {
    return undefined;
  }
  const name = nameNode.text;
  const value = node.childForFieldName("value");
  if (!name) {
    return undefined;
  }
  const namespaceName = namespaceNameForDeclaration(ancestors);
  const qualifiedName = namespaceName ? `${namespaceName}.${name}` : name;
  if (!value) {
    return isTopLevelVariable(ancestors)
      ? {
          ...base,
          name,
          qualifiedName,
          kind: "Variable",
          exported,
          defaultExport,
          decorators: [],
          parentName: namespaceName,
        }
      : undefined;
  }
  if (
    value.type === "arrow_function" ||
    value.type === "function" ||
    (value.type === "call_expression" &&
      (isFunctionValuedCall(value) || isExportedTopLevelFactoryCall(value, ancestors, exported)))
  ) {
    return {
      ...base,
      name,
      qualifiedName,
      kind: "VariableFunction",
      exported,
      defaultExport,
      decorators: [],
      parentName: namespaceName,
    };
  }
  if (value.type === "object") {
    return {
      ...base,
      name,
      qualifiedName,
      kind: input.relativePath.includes(".stories.") ? "Variable" : "Object",
      exported,
      defaultExport,
      decorators: [],
      parentName: namespaceName,
    };
  }
  if (!isTopLevelVariable(ancestors)) {
    return undefined;
  }
  return {
    ...base,
    name,
    qualifiedName,
    kind: "Variable",
    exported,
    defaultExport,
    decorators: [],
    parentName: namespaceName,
  };
}

function isFunctionValuedCall(node: TreeSitterNode): boolean {
  if (!containsFunctionLike(node)) {
    return false;
  }
  const callee = node.childForFieldName("function")?.text ?? "";
  const propertyName = callee.split(".").at(-1)?.replace(/[?()]/g, "");
  return (
    callee === "dynamic" ||
    callee === "lazy" ||
    callee === "React.lazy" ||
    propertyName === "bind" ||
    Boolean(propertyName && ["all", "delete", "get", "patch", "post", "put", "route", "use"].includes(propertyName))
  );
}

function isExportedTopLevelFactoryCall(
  node: TreeSitterNode,
  ancestors: TreeSitterNode[],
  exported: boolean,
): boolean {
  if (!exported || !isTopLevelVariable(ancestors) || !containsFunctionLike(node)) {
    return false;
  }
  const callee = node.childForFieldName("function")?.text ?? "";
  const propertyName = callee.split(".").at(-1)?.replace(/[?()]/g, "") ?? callee;
  return !["every", "filter", "find", "flatMap", "forEach", "map", "reduce", "some"].includes(propertyName);
}

function containsFunctionLike(node: TreeSitterNode): boolean {
  if (node.type === "arrow_function" || node.type === "function" || node.type === "function_declaration") {
    return true;
  }
  return children(node).some((child) => containsFunctionLike(child));
}

function isTopLevelVariable(ancestors: TreeSitterNode[]): boolean {
  const parent = ancestors.at(-1);
  const grandparent = ancestors.at(-2);
  return (
    (parent?.type === "lexical_declaration" || parent?.type === "variable_declaration") &&
    (grandparent?.type === "program" || grandparent?.type === "export_statement")
  );
}

function childDeclaration(
  base: ReturnType<typeof factBase>,
  name: string,
  parentName: string,
  kind: "ClassMethod" | "ClassField" | "ClassAccessor" | "ObjectMethod",
  decorators: string[],
): SourceDeclarationFact {
  return {
    ...base,
    name,
    qualifiedName: `${parentName}.${name}`,
    kind,
    exported: false,
    defaultExport: false,
    decorators,
    parentName,
  };
}

function chunkFromDeclaration(
  input: ChunkSourceFileInput,
  declaration: SourceDeclarationFact,
  calls: SourceCallFact[],
): SourceChunk | undefined {
  const kind = chunkKindForDeclaration(declaration, input);
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
  declaration: SourceDeclarationFact,
  input: ChunkSourceFileInput,
): SourceChunk["kind"] | undefined {
  const mode = input.policy?.semanticChunkMode ?? "bounded";
  const kind = declaration.kind;
  if (kind === "ClassField" || kind === "ClassAccessor") {
    return undefined;
  }
  if (kind === "Object") {
    if (mode === "minimal") {
      return undefined;
    }
    if (objectLiteralLooksTooLarge(declaration.sourceText, input.policy?.maxSmallObjectProperties ?? 6)) {
      return mode === "expanded" ? "Symbol" : undefined;
    }
    return "Symbol";
  }
  if (kind === "Namespace" || kind === "Enum" || kind === "AmbientModule") {
    return mode === "minimal" ? undefined : "Symbol";
  }
  if (kind === "Variable") {
    if (mode === "minimal") {
      return undefined;
    }
    if (!declaration.exported && mode !== "expanded") {
      return undefined;
    }
    if (objectLiteralLooksTooLarge(declaration.sourceText, input.policy?.maxSmallObjectProperties ?? 6)) {
      return mode === "expanded" ? "Symbol" : undefined;
    }
    return "Symbol";
  }
  if (input.relativePath.includes(".test.") || input.relativePath.includes(".spec.")) return "Test";
  if (kind === "Class") return "Class";
  if (kind === "Interface") return "Interface";
  if (kind === "TypeAlias") return "TypeAlias";
  return "Function";
}

function objectLiteralLooksTooLarge(sourceText: string, maxProperties: number): boolean {
  const objectBody = sourceText.match(/\{([\s\S]*)\}/)?.[1];
  if (!objectBody) {
    return false;
  }
  const propertyLikeLines = objectBody
    .split(/\r?\n/)
    .filter((line) => /^\s*[A-Za-z_$][\w$-]*\s*:/.test(line));
  return propertyLikeLines.length > maxProperties;
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

export function enumMemberDeclarations(
  input: ChunkSourceFileInput,
  enumDeclaration: SourceDeclarationFact,
  node: TreeSitterNode,
): SourceDeclarationFact[] {
  const enumBody = children(node).find((child) => child.type === "enum_body");
  if (!enumBody) {
    return [];
  }
  const members: TreeSitterNode[] = [];
  collectEnumMemberNodes(enumBody, members);
  return members
    .map((child) => ({
      ...factBase(input, child),
      name: child.text,
      qualifiedName: `${enumDeclaration.qualifiedName}.${child.text}`,
      kind: "Variable" as const,
      exported: false,
      defaultExport: false,
      decorators: [],
      parentName: enumDeclaration.qualifiedName,
    }));
}

export function syntheticStaticBlockOwnershipChild(childName: string, declaration: SourceDeclarationFact): string {
  return declaration.name === "static-block" ? "static-block" : childName;
}

function namespaceNameForDeclaration(ancestors: TreeSitterNode[]): string | undefined {
  const names: string[] = [];
  for (const ancestor of ancestors) {
    if (ancestor.type !== "internal_module") {
      continue;
    }
    const name = ancestor.childForFieldName("name")?.text ?? firstIdentifierLikeChild(ancestor);
    if (name) {
      names.push(name);
    }
  }
  const ambient = nearestAncestor(ancestors, "module");
  if (ambient && nearestAncestor(ancestors, "ambient_declaration")) {
    const moduleName = children(ambient).find((child) => child.type === "string")?.text.replace(/^['"]|['"]$/g, "");
    if (moduleName) {
      names.unshift(moduleName);
    }
  }
  return names.length > 0 ? names.join(".") : undefined;
}

function isAccessorMethod(node: TreeSitterNode): boolean {
  const trimmed = node.text.trim();
  return trimmed.startsWith("get ") || trimmed.startsWith("set ") || trimmed.startsWith("static get ") || trimmed.startsWith("static set ");
}

function collectEnumMemberNodes(node: TreeSitterNode, members: TreeSitterNode[]): void {
  if (node.type === "property_identifier") {
    members.push(node);
    return;
  }
  for (const child of children(node)) {
    collectEnumMemberNodes(child, members);
  }
}
