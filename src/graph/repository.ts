import type { CodeEdge, CodeNode } from "../schema/schemas.js";

export interface StoredCodeNode extends CodeNode {
  content?: string;
}

export interface RelatedCodeNode {
  node: StoredCodeNode;
  edgeKind: CodeEdge["kind"];
  edgeMetadata: Record<string, unknown>;
}

export interface SemanticCodeNode {
  node: StoredCodeNode;
  distance: number;
}

export interface SemanticSearchFilters {
  repo?: string;
  packageName?: string;
  fileKind?: string;
  symbolKind?: string;
}

export interface CodeGraphRepository {
  findSymbols(nameOrId: string, limit: number): Promise<StoredCodeNode[]>;
  getRelatedNodes(
    seed: string,
    edgeKind: CodeEdge["kind"],
    direction: "incoming" | "outgoing",
    limit: number,
  ): Promise<RelatedCodeNode[]>;
  getAdjacentNodes(nodeIds: string[], limit: number): Promise<RelatedCodeNode[]>;
  getContextNodes(seed: string, limit: number): Promise<StoredCodeNode[]>;
  semanticSearch(embedding: number[], limit: number, filters?: SemanticSearchFilters): Promise<SemanticCodeNode[]>;
  tracePath(fromId: string, toId: string, limit: number): Promise<StoredCodeNode[]>;
  getNodes(): Promise<StoredCodeNode[]>;
  getEdges(): Promise<CodeEdge[]>;
  close(): Promise<void>;
}
