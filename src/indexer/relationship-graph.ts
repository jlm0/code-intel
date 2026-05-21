import { dirname, join } from "node:path";

import { createStableId, normalizeRelativePath } from "../core/ids.js";
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
  nodes: Map<string, CodeNode>;
  edges: Map<string, CodeEdge>;
  fileNodes: Map<string, CodeNode>;
  astSymbolsByFile: Map<string, CodeNode[]>;
  fileFactsByRelativePath: Map<string, FileFact>;
  addNode: (node: Omit<CodeNode, "schemaVersion">) => CodeNode;
  addEdge: AddEdge;
}

export function applyRelationshipGraphFacts(input: ApplyRelationshipGraphFactsInput): void {
  applyTypeRelationshipEdges(input);
  applyTypeReferenceEdges(input);
  applyStaticCallRelationshipEdges(input);
  applyAmbientModuleRelationships(input);
  applyDynamicTemplateImportRelationships(input);
  applySideEffectImportRelationships(input);
  applyImportedMemberCallEdges(input);
  applyDiscriminatedUnionRelationships(input);
  applyEnvironmentConfigRelationships(input);
  applyFrameworkConventionRelationships(input);
  applyApiClientRelationships(input);
  applyTransitiveCallRelationshipEdges(input);
}

function applyTypeReferenceEdges(input: ApplyRelationshipGraphFactsInput): void {
  const symbols = allSymbols(input);
  for (const [relativePath, fileFact] of input.fileFactsByRelativePath) {
    for (const typeReference of fileFact.typeReferences ?? []) {
      const sourceSymbols = symbolsContainingTypeReference(input, relativePath, typeReference);
      if (sourceSymbols.length === 0) {
        continue;
      }
      const targets = typeReferenceTargets(symbols, typeReference, relativePath);
      for (const source of sourceSymbols) {
        for (const target of targets) {
          if (source.id === target.id) {
            continue;
          }
          input.addEdge(
            "REFERENCES",
            source.id,
            target.id,
            input.workspaceName,
            input.repo.name,
            typeReferenceMetadata(input.repo.name, relativePath, typeReference, target),
          );
        }
      }
    }
  }
}

function applyImportedMemberCallEdges(input: ApplyRelationshipGraphFactsInput): void {
  for (const [relativePath, fileFact] of input.fileFactsByRelativePath) {
    for (const importFact of fileFact.imports) {
      if (!importFact.localName || importFact.importKind === "type") {
        continue;
      }
      const target = importedSymbolTarget(input, relativePath, importFact);
      if (!target) {
        continue;
      }
      for (const call of fileFact.calls) {
        if (!call.memberPath?.startsWith(`${importFact.localName}.`)) {
          continue;
        }
        for (const source of symbolsContainingCall(input, relativePath, call)) {
          if (source.id === target.id) {
            continue;
          }
          input.addEdge(
            "CALLS",
            source.id,
            target.id,
            input.workspaceName,
            input.repo.name,
            importedMemberCallMetadata(input.repo.name, relativePath, importFact, call, target),
          );
        }
      }
    }
  }
}

function importedSymbolTarget(
  input: ApplyRelationshipGraphFactsInput,
  relativePath: string,
  importFact: FileFact["imports"][number],
): CodeNode | undefined {
  const targetSymbolIds = [...input.edges.values()]
    .filter((edge) =>
      edgeBelongsToCurrentRepo(edge, input.repo.name) &&
      (edge.kind === "IMPORTS" || edge.kind === "REFERENCES") &&
      edge.metadata.ownerFile === relativePath &&
      edge.metadata.moduleSpecifier === importFact.moduleSpecifier &&
      edge.metadata.localName === importFact.localName
    )
    .map((edge) => stringFromMetadata(edge.metadata, "targetSymbolId") ?? edge.toId);
  for (const targetId of targetSymbolIds) {
    const target = input.nodes.get(targetId);
    if (target && target.kind !== "Package" && target.kind !== "File") {
      return target;
    }
  }
  return undefined;
}

