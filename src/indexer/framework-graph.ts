import type { CodeEdge, CodeNode } from "../schema/schemas.js";

type AddEdge = (
  kind: CodeEdge["kind"],
  fromId: string,
  toId: string,
  workspace: string,
  repo: string,
  metadata?: Record<string, unknown>,
) => void;

export interface ApplyFrameworkGraphFactsInput {
  workspaceName: string;
  repo: {
    name: string;
  };
  fileNodes: Map<string, CodeNode>;
  astSymbolsByFile: Map<string, CodeNode[]>;
  addEdge: AddEdge;
}

export function applyFrameworkGraphFacts(input: ApplyFrameworkGraphFactsInput): void {
  applyNextAppRouterLayoutEdges(input);
}

function applyNextAppRouterLayoutEdges(input: ApplyFrameworkGraphFactsInput): void {
  const appFilesByDirectory = new Map<string, CodeNode[]>();
  for (const fileNode of input.fileNodes.values()) {
    if (!fileNode.file || !isNextAppRouterSegmentSourceFile(fileNode.file)) {
      continue;
    }
    const directory = fileNode.file.slice(0, fileNode.file.lastIndexOf("/"));
    const files = appFilesByDirectory.get(directory) ?? [];
    files.push(fileNode);
    appFilesByDirectory.set(directory, files);
  }

  for (const files of appFilesByDirectory.values()) {
    const layout = files.find((fileNode) => /(^|\/)layout\.[cm]?[jt]sx?$/.test(fileNode.file ?? ""));
    if (!layout?.file) {
      continue;
    }
    const layoutTargets = [
      layout,
      ...(input.astSymbolsByFile.get(layout.file) ?? []),
    ];
    for (const fileNode of files) {
      if (!fileNode.file || fileNode.id === layout.id) {
        continue;
      }
      for (const target of layoutTargets) {
        addNextLayoutReference(input, fileNode, target, layout.file);
        for (const symbolNode of input.astSymbolsByFile.get(fileNode.file) ?? []) {
          addNextLayoutReference(input, symbolNode, target, layout.file);
        }
      }
    }
  }
}

function addNextLayoutReference(
  input: ApplyFrameworkGraphFactsInput,
  source: CodeNode,
  target: CodeNode,
  layoutFile: string,
): void {
  if (!source.file) {
    return;
  }
  input.addEdge("REFERENCES", source.id, target.id, input.workspaceName, input.repo.name, {
    ownerRepo: input.repo.name,
    ownerFile: source.file,
    origin: "next-app-router",
    source: "file-convention",
    evidenceSources: ["next-app-router", "file-convention"],
    confidence: "fallback",
    framework: "nextjs",
    relationship: "route-segment-layout",
    targetFile: layoutFile,
    fallbackReason: "next-app-router-file-convention",
  });
}

function isNextAppRouterSegmentSourceFile(relativePath: string): boolean {
  return /(^|\/)app\/.+\.[cm]?[jt]sx?$/.test(relativePath);
}
