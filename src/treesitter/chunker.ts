import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const Parser = require("tree-sitter");
const JavaScript = require("tree-sitter-javascript");
const TypeScript = require("tree-sitter-typescript");
const maxChunkContentBytes = 64_000;

export interface ChunkSourceFileInput {
  relativePath: string;
  content: string;
}

export interface SourceChunk {
  idSuffix: string;
  name: string;
  kind: "Function" | "Class" | "Interface" | "TypeAlias" | "Chunk" | "Test";
  range: {
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
  };
  content: string;
  contentHash: string;
  calls: string[];
}

const chunkNodeTypes = new Set([
  "function_declaration",
  "method_definition",
  "class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "variable_declarator",
]);

export function chunkSourceFile(input: ChunkSourceFileInput): SourceChunk[] {
  const parser = new Parser();
  let tree: { rootNode: TreeSitterNode };
  try {
    parser.setLanguage(languageForFile(input.relativePath));
    tree = parser.parse(input.content);
  } catch {
    return [fallbackChunk(input)];
  }
  const chunks: SourceChunk[] = [];

  visit(tree.rootNode, (node: TreeSitterNode) => {
    if (!chunkNodeTypes.has(node.type)) {
      return;
    }
    const name = node.childForFieldName("name")?.text;
    if (!name) {
      return;
    }
    if (node.type === "variable_declarator" && !isChunkableVariable(node)) {
      return;
    }
    const content = sourceForNode(input.content, node);
    chunks.push({
      idSuffix: `${node.startPosition.row + 1}-${node.endPosition.row + 1}`,
      name,
      kind: kindForNode(node.type, input.relativePath),
      range: {
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        startColumn: node.startPosition.column,
        endColumn: node.endPosition.column,
      },
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
      calls: extractCalls(node),
    });
  });

  return chunks.length > 0 ? chunks : [fallbackChunk(input)];
}

function visit(node: TreeSitterNode, callback: (node: TreeSitterNode) => void): void {
  callback(node);
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child) {
      visit(child, callback);
    }
  }
}

function extractCalls(node: TreeSitterNode): string[] {
  const calls = new Set<string>();
  visit(node, (candidate) => {
    if (candidate.type !== "call_expression") {
      return;
    }
    const functionNode = candidate.childForFieldName("function");
    const name = extractCallableName(functionNode?.text ?? "");
    if (name) {
      calls.add(name);
    }
  });
  return [...calls].sort();
}

function extractCallableName(text: string): string | undefined {
  const normalized = text.split(".").at(-1)?.trim();
  if (!normalized || !/^[A-Za-z_$][\w$]*$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function sourceForNode(source: string, node: TreeSitterNode): string {
  const lines = source.split(/\r?\n/);
  return truncateContent(lines.slice(node.startPosition.row, node.endPosition.row + 1).join("\n"));
}

function fallbackChunk(input: ChunkSourceFileInput): SourceChunk {
  const lines = input.content.split(/\r?\n/);
  return {
    idSuffix: `1-${Math.max(lines.length, 1)}`,
    name: input.relativePath,
    kind: "Chunk",
    range: {
      startLine: 1,
      endLine: Math.max(lines.length, 1),
      startColumn: 0,
      endColumn: lines.at(-1)?.length ?? 0,
    },
    content: truncateContent(input.content),
    contentHash: createHash("sha256").update(input.content).digest("hex"),
    calls: [],
  };
}

function truncateContent(content: string): string {
  if (Buffer.byteLength(content, "utf8") <= maxChunkContentBytes) {
    return content;
  }
  return `${content.slice(0, maxChunkContentBytes)}\n[truncated]`;
}

function kindForNode(type: string, relativePath: string): SourceChunk["kind"] {
  if (relativePath.includes(".test.") || relativePath.includes(".spec.")) return "Test";
  if (type === "class_declaration") return "Class";
  if (type === "interface_declaration") return "Interface";
  if (type === "type_alias_declaration") return "TypeAlias";
  return "Function";
}

function isChunkableVariable(node: TreeSitterNode): boolean {
  const valueType = node.childForFieldName("value")?.type;
  const name = node.childForFieldName("name")?.text ?? "";
  return (
    valueType === "arrow_function" ||
    valueType === "function" ||
    name.startsWith("use") ||
    /^[A-Z]/.test(name)
  );
}

function languageForFile(relativePath: string): unknown {
  if (relativePath.endsWith(".tsx")) return TypeScript.tsx;
  if (relativePath.endsWith(".ts") || relativePath.endsWith(".mts") || relativePath.endsWith(".cts")) {
    return TypeScript.typescript;
  }
  return JavaScript;
}

interface TreeSitterNode {
  type: string;
  text: string;
  childCount: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  child(index: number): TreeSitterNode | null;
  childForFieldName(name: string): TreeSitterNode | null;
}
