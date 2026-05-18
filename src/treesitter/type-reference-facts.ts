import type {
  ChunkSourceFileInput,
  SourceTypeReferenceFact,
  TreeSitterNode,
} from "./types.js";
import {
  children,
  factBase,
  nearestAncestor,
} from "./node-utils.js";

const typeContextNodes = new Set([
  "abstract_class_declaration",
  "class_declaration",
  "conditional_type",
  "constraint",
  "default_type",
  "extends_type_clause",
  "generic_type",
  "implements_clause",
  "index_signature",
  "index_type_query",
  "interface_declaration",
  "lookup_type",
  "mapped_type_clause",
  "nested_type_identifier",
  "type_alias_declaration",
  "type_annotation",
  "type_arguments",
  "type_parameter",
  "type_parameters",
  "type_query",
]);

export function extractTypeReferenceFact(
  input: ChunkSourceFileInput,
  node: TreeSitterNode,
  ancestors: TreeSitterNode[],
): SourceTypeReferenceFact | undefined {
  if (node.type !== "type_identifier" && node.type !== "identifier") {
    return undefined;
  }
  if (!isTypeContext(ancestors) || isTypeReferenceDefinition(node, ancestors)) {
    return undefined;
  }
  return {
    ...factBase(input, node),
    name: node.text,
    referenceText: referenceTextForNode(node, ancestors),
    referenceKind: typeReferenceKind(ancestors),
  };
}

function isTypeContext(ancestors: TreeSitterNode[]): boolean {
  return ancestors.some((ancestor) => typeContextNodes.has(ancestor.type));
}

function isTypeReferenceDefinition(node: TreeSitterNode, ancestors: TreeSitterNode[]): boolean {
  const parent = ancestors.at(-1);
  if (!parent) {
    return false;
  }
  if (
    [
      "abstract_class_declaration",
      "class_declaration",
      "enum_declaration",
      "interface_declaration",
      "type_alias_declaration",
    ].includes(parent.type) &&
    parent.childForFieldName("name") === node
  ) {
    return true;
  }
  if (parent.type === "type_parameter") {
    return children(parent).find((child) => child.type === "type_identifier") === node;
  }
  if (parent.type === "mapped_type_clause") {
    return children(parent).find((child) => child.type === "type_identifier") === node;
  }
  return false;
}

function referenceTextForNode(node: TreeSitterNode, ancestors: TreeSitterNode[]): string {
  const nested = nearestAncestor(ancestors, "nested_type_identifier");
  if (nested?.text.endsWith(`.${node.text}`)) {
    return nested.text;
  }
  return node.text;
}

function typeReferenceKind(ancestors: TreeSitterNode[]): SourceTypeReferenceFact["referenceKind"] {
  if (nearestAncestor(ancestors, "constraint")) {
    return "generic-constraint";
  }
  if (nearestAncestor(ancestors, "default_type")) {
    return "generic-default";
  }
  if (nearestAncestor(ancestors, "mapped_type_clause")) {
    return "mapped-type";
  }
  if (nearestAncestor(ancestors, "conditional_type")) {
    return "conditional-type";
  }
  if (nearestAncestor(ancestors, "lookup_type")) {
    return "indexed-access";
  }
  if (nearestAncestor(ancestors, "index_type_query")) {
    return "keyof";
  }
  if (nearestAncestor(ancestors, "type_query")) {
    return "typeof";
  }
  if (nearestAncestor(ancestors, "type_arguments")) {
    return "type-argument";
  }
  if (nearestAncestor(ancestors, "extends_type_clause") || nearestAncestor(ancestors, "implements_clause")) {
    return "heritage";
  }
  if (nearestAncestor(ancestors, "type_annotation")) {
    return "annotation";
  }
  return "type-use";
}