function applyTypeRelationshipEdges(input: ApplyRelationshipGraphFactsInput): void {
  const symbols = allSymbols(input);
  for (const [relativePath, fileFact] of input.fileFactsByRelativePath) {
    const sourceSymbols = input.astSymbolsByFile.get(relativePath) ?? [];
    for (const declaration of fileFact.declarations) {
      const sourceSymbol = sourceSymbols.find((symbol) => symbolNameMatches(symbol, declaration.qualifiedName));
      if (!sourceSymbol) {
        continue;
      }
      for (const targetName of heritageNames(declaration.sourceText, "extends")) {
        const target = findSymbolByName(symbols, targetName, relativePath);
        if (target && target.id !== sourceSymbol.id) {
          input.addEdge("EXTENDS", sourceSymbol.id, target.id, input.workspaceName, input.repo.name, typeRelationshipMetadata(input.repo.name, relativePath, declaration.range, "extends"));
        }
      }
      for (const targetName of heritageNames(declaration.sourceText, "implements")) {
        const target = findSymbolByName(symbols, targetName, relativePath);
        if (target && target.id !== sourceSymbol.id) {
          input.addEdge("IMPLEMENTS", sourceSymbol.id, target.id, input.workspaceName, input.repo.name, typeRelationshipMetadata(input.repo.name, relativePath, declaration.range, "implements"));
        }
      }
    }
  }
}

function applyStaticCallRelationshipEdges(input: ApplyRelationshipGraphFactsInput): void {
  const symbols = allSymbols(input);
  for (const [relativePath, fileFact] of input.fileFactsByRelativePath) {
    for (const call of fileFact.calls) {
      const sourceSymbols = symbolsContainingCall(input, relativePath, call);
      if (sourceSymbols.length === 0) {
        continue;
      }
      const targets = staticCallTargets(input, symbols, relativePath, fileFact, call);
      for (const source of sourceSymbols) {
        for (const target of targets) {
          if (source.id === target.id) {
            continue;
          }
          input.addEdge("CALLS", source.id, target.id, input.workspaceName, input.repo.name, staticCallMetadata(input.repo.name, relativePath, call));
        }
        const injectedTargets = injectedMemberCallTargets(symbols, relativePath, fileFact, call);
        for (const injectedTarget of injectedTargets) {
          if (source.id === injectedTarget.id) {
            continue;
          }
          input.addEdge(
            "CALLS",
            source.id,
            injectedTarget.id,
            input.workspaceName,
            input.repo.name,
            injectedMemberCallMetadata(input.repo.name, relativePath, call, injectedTarget),
          );
        }
      }
    }
    for (const access of fileFact.memberAccesses) {
      const target = memberAccessTarget(symbols, access);
      if (!target) {
        continue;
      }
      for (const source of symbolsContainingAccess(input, relativePath, access)) {
        if (source.id !== target.id) {
          input.addEdge("REFERENCES", source.id, target.id, input.workspaceName, input.repo.name, memberAccessMetadata(input.repo.name, relativePath, access));
        }
      }
    }
  }
}

function applyAmbientModuleRelationships(input: ApplyRelationshipGraphFactsInput): void {
  const symbols = allSymbols(input);
  const ambientModules = symbols.filter((symbol) => symbol.metadata.declarationKind === "AmbientModule");
  for (const [relativePath, fileFact] of input.fileFactsByRelativePath) {
    const fileNode = input.fileNodes.get(relativePath);
    if (!fileNode) {
      continue;
    }
    for (const importFact of fileFact.imports) {
      const ambientModule = ambientModules.find((symbol) => symbol.name === importFact.moduleSpecifier);
      if (!ambientModule) {
        continue;
      }
      const metadata = ambientModuleMetadata(input.repo.name, relativePath, importFact.range);
      input.addEdge("IMPORTS", fileNode.id, ambientModule.id, input.workspaceName, input.repo.name, metadata);
      const importedSymbol = importFact.importedName
        ? symbols.find((symbol) =>
            symbol.file === ambientModule.file &&
            symbol.name === importFact.importedName &&
            (symbol.metadata.parentName === ambientModule.name ||
              stringFromMetadata(symbol.metadata, "qualifiedName") === `${ambientModule.name}.${importFact.importedName}`)
          )
        : undefined;
      if (!importedSymbol) {
        continue;
      }
      input.addEdge("IMPORTS", fileNode.id, importedSymbol.id, input.workspaceName, input.repo.name, metadata);
      const calls = fileFact.calls.filter((call) => call.name === importFact.localName || call.name === importFact.importedName);
      for (const call of calls) {
        for (const source of symbolsContainingCall(input, relativePath, call)) {
          input.addEdge("REFERENCES", source.id, importedSymbol.id, input.workspaceName, input.repo.name, {
            ...metadata,
            evidenceSources: ["ambient-module", "tree-sitter-call"],
            roles: ["ReadAccess", "Call"],
            range: call.range,
          });
          input.addEdge("CALLS", source.id, importedSymbol.id, input.workspaceName, input.repo.name, {
            ...metadata,
            evidenceSources: ["ambient-module", "tree-sitter-call"],
            roles: ["Call"],
            range: call.range,
          });
        }
      }
    }
  }
}

