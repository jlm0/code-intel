import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import type {
  ChunkSourceFileInput,
  SourceFileAstFacts,
  SourceRange,
  TreeSitterNode,
} from "./types.js";

const require = createRequire(import.meta.url);

const Parser = require("tree-sitter");
const JavaScript = require("tree-sitter-javascript");
const TypeScript = require("tree-sitter-typescript");
const maxChunkContentBytes = 64_000;

export function parseSourceFile(input: ChunkSourceFileInput): { rootNode: TreeSitterNode } | undefined {
  const parser = new Parser();
  try {
    parser.setLanguage(languageForFile(input.relativePath));
    return parser.parse(input.content) as { rootNode: TreeSitterNode };
  } catch {
    return undefined;
  }
}

export function factBase(input: ChunkSourceFileInput, node: TreeSitterNode): {
  idSuffix: string;
  range: SourceRange;
  sourceText: string;
  contentHash: string;
  ownerFile: string;
} {
  const range = rangeForNode(node);
  return {
    idSuffix: stableFactId(node.type, node.text, range),
    range,
    sourceText: node.text,
    contentHash: hashContent(node.text),
    ownerFile: input.relativePath,
  };
}

export function sourceForRange(source: string, range: SourceRange): string {
  const lines = source.split(/\r?\n/);
  return truncateContent(lines.slice(range.startLine - 1, range.endLine).join("\n"));
}

export function fallbackRange(input: ChunkSourceFileInput): SourceRange {
  const lines = input.content.split(/\r?\n/);
  return {
    startLine: 1,
    endLine: Math.max(lines.length, 1),
    startColumn: 0,
    endColumn: lines.at(-1)?.length ?? 0,
  };
}

export function firstStringArgument(node: TreeSitterNode): string | undefined {
  const args = node.childForFieldName("arguments");
  if (!args) {
    return undefined;
  }
  const stringNode = children(args).find((child) => child.type === "string");
  return stringNode ? stringLiteralValue(stringNode) : undefined;
}

export function moduleSpecifierForNode(node: TreeSitterNode): string | undefined {
  const stringNode = children(node).find((child) => child.type === "string");
  return stringNode ? stringLiteralValue(stringNode) : undefined;
}

export function moduleSpecifierForCallArgument(node: TreeSitterNode): string | undefined {
  const args = node.childForFieldName("arguments");
  const firstArgument = args ? children(args).find((child) => child.type !== "," && child.type !== "(" && child.type !== ")") : undefined;
  if (!firstArgument) {
    return undefined;
  }
  if (firstArgument.type === "string") {
    return stringLiteralValue(firstArgument);
  }
  if (firstArgument.type === "template_string") {
    return templateLiteralSpecifier(firstArgument.text);
  }
  return undefined;
}

export function exportedDeclarationNames(node: TreeSitterNode): string[] {
  const names: string[] = [];
  for (const candidate of children(node)) {
    if (isNamedDeclaration(candidate)) {
      const name = candidate.childForFieldName("name")?.text;
      if (name) {
        names.push(name);
      } else if ((candidate.type === "class" || candidate.type === "function") && candidate.childCount > 0) {
        names.push("default");
      }
    }
    if (candidate.type === "lexical_declaration" || candidate.type === "variable_declaration") {
      for (const declarationChild of children(candidate)) {
        if (declarationChild.type !== "variable_declarator") {
          continue;
        }
        const name = declarationChild.childForFieldName("name")?.text;
        if (name) {
          names.push(name);
        }
      }
    }
  }
  return unique(names);
}

export function classNameForMethod(ancestors: TreeSitterNode[]): string | undefined {
  const classDeclaration = nearestAncestor(ancestors, "class_declaration")
    ?? nearestAncestor(ancestors, "abstract_class_declaration");
  if (classDeclaration) {
    return classDeclaration.childForFieldName("name")?.text;
  }
  const anonymousClass = nearestAncestor(ancestors, "class");
  if (anonymousClass && nearestAncestor(ancestors, "export_statement")) {
    return "default";
  }
  return undefined;
}

export function objectNameForMember(ancestors: TreeSitterNode[]): string | undefined {
  const path: string[] = [];
  for (const ancestor of ancestors) {
    if (ancestor.type === "variable_declarator" && ancestor.childForFieldName("value")?.type === "object") {
      const name = ancestor.childForFieldName("name")?.text;
      if (name) {
        path.length = 0;
        path.push(name);
      }
    }
    if (ancestor.type === "pair" && ancestor.childForFieldName("value")?.type === "object") {
      const key = ancestor.childForFieldName("key")?.text ?? firstIdentifierLikeChild(ancestor);
      if (key) {
        path.push(key);
      }
    }
  }
  return path.length > 0 ? path.join(".") : undefined;
}

