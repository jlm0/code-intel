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
  memberParts,
  nearestAncestor,
  nearestTestCaseName,
  normalizeMemberPath,
  children,
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
  if (node.type === "new_expression") {
    const constructorNode = children(node).find(
      (child) => child.type === "identifier" || child.type === "member_expression",
    );
    const name = extractCallableName(constructorNode?.text ?? "");
    if (!name) {
      return undefined;
    }
    const parts = constructorNode?.type === "member_expression" ? memberParts(constructorNode.text) : undefined;
    return {
      ...factBase(input, node),
      name,
      callKind: "constructor",
      memberPath: parts?.memberPath,
      receiver: parts?.receiver,
      propertyName: parts?.propertyName,
      optionalChain: false,
    };
  }

  if (node.type === "jsx_opening_element" || node.type === "jsx_self_closing_element") {
    const nameNode = children(node).find(
      (child) => child.type === "identifier" || child.type === "member_expression",
    );
    const name = extractCallableName(nameNode?.text ?? "");
    if (!name) {
      return undefined;
    }
    const parts = nameNode?.type === "member_expression" ? memberParts(nameNode.text) : undefined;
    return {
      ...factBase(input, node),
      name,
      callKind: "jsx",
      memberPath: parts?.memberPath,
      receiver: parts?.receiver,
      propertyName: parts?.propertyName,
      optionalChain: false,
    };
  }

  if (node.type !== "call_expression") {
    return undefined;
  }

  const functionNode = node.childForFieldName("function");
  const name = extractCallableName(functionNode?.text ?? "");
  if (!name) {
    return undefined;
  }
  const parts = functionNode?.type === "member_expression" ? memberParts(functionNode.text) : undefined;
  const callKind = functionNode?.text === "import"
    ? "dynamic-import"
    : functionNode?.type === "member_expression"
      ? "member"
      : "function";
  return {
    ...factBase(input, node),
    name,
    callKind,
    memberPath: parts?.memberPath,
    receiver: parts?.receiver,
    propertyName: parts?.propertyName,
    optionalChain: Boolean(parts?.optionalChain),
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
    optionalChain: path.includes("?."),
  };
}