function applyDynamicTemplateImportRelationships(input: ApplyRelationshipGraphFactsInput): void {
  for (const [relativePath, fileFact] of input.fileFactsByRelativePath) {
    const fileNode = input.fileNodes.get(relativePath);
    if (!fileNode) {
      continue;
    }
    for (const importFact of fileFact.imports) {
      if (importFact.importKind !== "dynamic" || !importFact.moduleSpecifier.includes("${")) {
        continue;
      }
      const moduleNode = input.addNode({
        id: createStableId({
          kind: "module",
          workspace: input.workspaceName,
          repo: input.repo.name,
          commit: input.repo.commit,
          relativePath,
          suffix: `unresolved-${importFact.idSuffix}`,
        }),
        kind: "Module",
        workspace: input.workspaceName,
        repo: input.repo.name,
        packageName: fileNode.packageName,
        file: relativePath,
        name: importFact.moduleSpecifier,
        language: fileNode.language,
        range: importFact.range,
        textHash: importFact.contentHash,
        metadata: {
          fileKind: fileNode.metadata.fileKind,
          symbolKind: "Module",
          moduleSpecifier: importFact.moduleSpecifier,
          unresolved: true,
          unresolvedStatus: "unresolved-dynamic",
          fallbackReason: "unresolved-dynamic",
          ownerRepo: input.repo.name,
          ownerFile: relativePath,
          origin: "module-resolution",
          source: "module-resolution",
          evidenceSources: ["dynamic-template", "unresolved"],
          confidence: "unresolved",
        },
      });
      input.addEdge("IMPORTS", fileNode.id, moduleNode.id, input.workspaceName, input.repo.name, {
        ownerRepo: input.repo.name,
        ownerFile: relativePath,
        origin: "module-resolution",
        source: "module-resolution",
        evidenceSources: ["dynamic-template", "unresolved"],
        confidence: "unresolved",
        moduleSpecifier: importFact.moduleSpecifier,
        importKind: importFact.importKind,
        range: importFact.range,
        fallbackReason: "unresolved-dynamic",
        unresolved: true,
        unresolvedStatus: "unresolved-dynamic",
        roles: ["Import"],
      });
    }
  }
}

function applySideEffectImportRelationships(input: ApplyRelationshipGraphFactsInput): void {
  for (const [relativePath, fileFact] of input.fileFactsByRelativePath) {
    const fileNode = input.fileNodes.get(relativePath);
    if (!fileNode) {
      continue;
    }
    for (const importFact of fileFact.imports) {
      if (importFact.importKind !== "side-effect") {
        continue;
      }
      const targetFile = resolveRelativeFile(relativePath, importFact.moduleSpecifier, input.fileNodes);
      const targetNode = targetFile ? input.fileNodes.get(targetFile) : undefined;
      if (!targetNode) {
        continue;
      }
      input.addEdge("IMPORTS", fileNode.id, targetNode.id, input.workspaceName, input.repo.name, {
        ownerRepo: input.repo.name,
        ownerFile: relativePath,
        origin: "module-resolution",
        source: "module-resolution",
        evidenceSources: ["tree-sitter-import", "module-resolution", "side-effect"],
        confidence: "medium",
        relationship: "side-effect",
        relationshipTags: ["side-effect"],
        moduleSpecifier: importFact.moduleSpecifier,
        importKind: importFact.importKind,
        range: importFact.range,
        targetFile,
        roles: ["Import"],
      });
    }
  }
}

function applyDiscriminatedUnionRelationships(input: ApplyRelationshipGraphFactsInput): void {
  const symbols = allSymbols(input);
  for (const [relativePath, fileFact] of input.fileFactsByRelativePath) {
    const fileSymbols = input.astSymbolsByFile.get(relativePath) ?? [];
    const variantSymbols = fileSymbols.filter((symbol) =>
      ["TypeAlias", "Interface", "Symbol"].includes(symbol.kind) &&
      typeof symbol.name === "string" &&
      new RegExp(`kind\\s*:\\s*['"]${symbol.name.toLowerCase()}['"]`, "i").test(String(symbol.metadata.sourceText ?? ""))
    );
    const localVariants = variantSymbols.length > 0
      ? variantSymbols
      : fileSymbols.filter((symbol) => ["Success", "Failure"].includes(symbol.name ?? ""));
    if (localVariants.length === 0) {
      continue;
    }
    for (const declaration of fileFact.declarations) {
      if (declaration.kind !== "Function" && declaration.kind !== "VariableFunction") {
        continue;
      }
      const source = fileSymbols.find((symbol) => symbolNameMatches(symbol, declaration.qualifiedName));
      if (!source) {
        continue;
      }
      for (const target of localVariants) {
        if (!target.name || !declaration.sourceText.toLowerCase().includes(`"${target.name.toLowerCase()}"`) &&
          !declaration.sourceText.toLowerCase().includes(`'${target.name.toLowerCase()}'`)) {
          continue;
        }
        const resolvedTarget = findSymbolByName(symbols, target.name, relativePath) ?? target;
        input.addEdge("REFERENCES", source.id, resolvedTarget.id, input.workspaceName, input.repo.name, {
          ownerRepo: input.repo.name,
          ownerFile: relativePath,
          origin: "tree-sitter-discriminated-union",
          source: "tree-sitter-discriminated-union",
          relationship: "type-use",
          relationshipTags: ["discriminated-union", "type-use"],
          evidenceSources: ["discriminated-union", "type-use", "tree-sitter-declaration"],
          confidence: "medium",
          range: declaration.range,
          roles: ["ReadAccess", "Type"],
        });
      }
    }
  }
}

