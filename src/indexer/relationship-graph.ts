import { createStableId } from "../core/ids.js";
import type { CodeEdge, CodeNode } from "../schema/schemas.js";
import type { FileFact } from "./fact-cache.js";

type AddEdge = (
  kind: CodeEdge["kind"],
  fromId: string,
  toId: string,
  workspace: string,
  repo: string,
  metadata?: Record<string, unknown>,
) => void;

export interface ApplyRelationshipGraphFactsInput {
  workspaceName: string;
  repo: {
    name: string;
    commit: string;
  };
  fileNodes: Map<string, CodeNode>;
  astSymbolsByFile: Map<string, CodeNode[]>;
  fileFactsByRelativePath: Map<string, FileFact>;
  addNode: (node: Omit<CodeNode, "schemaVersion">) => CodeNode;
  addEdge: AddEdge;
}

export function applyRelationshipGraphFacts(input: ApplyRelationshipGraphFactsInput): void {
  applyEnvironmentConfigRelationships(input);
  applyFrameworkConventionRelationships(input);
  applyApiClientRelationships(input);
}

function applyEnvironmentConfigRelationships(input: ApplyRelationshipGraphFactsInput): void {
  for (const [relativePath, fileFact] of input.fileFactsByRelativePath) {
    const fileNode = input.fileNodes.get(relativePath);
    if (!fileNode) {
      continue;
    }
    for (const access of fileFact.memberAccesses) {
      const envName = envNameForMemberAccess(access.path);
      if (!envName) {
        continue;
      }
      const envNode = input.addNode({
        id: createStableId({
          kind: "symbol",
          workspace: input.workspaceName,
          repo: input.repo.name,
          commit: input.repo.commit,
          relativePath,
          suffix: `env-${envName}`,
        }),
        kind: "Symbol",
        workspace: input.workspaceName,
        repo: input.repo.name,
        packageName: fileNode.packageName,
        file: relativePath,
        name: envName,
        language: fileNode.language,
        range: access.range,
        textHash: access.contentHash,
        metadata: {
          fileKind: fileNode.metadata.fileKind,
          symbolKind: "EnvVar",
          relationship: "config-env",
          envName,
          ownerRepo: input.repo.name,
          ownerFile: relativePath,
          origin: "tree-sitter-member-access",
          source: "tree-sitter-member-access",
          evidenceSources: ["tree-sitter-member-access", "config-env"],
          confidence: "medium",
          derivedFrom: access.contentHash,
        },
      });
      const metadata = {
        ownerRepo: input.repo.name,
        ownerFile: relativePath,
        origin: "tree-sitter-member-access",
        source: "tree-sitter-member-access",
        relationship: "config-env",
        evidenceSources: ["tree-sitter-member-access", "config-env"],
        confidence: "medium",
        envName,
        memberPath: access.path,
        propertyName: access.propertyName,
        range: access.range,
        containingChunkIdSuffix: access.containingChunkIdSuffix,
        roles: ["ReadAccess"],
      };
      const sourceSymbols = symbolsContainingAccess(input, relativePath, access);
      if (sourceSymbols.length === 0) {
        input.addEdge("REFERENCES", fileNode.id, envNode.id, input.workspaceName, input.repo.name, metadata);
        continue;
      }
      for (const sourceSymbol of sourceSymbols) {
        input.addEdge("REFERENCES", sourceSymbol.id, envNode.id, input.workspaceName, input.repo.name, metadata);
      }
    }
  }
}

function symbolsContainingAccess(
  input: ApplyRelationshipGraphFactsInput,
  relativePath: string,
  access: FileFact["memberAccesses"][number],
): CodeNode[] {
  const containingName = access.containingDeclarationName;
  return (input.astSymbolsByFile.get(relativePath) ?? []).filter((symbol) =>
    (!containingName || symbolNameMatches(symbol, containingName)) &&
    symbol.range &&
    rangeContains(symbol.range, access.range)
  );
}

