export interface McpGuidance {
  purpose: string;
  evidenceFields: string[];
  nextTools: string[];
  examples: string[];
}

const commonEvidence = [
  "metadata.relationship.evidenceSources",
  "metadata.relationship.confidence",
  "metadata.relationship.fallbackReason",
  "metadata.ranking.reasons",
];

const toolGuidance: Record<string, McpGuidance> = {
  workspace_overview: {
    purpose: "Confirm the active index and repositories before querying.",
    evidenceFields: ["manifest", "repos", "indexPath"],
    nextTools: ["health", "semantic_search", "find_symbol"],
    examples: ["Call workspace_overview first when a repo may not be indexed."],
  },
  health: {
    purpose: "Check whether environment, provider, manifest, graph, and MCP surfaces are usable.",
    evidenceFields: ["checks[].status", "checks[].details"],
    nextTools: ["workspace_overview", "semantic_search"],
    examples: ["Run health after index/update or when results look stale."],
  },
  search_text: {
    purpose: "Find exact strings with bounded ripgrep output.",
    evidenceFields: ["file", "range", "excerpt"],
    nextTools: ["get_context", "find_symbol"],
    examples: ["Search exact route path strings or error messages."],
  },
  semantic_search: {
    purpose: "Find conceptually relevant code and use rank reasons to decide what to inspect.",
    evidenceFields: commonEvidence,
    nextTools: ["expand_context", "get_context", "trace_path"],
    examples: ["Use semantic_search for 'webhook payment flow' or 'survey response persistence'."],
  },
  find_symbol: {
    purpose: "Resolve a symbol name or stable ID into graph seed nodes.",
    evidenceFields: ["id", "symbol", "metadata.qualifiedName"],
    nextTools: ["get_references", "get_callers", "get_callees", "expand_context"],
    examples: ["Find createPoll before asking for callers or references."],
  },
  get_symbol: {
    purpose: "Resolve one best seed node when a tool needs a stable node ID.",
    evidenceFields: ["id", "symbol", "metadata.qualifiedName"],
    nextTools: ["expand_context", "trace_path", "get_context"],
    examples: ["Use get_symbol when trace_path needs a concrete fromId or toId."],
  },
  get_references: {
    purpose: "Inspect where a symbol is referenced with compiler, resolver, AST, or fallback evidence.",
    evidenceFields: commonEvidence,
    nextTools: ["get_context", "trace_path", "expand_context"],
    examples: ["Use get_references to find test files or database-client use sites."],
  },
  get_callers: {
    purpose: "Inspect incoming call relationships for impact analysis.",
    evidenceFields: commonEvidence,
    nextTools: ["get_context", "trace_path"],
    examples: ["Use get_callers before changing a public function."],
  },
  get_callees: {
    purpose: "Inspect outgoing call relationships from an implementation.",
    evidenceFields: commonEvidence,
    nextTools: ["get_context", "trace_path"],
    examples: ["Use get_callees to understand service-to-database paths."],
  },
  expand_context: {
    purpose: "Gather bounded graph neighbors around a selected node.",
    evidenceFields: commonEvidence,
    nextTools: ["get_context", "trace_path", "semantic_search"],
    examples: ["Expand a route handler to see imports, calls, tests, and related chunks."],
  },
  get_context: {
    purpose: "Read bounded source excerpts for selected nodes.",
    evidenceFields: ["excerpt", "range", "file"],
    nextTools: ["expand_context", "get_references"],
    examples: ["Use get_context only after choosing a small set of nodes."],
  },
  trace_path: {
    purpose: "Prove relationship paths with ordered nodes and edge evidence.",
    evidenceFields: ["metadata.pathEdges", "metadata.incomingPathEdge", "confidence", "fallbackReason"],
    nextTools: ["get_context", "expand_context"],
    examples: ["Trace UI entry to service to database with allowed CALLS and REFERENCES edges."],
  },
};

export function guidanceForTool(tool: string): McpGuidance {
  return toolGuidance[tool] ?? {
    purpose: "Use the returned structured code-intel result.",
    evidenceFields: commonEvidence,
    nextTools: [],
    examples: [],
  };
}