function applyTransitiveCallRelationshipEdges(input: ApplyRelationshipGraphFactsInput): void {
  const directCallEdges = dedupeDirectCallEdges(
    [...input.edges.values()].filter((edge) =>
      edge.kind === "CALLS" &&
      edgeBelongsToCurrentRepo(edge, input.repo.name) &&
      !metadataArrayIncludes(edge.metadata.evidenceSources, "transitive-call") &&
      !metadataArrayIncludes(edge.metadata.relationshipTags, "transitive-call")
    ),
  );
  const outgoingCalls = new Map<string, CodeEdge[]>();
  for (const edge of directCallEdges) {
    const sourceNode = input.nodes.get(edge.fromId);
    const targetNode = input.nodes.get(edge.toId);
    if (sourceNode?.repo !== input.repo.name || targetNode?.repo !== input.repo.name) {
      continue;
    }
    const edges = outgoingCalls.get(edge.fromId) ?? [];
    edges.push(edge);
    outgoingCalls.set(edge.fromId, edges);
  }
  for (const firstHop of directCallEdges) {
    const source = input.nodes.get(firstHop.fromId);
    const intermediate = input.nodes.get(firstHop.toId);
    if (!isCallableSource(source) || !isCallableSource(intermediate)) {
      continue;
    }
    for (const secondHop of outgoingCalls.get(firstHop.toId) ?? []) {
      const target = input.nodes.get(secondHop.toId);
      if (
        !isCallableSource(target) ||
        target.repo !== input.repo.name ||
        target.id === source.id ||
        target.file === source.file && target.name === source.name
      ) {
        continue;
      }
      input.addEdge("CALLS", source.id, target.id, input.workspaceName, input.repo.name, transitiveCallMetadata(firstHop, secondHop));
    }
  }
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
  const containers = (input.astSymbolsByFile.get(relativePath) ?? []).filter((symbol) =>
    symbol.range && rangeContains(symbol.range, access.range)
  );
  const exactContainers = containingName
    ? containers.filter((symbol) => symbolNameMatches(symbol, containingName))
    : [];
  return uniqueNodes([...exactContainers, ...containers]);
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

function symbolsContainingTypeReference(
  input: ApplyRelationshipGraphFactsInput,
  relativePath: string,
  typeReference: FileFact["typeReferences"][number],
): CodeNode[] {
  const containingName = typeReference.containingDeclarationName;
  const containers = (input.astSymbolsByFile.get(relativePath) ?? []).filter((symbol) =>
    symbol.range && rangeContains(symbol.range, typeReference.range)
  );
  const exactContainers = containingName
    ? containers.filter((symbol) => symbolNameMatches(symbol, containingName))
    : [];
  return uniqueNodes([...exactContainers, ...containers]);
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

function stringArrayFromMetadata(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }
  return typeof value === "string" && value.length > 0 ? [value] : [];
}

function metadataArrayIncludes(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.includes(expected);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function mergeStringArrays(left: unknown, right: unknown): string[] {
  return [...new Set([...toStringArray(left), ...toStringArray(right)])].sort();
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }
  return typeof value === "string" && value.length > 0 ? [value] : [];
}

function isCallableSource(node: CodeNode | undefined): node is CodeNode {
  return Boolean(
    node &&
    node.metadata.fileKind === "source" &&
    ["Function", "Class", "Symbol", "Chunk", "File"].includes(node.kind),
  );
}

function edgeBelongsToCurrentRepo(edge: CodeEdge, repoName: string): boolean {
  return edge.repo === repoName || stringFromMetadata(edge.metadata, "ownerRepo") === repoName;
}

function dedupeDirectCallEdges(edges: CodeEdge[]): CodeEdge[] {
  const deduped = new Map<string, CodeEdge>();
  for (const edge of edges) {
    const key = `${edge.fromId}\0${edge.toId}`;
    const current = deduped.get(key);
    if (!current || callEdgePriority(edge) < callEdgePriority(current)) {
      deduped.set(key, edge);
    }
  }
  return [...deduped.values()];
}

function callEdgePriority(edge: CodeEdge): number {
  let priority = 0;
  if (metadataArrayIncludes(edge.metadata.evidenceSources, "call-evidence-promotion")) priority += 20;
  if (edge.id.includes(":evidence:")) priority += 10;
  if (metadataArrayIncludes(edge.metadata.evidenceSources, "tree-sitter-member-call")) priority -= 2;
  if (metadataArrayIncludes(edge.metadata.evidenceSources, "scip-typescript")) priority -= 3;
  return priority;
}

function transitiveCallMetadata(firstHop: CodeEdge, secondHop: CodeEdge): Record<string, unknown> {
  return {
    ownerRepo: stringFromMetadata(firstHop.metadata, "ownerRepo") ?? stringFromMetadata(secondHop.metadata, "ownerRepo"),
    ownerFile: stringFromMetadata(firstHop.metadata, "ownerFile") ?? stringFromMetadata(secondHop.metadata, "ownerFile"),
    origin: "graph-transitive-call",
    source: "graph-transitive-call",
    relationship: "transitive-call",
    relationshipTags: mergeStringArrays(
      mergeStringArrays(firstHop.metadata.relationshipTags, secondHop.metadata.relationshipTags),
      "transitive-call",
    ),
    evidenceSources: mergeStringArrays(
      mergeStringArrays(firstHop.metadata.evidenceSources, secondHop.metadata.evidenceSources),
      "transitive-call",
    ),
    confidence: firstHop.metadata.confidence === "high" && secondHop.metadata.confidence === "high" ? "high" : "medium",
    roles: mergeStringArrays(mergeStringArrays(firstHop.metadata.roles, secondHop.metadata.roles), "Call"),
    traversalPath: [
      {
        fromId: firstHop.fromId,
        toId: firstHop.toId,
        kind: firstHop.kind,
        evidenceSources: stringArrayFromMetadata(firstHop.metadata, "evidenceSources"),
        confidence: stringFromMetadata(firstHop.metadata, "confidence"),
        ownerFile: stringFromMetadata(firstHop.metadata, "ownerFile"),
      },
      {
        fromId: secondHop.fromId,
        toId: secondHop.toId,
        kind: secondHop.kind,
        evidenceSources: stringArrayFromMetadata(secondHop.metadata, "evidenceSources"),
        confidence: stringFromMetadata(secondHop.metadata, "confidence"),
        ownerFile: stringFromMetadata(secondHop.metadata, "ownerFile"),
      },
    ],
  };
}

function allSymbols(input: ApplyRelationshipGraphFactsInput): CodeNode[] {
  return [...input.astSymbolsByFile.values()].flat();
}

function heritageNames(sourceText: string, keyword: "extends" | "implements"): string[] {
  const match = sourceText.match(new RegExp(`\\b${keyword}\\s+([^\\{]+)`));
  if (!match?.[1]) {
    return [];
  }
  return match[1]
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0]?.replace(/[<>{}]/g, ""))
    .filter((name): name is string => Boolean(name));
}

