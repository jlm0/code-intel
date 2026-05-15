import type {
  ChunkSourceFileInput,
  SourceCallFact,
  SourceCallbackFact,
  SourceMemberAccessFact,
  SourceTestCaseFact,
  TreeSitterNode,
} from "./types.js";
import {
  extractCallableName,
  factBase,
  firstStringArgument,
  nearestAncestor,
  nearestTestCaseName,
  normalizeMemberPath,
} from "./node-utils.js";

export function extractTestCaseFact(
  input: ChunkSourceFileInput,
  node: TreeSitterNode,
  ancestors: TreeSitterNode[],
): SourceTestCaseFact | undefined {
  if (node.type !== "call_expression") {
    return undefined;
  }
  const functionNode = node.childForFieldName("function");
  const callee = functionNode?.text;
  if (callee !== "describe" && callee !== "it" && callee !== "test") {
    return undefined;
  }
  const title = firstStringArgument(node);
  if (!title) {
    return undefined;
  }
  return {
    ...factBase(input, node),
    kind: callee === "describe" ? "Suite" : "Test",
    name: `${callee} ${title}`,
    title,
    callee,
    parentName: nearestTestCaseName(ancestors),
  };
}

export function extractCallbackFact(
  input: ChunkSourceFileInput,
  node: TreeSitterNode,
  ancestors: TreeSitterNode[],
): SourceCallbackFact | undefined {
  if (node.type !== "arrow_function" && node.type !== "function") {
    return undefined;
  }
  const parent = ancestors.at(-1);
  if (
    (parent?.type === "variable_declarator" && parent.childForFieldName("value") === node) ||
    (parent?.type === "pair" && parent.childForFieldName("value") === node) ||
    parent?.type === "method_definition"
  ) {
    return undefined;
  }
  const call = nearestAncestor(ancestors, "call_expression");
  if (!call) {
    return undefined;
  }
  const callName = extractCallableName(call.childForFieldName("function")?.text ?? "") ?? "callback";
  return {
    ...factBase(input, node),
    name: `${callName} callback`,
    parentName: nearestTestCaseName(ancestors),
  };
}

export function extractCallFact(input: ChunkSourceFileInput, node: TreeSitterNode): SourceCallFact | undefined {
  const functionNode = node.childForFieldName("function");
  const name = extractCallableName(functionNode?.text ?? "");
  if (!name) {
    return undefined;
  }
  return {
    ...factBase(input, node),
    name,
    memberPath: functionNode?.type === "member_expression" ? normalizeMemberPath(functionNode.text) : undefined,
  };
}

export function extractMemberAccessFact(
  input: ChunkSourceFileInput,
  node: TreeSitterNode,
): SourceMemberAccessFact | undefined {
  const path = normalizeMemberPath(node.text);
  const propertyName = path.split(".").at(-1);
  if (!propertyName || !/^[A-Za-z_$][\w$]*$/.test(propertyName)) {
    return undefined;
  }
  return {
    ...factBase(input, node),
    path,
    propertyName,
  };
}
