export type TreeNode = {
  value: string;
  children: TreeNode[];
};

export function flattenTree(node: TreeNode): string[] {
  return [node.value, ...node.children.flatMap(flattenTree)];
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