function findSymbolByName(symbols: CodeNode[], name: string, preferredFile?: string): CodeNode | undefined {
  const simpleName = name.split(".").at(-1) ?? name;
  return [...symbols]
    .filter((symbol) =>
      symbol.name === simpleName ||
      symbol.name === name ||
      stringFromMetadata(symbol.metadata, "qualifiedName") === name ||
      stringFromMetadata(symbol.metadata, "qualifiedName")?.endsWith(`.${name}`)
    )
    .sort((left, right) =>
      (left.file === preferredFile ? 0 : 1) - (right.file === preferredFile ? 0 : 1) ||
      symbolRank(left) - symbolRank(right) ||
      (left.file ?? "").localeCompare(right.file ?? "") ||
      (left.name ?? "").localeCompare(right.name ?? ""),
    )[0];
}

function typeReferenceTargets(
  symbols: CodeNode[],
  typeReference: FileFact["typeReferences"][number],
  preferredFile?: string,
): CodeNode[] {
  const names = [...new Set([typeReference.referenceText, typeReference.name])];
  const targets = names
    .map((name) => findSymbolByName(symbols, name, preferredFile))
    .filter((node): node is CodeNode => Boolean(node));
  return uniqueNodes(targets);
}

function staticCallTargets(
  input: ApplyRelationshipGraphFactsInput,
  symbols: CodeNode[],
  relativePath: string,
  fileFact: FileFact,
  call: FileFact["calls"][number],
): CodeNode[] {
  const targets: CodeNode[] = [];
  if (call.receiver === "this" && call.propertyName && call.containingDeclarationName?.includes(".")) {
    const className = call.containingDeclarationName.split(".")[0]!;
    const target = findQualifiedSymbol(symbols, `${className}.${call.propertyName}`, relativePath);
    if (target) targets.push(target);
  }
  if (call.receiver === "super" && call.propertyName && call.containingDeclarationName?.includes(".")) {
    const className = call.containingDeclarationName.split(".")[0]!;
    const classDeclaration = fileFact.declarations.find((declaration) => declaration.name === className && declaration.kind === "Class");
    const parentClass = classDeclaration ? heritageNames(classDeclaration.sourceText, "extends")[0] : undefined;
    const target = parentClass ? findQualifiedSymbol(symbols, `${parentClass}.${call.propertyName}`) : undefined;
    if (target) targets.push(target);
  }
  if (call.propertyName && ["bind", "call", "apply"].includes(call.propertyName) && call.receiver) {
    const target = findSymbolByName(symbols.filter((symbol) => symbol.file === relativePath), call.receiver, relativePath);
    if (target) targets.push(target);
  }
  if (call.callKind === "tagged-template") {
    const target = findSymbolByName(symbols.filter((symbol) => symbol.file === relativePath), call.name, relativePath);
    if (target) targets.push(target);
  }
  if (call.memberPath && call.propertyName) {
    const target = memberCallTarget(symbols, call);
    if (target) targets.push(target);
  }
  return uniqueNodes(targets);
}

