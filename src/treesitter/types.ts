export interface ChunkSourceFileInput {
  relativePath: string;
  content: string;
}

export interface SourceRange {
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
}

export interface SourceChunk {
  idSuffix: string;
  name: string;
  kind: "Function" | "Class" | "Interface" | "TypeAlias" | "Chunk" | "Test";
  range: SourceRange;
  content: string;
  contentHash: string;
  calls: string[];
}

export type SourceDeclarationKind =
  | "Function"
  | "Class"
  | "Interface"
  | "TypeAlias"
  | "Namespace"
  | "Enum"
  | "Variable"
  | "VariableFunction"
  | "ClassMethod"
  | "ClassField"
  | "ClassAccessor"
  | "Object"
  | "ObjectMethod"
  | "AmbientModule";

export interface SourceDeclarationFact {
  idSuffix: string;
  name: string;
  qualifiedName: string;
  kind: SourceDeclarationKind;
  range: SourceRange;
  sourceText: string;
  contentHash: string;
  ownerFile: string;
  exported: boolean;
  defaultExport: boolean;
  decorators: string[];
  parentName?: string;
  containingChunkIdSuffix?: string;
}

export interface SourceImportFact {
  idSuffix: string;
  moduleSpecifier: string;
  importKind: "value" | "type" | "side-effect" | "dynamic" | "commonjs";
  importedName?: string;
  localName?: string;
  isDefault: boolean;
  isNamespace: boolean;
  range: SourceRange;
  sourceText: string;
  contentHash: string;
  ownerFile: string;
  containingChunkIdSuffix?: string;
}

export interface SourceExportFact {
  idSuffix: string;
  exportKind: "local" | "re-export" | "default" | "commonjs" | "type";
  exportedName: string;
  localName?: string;
  moduleSpecifier?: string;
  range: SourceRange;
  sourceText: string;
  contentHash: string;
  ownerFile: string;
  containingChunkIdSuffix?: string;
}

export interface SourceCallFact {
  idSuffix: string;
  name: string;
  callKind: "function" | "member" | "constructor" | "dynamic-import" | "jsx" | "tagged-template";
  range: SourceRange;
  sourceText: string;
  contentHash: string;
  ownerFile: string;
  memberPath?: string;
  receiver?: string;
  propertyName?: string;
  optionalChain: boolean;
  argumentSpecifier?: string;
  containingDeclarationName?: string;
  containingChunkIdSuffix?: string;
}

export interface SourceMemberAccessFact {
  idSuffix: string;
  path: string;
  propertyName: string;
  range: SourceRange;
  sourceText: string;
  contentHash: string;
  ownerFile: string;
  optionalChain: boolean;
  containingDeclarationName?: string;
  containingChunkIdSuffix?: string;
}

export interface SourceOwnershipFact {
  idSuffix: string;
  ownerName: string;
  childName: string;
  relationship: "contains";
  range: SourceRange;
  ownerFile: string;
}

export interface SourceTestCaseFact {
  idSuffix: string;
  kind: "Suite" | "Test";
  name: string;
  title: string;
  callee: "describe" | "it" | "test";
  range: SourceRange;
  sourceText: string;
  contentHash: string;
  ownerFile: string;
  parentName?: string;
  containingChunkIdSuffix?: string;
}

export interface SourceCallbackFact {
  idSuffix: string;
  name: string;
  range: SourceRange;
  sourceText: string;
  contentHash: string;
  ownerFile: string;
  parentName?: string;
  containingChunkIdSuffix?: string;
}

export interface SourceFileAstFacts {
  relativePath: string;
  language: "javascript" | "jsx" | "typescript" | "tsx";
  chunks: SourceChunk[];
  imports: SourceImportFact[];
  exports: SourceExportFact[];
  declarations: SourceDeclarationFact[];
  calls: SourceCallFact[];
  memberAccesses: SourceMemberAccessFact[];
  ownerships: SourceOwnershipFact[];
  testCases: SourceTestCaseFact[];
  callbacks: SourceCallbackFact[];
  hasParseError: boolean;
}

export interface TreeSitterNode {
  type: string;
  text: string;
  childCount: number;
  hasError?: boolean;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  child(index: number): TreeSitterNode | null;
  childForFieldName(name: string): TreeSitterNode | null;
}