export function nearestTestCaseName(ancestors: TreeSitterNode[]): string | undefined {
  const title = nearestTestCaseTitle(ancestors);
  return title ? titleToTestName(title.callee, title.title) : undefined;
}

export function nearestTestCaseTitle(ancestors: TreeSitterNode[]): { callee: "describe" | "it" | "test"; title: string } | undefined {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index]!;
    if (ancestor.type !== "call_expression") {
      continue;
    }
    const callee = testCalleeForCall(ancestor);
    if (!callee) {
      continue;
    }
    const title = firstStringArgument(ancestor);
    if (title) {
      return { callee, title };
    }
  }
  return undefined;
}

export function titleToTestName(callee: "describe" | "it" | "test", title: string): string {
  return `${callee} ${title}`;
}

export function nearestContainingScope<T extends { name: string; range: SourceRange }>(
  scopes: T[],
  range: SourceRange,
): T | undefined {
  return scopes
    .filter((scope) => containsRange(scope.range, range))
    .sort((left, right) => rangeSize(left.range) - rangeSize(right.range))[0];
}

export function containsRange(container: SourceRange, candidate: SourceRange): boolean {
  if (candidate.startLine < container.startLine || candidate.endLine > container.endLine) {
    return false;
  }
  if (candidate.startLine === container.startLine && candidate.startColumn < container.startColumn) {
    return false;
  }
  if (candidate.endLine === container.endLine && candidate.endColumn > container.endColumn) {
    return false;
  }
  return true;
}

export function rangeSize(range: SourceRange): number {
  return (range.endLine - range.startLine) * 1_000 + (range.endColumn - range.startColumn);
}

export function extractCallableName(text: string): string | undefined {
  const normalizedText = normalizeMemberPath(text);
  if (normalizedText === "super") {
    return "super";
  }
  const normalized = normalizedText.split(".").at(-1)?.replaceAll("?", "").trim();
  if (!normalized || !/^[A-Za-z_$][\w$]*$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

export function normalizeMemberPath(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:await|void)\s+/, "")
    .replace(/\s*(\?\.|\.)\s*/g, "$1");
}

export function memberParts(text: string): {
  memberPath: string;
  receiver?: string;
  propertyName?: string;
  optionalChain: boolean;
} {
  const memberPath = normalizeMemberPath(text);
  const match = memberPath.match(/^(.*?)(?:\?\.|\.)([^.]+)$/);
  const propertyName = match?.[2]?.replaceAll("?", "");
  const receiver = match?.[1]?.trim();
  return {
    memberPath,
    receiver,
    propertyName,
    optionalChain: memberPath.includes("?."),
  };
}

export function stringArgumentForCall(node: TreeSitterNode): string | undefined {
  return firstStringArgument(node);
}

export function rangeForNode(node: TreeSitterNode): SourceRange {
  return {
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
  };
}

export function legacyChunkIdSuffix(range: SourceRange): string {
  return `${range.startLine}-${range.endLine}`;
}

export function stableFactId(kind: string, name: string, range: SourceRange): string {
  const safeName = name.replace(/\s+/g, " ").slice(0, 80);
  return `${kind}:${hashContent(safeName).slice(0, 8)}:${range.startLine}-${range.startColumn}-${range.endLine}-${range.endColumn}`;
}

export function truncateContent(content: string): string {
  if (Buffer.byteLength(content, "utf8") <= maxChunkContentBytes) {
    return content;
  }
  return `${content.slice(0, maxChunkContentBytes)}\n[truncated]`;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function languageLabelForFile(relativePath: string): SourceFileAstFacts["language"] {
  if (relativePath.endsWith(".tsx")) return "tsx";
  if (relativePath.endsWith(".jsx")) return "jsx";
  if (relativePath.endsWith(".ts") || relativePath.endsWith(".mts") || relativePath.endsWith(".cts")) {
    return "typescript";
  }
  return "javascript";
}

export function visit(node: TreeSitterNode, callback: (node: TreeSitterNode) => void): void {
  callback(node);
  for (const child of children(node)) {
    visit(child, callback);
  }
}

export function visitWithAncestors(
  node: TreeSitterNode,
  ancestors: TreeSitterNode[],
  callback: (node: TreeSitterNode, ancestors: TreeSitterNode[]) => void,
): void {
  callback(node, ancestors);
  for (const child of children(node)) {
    visitWithAncestors(child, [...ancestors, node], callback);
  }
}

export function children(node: TreeSitterNode): TreeSitterNode[] {
  const result: TreeSitterNode[] = [];
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child) {
      result.push(child);
    }
  }
  return result;
}