function applyFrameworkConventionRelationships(input: ApplyRelationshipGraphFactsInput): void {
  for (const [relativePath, fileFact] of input.fileFactsByRelativePath) {
    const fileNode = input.fileNodes.get(relativePath);
    if (!fileNode) {
      continue;
    }

    if (hasRouteHandlerEvidence(relativePath, fileFact)) {
      for (const symbol of conventionSourceSymbols(input, relativePath, fileFact, routeHandlerDeclaration)) {
        input.addEdge(
          "DEFINES",
          fileNode.id,
          symbol.id,
          input.workspaceName,
          input.repo.name,
          conventionMetadata({
            repo: input.repo.name,
            file: relativePath,
            relationship: "route-handler",
            evidenceSources: ["tree-sitter-call", "tree-sitter-declaration", "framework-convention", "route-handler"],
            confidence: "medium",
            fallbackReason: routeHandlerFallbackReason(relativePath, fileFact),
            range: symbol.range,
          }),
        );
      }
    }

    for (const symbol of conventionSourceSymbols(input, relativePath, fileFact, loaderActionDeclaration)) {
      input.addEdge(
        "DEFINES",
        fileNode.id,
        symbol.id,
        input.workspaceName,
        input.repo.name,
        conventionMetadata({
          repo: input.repo.name,
          file: relativePath,
          relationship: "loader-action",
          evidenceSources: ["tree-sitter-declaration", "framework-convention", "loader-action"],
          confidence: "fallback",
          fallbackReason: "framework-name-convention",
          range: symbol.range,
        }),
      );
    }
  }
}

function applyApiClientRelationships(input: ApplyRelationshipGraphFactsInput): void {
  for (const [relativePath, fileFact] of input.fileFactsByRelativePath) {
    const fileNode = input.fileNodes.get(relativePath);
    if (!fileNode) {
      continue;
    }
    for (const call of fileFact.calls) {
      if (!isApiClientCall(call)) {
        continue;
      }
      const callsite = input.addNode({
        id: createStableId({
          kind: "callsite",
          workspace: input.workspaceName,
          repo: input.repo.name,
          commit: input.repo.commit,
          relativePath,
          suffix: `api-client-${call.idSuffix}`,
        }),
        kind: "Callsite",
        workspace: input.workspaceName,
        repo: input.repo.name,
        packageName: fileNode.packageName,
        file: relativePath,
        name: call.memberPath ?? call.name,
        language: fileNode.language,
        range: call.range,
        textHash: call.contentHash,
        metadata: {
          fileKind: fileNode.metadata.fileKind,
          symbolKind: "ApiClientCall",
          relationship: "api-client",
          relationshipTags: ["api-client"],
          ownerRepo: input.repo.name,
          ownerFile: relativePath,
          origin: "tree-sitter-call",
          source: "tree-sitter-call",
          evidenceSources: ["tree-sitter-call", "api-client"],
          confidence: "medium",
          memberPath: call.memberPath,
          callKind: call.callKind,
          unresolved: true,
          unresolvedStatus: "runtime-target-unresolved",
          fallbackReason: "runtime-api-target-unresolved",
          derivedFrom: call.contentHash,
        },
      });
      const metadata = {
        ownerRepo: input.repo.name,
        ownerFile: relativePath,
        origin: "tree-sitter-call",
        source: "tree-sitter-call",
        relationship: "api-client",
        relationshipTags: ["api-client"],
        evidenceSources: ["tree-sitter-call", "api-client"],
        confidence: "medium",
        memberPath: call.memberPath,
        callKind: call.callKind,
        range: call.range,
        containingChunkIdSuffix: call.containingChunkIdSuffix,
        unresolved: true,
        unresolvedStatus: "runtime-target-unresolved",
        fallbackReason: "runtime-api-target-unresolved",
        roles: ["Call"],
      };
      const sourceSymbols = symbolsContainingCall(input, relativePath, call);
      if (sourceSymbols.length === 0) {
        input.addEdge("CALLS", fileNode.id, callsite.id, input.workspaceName, input.repo.name, metadata);
        continue;
      }
      for (const sourceSymbol of sourceSymbols) {
        input.addEdge("CALLS", sourceSymbol.id, callsite.id, input.workspaceName, input.repo.name, metadata);
      }
    }
  }
}

function conventionSourceSymbols(
  input: ApplyRelationshipGraphFactsInput,
  relativePath: string,
  fileFact: FileFact,
  predicate: (relativePath: string, declaration: FileFact["declarations"][number]) => boolean,
): CodeNode[] {
  const symbols = input.astSymbolsByFile.get(relativePath) ?? [];
  const matchingDeclarationNames = new Set(
    fileFact.declarations
      .filter((declaration) => predicate(relativePath, declaration))
      .map((declaration) => declaration.qualifiedName),
  );
  if (matchingDeclarationNames.size === 0) {
    return [];
  }
  return symbols.filter((symbol) => {
    const qualifiedName = stringFromMetadata(symbol.metadata, "qualifiedName") ?? symbol.name;
    return Boolean(qualifiedName && matchingDeclarationNames.has(qualifiedName));
  });
}