function memberCallTarget(symbols: CodeNode[], call: FileFact["calls"][number]): CodeNode | undefined {
  if (!call.memberPath || !call.propertyName) {
    return undefined;
  }
  const memberPath = call.memberPath;
  const shortMemberPath = memberPath.split(".").slice(-2).join(".");
  return symbols
    .filter((symbol) =>
      symbol.name === call.propertyName &&
      (stringFromMetadata(symbol.metadata, "qualifiedName") === memberPath ||
        stringFromMetadata(symbol.metadata, "qualifiedName")?.endsWith(`.${memberPath}`) ||
        stringFromMetadata(symbol.metadata, "qualifiedName")?.endsWith(`.${shortMemberPath}`))
    )
    .sort((left, right) => symbolRank(left) - symbolRank(right))[0];
}

function injectedMemberCallTargets(
  symbols: CodeNode[],
  relativePath: string,
  fileFact: FileFact,
  call: FileFact["calls"][number],
): CodeNode[] {
  const injectedMemberName = injectedMemberNameForCall(call);
  if (!injectedMemberName || !call.containingDeclarationName?.includes(".")) {
    return [];
  }
  const className = call.containingDeclarationName.split(".")[0]!;
  const injectedTypeName = injectedMemberTypeName(fileFact, className, injectedMemberName);
  if (!injectedTypeName) {
    return [];
  }
  const methodTarget = call.propertyName
    ? findQualifiedSymbol(symbols, `${injectedTypeName}.${call.propertyName}`)
      ?? findMemberSymbolOnType(symbols, injectedTypeName, call.propertyName)
    : undefined;
  const classTarget = findSymbolByName(symbols, injectedTypeName, relativePath);
  return uniqueNodes([methodTarget, classTarget].filter((node): node is CodeNode => Boolean(node)));
}