export function directChild(node: TreeSitterNode, type: string): TreeSitterNode | undefined {
  return children(node).find((child) => child.type === type);
}

export function directChildText(node: TreeSitterNode, text: string): string | undefined {
  return children(node).find((child) => child.text === text)?.text;
}

export function hasDirectToken(node: TreeSitterNode, text: string): boolean {
  return Boolean(directChildText(node, text));
}

export function nearestAncestor(ancestors: TreeSitterNode[], type: string): TreeSitterNode | undefined {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    if (ancestors[index]?.type === type) {
      return ancestors[index];
    }
  }
  return undefined;
}

export function firstIdentifierLikeChild(node: TreeSitterNode): string | undefined {
  return children(node).find(
    (child) =>
      child.type === "identifier" ||
      child.type === "property_identifier" ||
      child.type === "private_property_identifier" ||
      child.type === "type_identifier",
  )?.text;
}

export function testCalleeForCall(node: TreeSitterNode): "describe" | "it" | "test" | undefined {
  if (node.type !== "call_expression") {
    return undefined;
  }
  const functionNode = node.childForFieldName("function");
  const text = functionNode?.text;
  if (text === "describe" || text === "it" || text === "test") {
    return text;
  }
  if (functionNode?.type === "call_expression") {
    const nestedFunction = functionNode.childForFieldName("function");
    if (nestedFunction?.type === "member_expression") {
      const parts = memberParts(nestedFunction.text);
      if (parts.propertyName === "each" && (parts.receiver === "describe" || parts.receiver === "it" || parts.receiver === "test")) {
        return parts.receiver;
      }
    }
  }
  return undefined;
}

export function decoratorsForNode(node: TreeSitterNode, ancestors: TreeSitterNode[]): string[] {
  const decorators: string[] = [];
  const parent = ancestors.at(-1);
  if (parent) {
    const siblings = children(parent);
    const nodeIndex = siblings.findIndex((sibling) => sibling === node);
    for (let index = nodeIndex - 1; index >= 0; index -= 1) {
      const sibling = siblings[index];
      if (sibling?.type !== "decorator") {
        break;
      }
      decorators.unshift(sibling.text);
    }
  }

  const exportAncestor = nearestAncestor(ancestors, "export_statement");
  const grandparent = ancestors.at(-2);
  const directlyExported =
    parent?.type === "export_statement" ||
    ((parent?.type === "lexical_declaration" || parent?.type === "variable_declaration") &&
      grandparent?.type === "export_statement");
  if (exportAncestor && directlyExported) {
    decorators.unshift(
      ...children(exportAncestor)
        .filter((child) => child.type === "decorator")
        .map((child) => child.text),
    );
  }

  return unique(decorators);
}

export function sortFacts<T extends { range: SourceRange; idSuffix: string }>(facts: T[]): T[] {
  return [...facts].sort((left, right) => {
    if (left.range.startLine !== right.range.startLine) return left.range.startLine - right.range.startLine;
    if (left.range.startColumn !== right.range.startColumn) return left.range.startColumn - right.range.startColumn;
    return left.idSuffix.localeCompare(right.idSuffix);
  });
}

export function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function stringLiteralValue(node: TreeSitterNode): string {
  return node.text.replace(/^['"]|['"]$/g, "");
}

function templateLiteralSpecifier(text: string): string | undefined {
  if (!text.startsWith("`") || !text.endsWith("`")) {
    return undefined;
  }
  return text.slice(1, -1).replace(/\$\{\s*([^}]+?)\s*\}/g, (_match, expression: string) => `\${${expression.trim()}}`);
}

function isNamedDeclaration(node: TreeSitterNode): boolean {
  return (
    node.type === "function_declaration" ||
    (node.type === "function" && node.childCount > 0) ||
    node.type === "class_declaration" ||
    (node.type === "class" && node.childCount > 0) ||
    node.type === "interface_declaration" ||
    node.type === "type_alias_declaration"
  );
}

function languageForFile(relativePath: string): unknown {
  if (relativePath.endsWith(".tsx")) return TypeScript.tsx;
  if (relativePath.endsWith(".ts") || relativePath.endsWith(".mts") || relativePath.endsWith(".cts")) {
    return TypeScript.typescript;
  }
  return JavaScript;
}