function hasRouteHandlerEvidence(relativePath: string, fileFact: FileFact): boolean {
  return isNextRouteHandlerFile(relativePath) || fileFact.calls.some(isHttpRouteCall);
}

function routeHandlerDeclaration(
  relativePath: string,
  declaration: FileFact["declarations"][number],
): boolean {
  if (isNextRouteHandlerFile(relativePath)) {
    return /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(declaration.name) || declaration.exported;
  }
  return declaration.exported;
}

function routeHandlerFallbackReason(relativePath: string, fileFact: FileFact): string | undefined {
  if (fileFact.calls.some(isHttpRouteCall)) {
    return undefined;
  }
  return isNextRouteHandlerFile(relativePath) ? "next-route-file-convention" : undefined;
}

function loaderActionDeclaration(
  relativePath: string,
  declaration: FileFact["declarations"][number],
): boolean {
  return /(?:Loader|Action)$/.test(declaration.name) ||
    /^(loader|action)$/.test(declaration.name) ||
    /(^|[-_/])(loader|action)([-_/]|$)/.test(relativePath);
}

function isNextRouteHandlerFile(relativePath: string): boolean {
  return /(^|\/)app\/.*\/route\.[cm]?[jt]sx?$/.test(relativePath) ||
    /(^|\/)pages\/api\/.*\.[cm]?[jt]sx?$/.test(relativePath);
}

function isHttpRouteCall(call: FileFact["calls"][number]): boolean {
  return Boolean(call.memberPath && /^(app|router)\.(get|post|put|patch|delete|head|options|all|use)$/.test(call.memberPath));
}

function isApiClientCall(call: FileFact["calls"][number]): boolean {
  return call.name === "fetch" ||
    Boolean(call.memberPath && /^(axios|ky|got|client|apiClient)\.(get|post|put|patch|delete|request)$/.test(call.memberPath));
}

function symbolsContainingCall(
  input: ApplyRelationshipGraphFactsInput,
  relativePath: string,
  call: FileFact["calls"][number],
): CodeNode[] {
  const containingName = call.containingDeclarationName;
  return (input.astSymbolsByFile.get(relativePath) ?? []).filter((symbol) =>
    (!containingName || symbolNameMatches(symbol, containingName)) &&
    symbol.range &&
    rangeContains(symbol.range, call.range)
  );
}

function conventionMetadata(input: {
  repo: string;
  file: string;
  relationship: string;
  evidenceSources: string[];
  confidence: "high" | "medium" | "fallback";
  fallbackReason?: string;
  range?: CodeNode["range"];
}): Record<string, unknown> {
  return {
    ownerRepo: input.repo,
    ownerFile: input.file,
    origin: "framework-convention",
    source: "framework-convention",
    relationship: input.relationship,
    relationshipTags: [input.relationship, "framework-convention"],
    evidenceSources: input.evidenceSources,
    confidence: input.confidence,
    fallbackReason: input.fallbackReason,
    range: input.range,
  };
}

function symbolNameMatches(symbol: CodeNode, containingName: string): boolean {
  return symbol.name === containingName || stringFromMetadata(symbol.metadata, "qualifiedName") === containingName;
}

function envNameForMemberAccess(path: string): string | undefined {
  const match = path.match(/^process\.env\.([A-Za-z_][A-Za-z0-9_]*)$/);
  return match?.[1];
}

function rangeContains(
  outer: { startLine: number; endLine: number; startColumn?: number; endColumn?: number },
  inner: { startLine: number; endLine: number; startColumn?: number; endColumn?: number },
): boolean {
  const outerStartColumn = outer.startColumn ?? 0;
  const innerStartColumn = inner.startColumn ?? 0;
  const outerEndColumn = outer.endColumn ?? Number.MAX_SAFE_INTEGER;
  const innerEndColumn = inner.endColumn ?? 0;
  const startsAfterOuter =
    inner.startLine > outer.startLine ||
    (inner.startLine === outer.startLine && innerStartColumn >= outerStartColumn);
  const endsBeforeOuter =
    inner.endLine < outer.endLine ||
    (inner.endLine === outer.endLine && innerEndColumn <= outerEndColumn);
  return startsAfterOuter && endsBeforeOuter;
}

function stringFromMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