function injectedMemberNameForCall(call: FileFact["calls"][number]): string | undefined {
  const memberPath = call.memberPath ?? call.receiver;
  const match = memberPath?.match(/^this\??\.(?:#)?([A-Za-z_$][\w$]*)/);
  return match?.[1];
}

function injectedMemberTypeName(fileFact: FileFact, className: string, injectedMemberName: string): string | undefined {
  const classDeclaration = fileFact.declarations.find(
    (declaration) => declaration.kind === "Class" && declaration.name === className,
  );
  if (!classDeclaration) {
    return undefined;
  }
  const sourceText = classDeclaration.sourceText;
  const escapedName = escapeRegExp(injectedMemberName);
  const match = sourceText.match(new RegExp(`\\b${escapedName}\\??\\s*:\\s*([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)?)`));
  return match?.[1];
}

function memberAccessTarget(symbols: CodeNode[], access: FileFact["memberAccesses"][number]): CodeNode | undefined {
  return symbols
    .filter((symbol) =>
      symbol.name === access.propertyName &&
      (stringFromMetadata(symbol.metadata, "qualifiedName") === access.path ||
        stringFromMetadata(symbol.metadata, "qualifiedName")?.endsWith(`.${access.path}`) ||
        stringFromMetadata(symbol.metadata, "qualifiedName")?.endsWith(`.${access.path.split(".").slice(-2).join(".")}`) ||
        symbol.metadata.parentName === access.path.split(".").slice(0, -1).join("."))
    )
    .sort((left, right) => symbolRank(left) - symbolRank(right))[0];
}

function findMemberSymbolOnType(symbols: CodeNode[], typeName: string, memberName: string): CodeNode | undefined {
  return symbols
    .filter((symbol) =>
      symbol.name === memberName &&
      (symbol.metadata.parentName === typeName ||
        stringFromMetadata(symbol.metadata, "qualifiedName") === `${typeName}.${memberName}` ||
        stringFromMetadata(symbol.metadata, "qualifiedName")?.endsWith(`.${typeName}.${memberName}`))
    )
    .sort((left, right) => symbolRank(left) - symbolRank(right))[0];
}

function findQualifiedSymbol(symbols: CodeNode[], qualifiedName: string, preferredFile?: string): CodeNode | undefined {
  return symbols
    .filter((symbol) => stringFromMetadata(symbol.metadata, "qualifiedName") === qualifiedName)
    .sort((left, right) =>
      (left.file === preferredFile ? 0 : 1) - (right.file === preferredFile ? 0 : 1) ||
      symbolRank(left) - symbolRank(right)
    )[0];
}

function typeRelationshipMetadata(
  repo: string,
  file: string,
  range: FileFact["declarations"][number]["range"],
  relationship: "extends" | "implements",
): Record<string, unknown> {
  return {
    ownerRepo: repo,
    ownerFile: file,
    origin: "tree-sitter-type-relationship",
    source: "tree-sitter-type-relationship",
    relationship,
    typeRelationship: relationship,
    relationshipTags: ["type-relationship", relationship],
    evidenceSources: ["type-relationship", "tree-sitter-declaration"],
    confidence: "high",
    range,
    roles: ["Definition"],
  };
}

function typeReferenceMetadata(
  repo: string,
  file: string,
  typeReference: FileFact["typeReferences"][number],
  target: CodeNode,
): Record<string, unknown> {
  return {
    ownerRepo: repo,
    ownerFile: file,
    origin: "tree-sitter-type-reference",
    source: "tree-sitter-type-reference",
    relationship: "type-use",
    typeRelationship: "type-use",
    typeReferenceKind: typeReference.referenceKind,
    relationshipTags: ["type-use", typeReference.referenceKind],
    evidenceSources: ["tree-sitter-type-reference", "type-use", typeReference.referenceKind],
    confidence: "medium",
    range: typeReference.range,
    containingChunkIdSuffix: typeReference.containingChunkIdSuffix,
    referenceText: typeReference.referenceText,
    targetFile: target.file,
    targetSymbolId: target.id,
    targetSymbolName: target.name,
    targetSymbolKind: target.kind,
    roles: ["ReadAccess", "Type"],
  };
}

function staticCallMetadata(repo: string, file: string, call: FileFact["calls"][number]): Record<string, unknown> {
  const evidence = ["tree-sitter-call"];
  if (call.callKind === "member") evidence.push("tree-sitter-member-call");
  if (call.receiver === "super") evidence.push("super-call");
  if (call.receiver === "this") evidence.push("this-call");
  if (call.propertyName && ["bind", "call", "apply"].includes(call.propertyName)) evidence.push("bind-call-apply");
  if (call.callKind === "tagged-template") evidence.push("tagged-template");
  return {
    ownerRepo: repo,
    ownerFile: file,
    origin: "tree-sitter-call",
    source: "tree-sitter-call",
    relationship: call.callKind === "member" ? "member-call" : call.callKind,
    relationshipTags: evidence.filter((source) => source !== "tree-sitter-call"),
    evidenceSources: evidence,
    confidence: "medium",
    memberPath: call.memberPath,
    receiver: call.receiver,
    propertyName: call.propertyName,
    callKind: call.callKind,
    range: call.range,
    containingChunkIdSuffix: call.containingChunkIdSuffix,
    roles: ["Call"],
  };
}

function injectedMemberCallMetadata(
  repo: string,
  file: string,
  call: FileFact["calls"][number],
  target: CodeNode,
): Record<string, unknown> {
  return {
    ownerRepo: repo,
    ownerFile: file,
    origin: "tree-sitter-call",
    source: "tree-sitter-call",
    relationship: "injected-member-call",
    relationshipTags: ["injected-member-call", "member-call", "type-use"],
    evidenceSources: ["tree-sitter-call", "tree-sitter-member-call", "type-use"],
    confidence: "medium",
    memberPath: call.memberPath,
    receiver: call.receiver,
    propertyName: call.propertyName,
    injectedPropertyName: injectedMemberNameForCall(call),
    injectedTypeName: target.name,
    callKind: call.callKind,
    range: call.range,
    containingChunkIdSuffix: call.containingChunkIdSuffix,
    roles: ["Call", "ReadAccess", "Type"],
  };
}

function memberAccessMetadata(repo: string, file: string, access: FileFact["memberAccesses"][number]): Record<string, unknown> {
  return {
    ownerRepo: repo,
    ownerFile: file,
    origin: "tree-sitter-member-access",
    source: "tree-sitter-member-access",
    relationship: "property-access",
    relationshipTags: ["property-access"],
    evidenceSources: ["tree-sitter-member-access"],
    confidence: "medium",
    memberPath: access.path,
    propertyName: access.propertyName,
    range: access.range,
    containingChunkIdSuffix: access.containingChunkIdSuffix,
    roles: ["ReadAccess"],
  };
}

function importedMemberCallMetadata(
  repo: string,
  file: string,
  importFact: FileFact["imports"][number],
  call: FileFact["calls"][number],
  target: CodeNode,
): Record<string, unknown> {
  const databaseClient = isDatabaseClientImportCall(importFact, call, target);
  const relationshipTags = ["member-call", ...(databaseClient ? ["mutation-to-database", "database-client-convention"] : [])];
  return {
    ownerRepo: repo,
    ownerFile: file,
    origin: "module-resolution",
    source: "module-resolution",
    relationship: "member-call",
    relationshipTags,
    evidenceSources: [
      "module-resolution",
      "tree-sitter-import",
      "tree-sitter-member-call",
      ...(target.metadata.scipSymbol ? ["scip-typescript"] : ["tree-sitter-declaration"]),
      ...relationshipTags,
    ],
    confidence: "high",
    moduleSpecifier: importFact.moduleSpecifier,
    importKind: importFact.importKind,
    importedName: importFact.importedName,
    localName: importFact.localName,
    targetFile: target.file,
    targetSymbolId: target.id,
    targetSymbolName: target.name,
    targetSymbolKind: target.kind,
    memberPath: call.memberPath,
    receiver: call.receiver,
    propertyName: call.propertyName,
    callKind: call.callKind,
    range: call.range,
    containingChunkIdSuffix: call.containingChunkIdSuffix,
    roles: ["Call", "Import", "ReadAccess"],
  };
}

function isDatabaseClientImportCall(
  importFact: FileFact["imports"][number],
  call: FileFact["calls"][number],
  target: CodeNode,
): boolean {
  const targetFile = target.file ?? "";
  return importFact.localName === "prisma" ||
    call.memberPath?.startsWith("prisma.") === true ||
    /(^|\/)(database|db)\//.test(targetFile) ||
    /(^|[-/])(database|db)$/.test(importFact.moduleSpecifier);
}

function ambientModuleMetadata(repo: string, file: string, range: FileFact["imports"][number]["range"]): Record<string, unknown> {
  return {
    ownerRepo: repo,
    ownerFile: file,
    origin: "ambient-module",
    source: "ambient-module",
    relationship: "ambient-module",
    relationshipTags: ["ambient-module"],
    evidenceSources: ["ambient-module", "module-resolution"],
    confidence: "medium",
    range,
    roles: ["Import", "ReadAccess"],
  };
}

function resolveRelativeFile(
  importerFile: string,
  moduleSpecifier: string,
  fileNodes: Map<string, CodeNode>,
): string | undefined {
  const base = normalizeRelativePath(join(dirname(importerFile), stripKnownSourceExtension(moduleSpecifier)));
  const extensions = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
  for (const extension of extensions) {
    const candidate = `${base}${extension}`;
    if (fileNodes.has(candidate)) return candidate;
  }
  for (const extension of extensions.slice(1)) {
    const candidate = `${base}/index${extension}`;
    if (fileNodes.has(candidate)) return candidate;
  }
  return undefined;
}

function stripKnownSourceExtension(moduleSpecifier: string): string {
  return moduleSpecifier.replace(/\.(?:d\.)?[cm]?[jt]sx?$/, "");
}

function uniqueNodes(nodes: CodeNode[]): CodeNode[] {
  return [...new Map(nodes.map((node) => [node.id, node])).values()];
}

function symbolRank(node: CodeNode): number {
  if (node.metadata.scipSymbol) return 0;
  if (node.kind === "Function" || node.kind === "Class" || node.kind === "Interface") return 1;
  return 2;
}
