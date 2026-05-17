import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import ts from "typescript";
import { z } from "zod";

import { normalizeRelativePath } from "../core/ids.js";
import { writeJsonAtomically } from "../core/index-artifacts.js";
import { RangeSchema, schemaVersion, type CodeNode } from "../schema/schemas.js";
import type { DiscoveredPackage, DiscoveredRepo } from "../workspace/discovery.js";
import type { FileFact } from "./fact-cache.js";

export const resolvedFactsSchemaVersion = "code-intel.resolved-facts.v1";

export interface ResolvedModuleTarget {
  status: "resolved" | "unresolved" | "external";
  targetFile?: string;
  targetPackage?: string;
  targetPackageExport?: string;
  resolutionSource?: string;
  fallbackReason?: string;
}

export interface ResolvedImportFact extends ResolvedModuleTarget {
  id: string;
  ownerRepo: string;
  importerFile: string;
  importIdSuffix: string;
  moduleSpecifier: string;
  importKind: FileFact["imports"][number]["importKind"];
  importedName?: string;
  localName?: string;
  isDefault: boolean;
  isNamespace: boolean;
  sourceRange: FileFact["imports"][number]["range"];
  containingChunkIdSuffix?: string;
  targetSymbolId?: string;
  targetSymbolName?: string;
  targetSymbolKind?: string;
  confidence: "high" | "medium" | "fallback" | "unresolved";
}

export interface ResolvedExportFact extends ResolvedModuleTarget {
  id: string;
  ownerRepo: string;
  exporterFile: string;
  exportIdSuffix: string;
  exportKind: FileFact["exports"][number]["exportKind"];
  exportedName: string;
  localName?: string;
  moduleSpecifier?: string;
  sourceRange: FileFact["exports"][number]["range"];
  containingChunkIdSuffix?: string;
  targetSymbolId?: string;
  targetSymbolName?: string;
  targetSymbolKind?: string;
  confidence: "high" | "medium" | "fallback" | "unresolved";
}

export interface ResolvedPackageExportFact extends ResolvedModuleTarget {
  id: string;
  ownerRepo: string;
  packageName: string;
  packageRelativePath: string;
  exportName: string;
  targetPattern?: string;
}

export interface RepoResolvedModuleFacts {
  name: string;
  imports: ResolvedImportFact[];
  exports: ResolvedExportFact[];
  packageExports: ResolvedPackageExportFact[];
}

export interface ResolvedModuleFacts {
  schemaVersion: typeof schemaVersion;
  factsSchemaVersion: typeof resolvedFactsSchemaVersion;
  workspace: string;
  generatedAt: string;
  repos: RepoResolvedModuleFacts[];
}

export interface BuildRepoResolvedModuleFactsInput {
  repo: DiscoveredRepo;
  fileFactsByRelativePath: Map<string, FileFact>;
  astSymbolsByFile: Map<string, CodeNode[]>;
  scipSymbolNodes: Map<string, CodeNode>;
}

const ResolvedModuleTargetSchema = z.object({
  status: z.enum(["resolved", "unresolved", "external"]),
  targetFile: z.string().optional(),
  targetPackage: z.string().optional(),
  targetPackageExport: z.string().optional(),
  resolutionSource: z.string().optional(),
  fallbackReason: z.string().optional(),
});

const ResolvedImportFactSchema = ResolvedModuleTargetSchema.extend({
  id: z.string().min(1),
  ownerRepo: z.string().min(1),
  importerFile: z.string().min(1),
  importIdSuffix: z.string().min(1),
  moduleSpecifier: z.string().min(1),
  importKind: z.enum(["value", "type", "side-effect", "dynamic", "commonjs"]),
  importedName: z.string().optional(),
  localName: z.string().optional(),
  isDefault: z.boolean(),
  isNamespace: z.boolean(),
  sourceRange: RangeSchema.required(),
  containingChunkIdSuffix: z.string().optional(),
  targetSymbolId: z.string().optional(),
  targetSymbolName: z.string().optional(),
  targetSymbolKind: z.string().optional(),
  confidence: z.enum(["high", "medium", "fallback", "unresolved"]),
});

const ResolvedExportFactSchema = ResolvedModuleTargetSchema.extend({
  id: z.string().min(1),
  ownerRepo: z.string().min(1),
  exporterFile: z.string().min(1),
  exportIdSuffix: z.string().min(1),
  exportKind: z.enum(["local", "re-export", "default", "commonjs", "type"]),
  exportedName: z.string().min(1),
  localName: z.string().optional(),
  moduleSpecifier: z.string().optional(),
  sourceRange: RangeSchema.required(),
  containingChunkIdSuffix: z.string().optional(),
  targetSymbolId: z.string().optional(),
  targetSymbolName: z.string().optional(),
  targetSymbolKind: z.string().optional(),
  confidence: z.enum(["high", "medium", "fallback", "unresolved"]),
});

const ResolvedPackageExportFactSchema = ResolvedModuleTargetSchema.extend({
  id: z.string().min(1),
  ownerRepo: z.string().min(1),
  packageName: z.string().min(1),
  packageRelativePath: z.string().min(1),
  exportName: z.string().min(1),
  targetPattern: z.string().optional(),
});

const RepoResolvedModuleFactsSchema = z.object({
  name: z.string().min(1),
  imports: z.array(ResolvedImportFactSchema),
  exports: z.array(ResolvedExportFactSchema),
  packageExports: z.array(ResolvedPackageExportFactSchema),
});

const ResolvedModuleFactsSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  factsSchemaVersion: z.literal(resolvedFactsSchemaVersion),
  workspace: z.string().min(1),
  generatedAt: z.string().datetime(),
  repos: z.array(RepoResolvedModuleFactsSchema),
});

const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export async function buildRepoResolvedModuleFacts(
  input: BuildRepoResolvedModuleFactsInput,
): Promise<RepoResolvedModuleFacts> {
  const context = await createResolutionContext(input);
  const packageExports = buildPackageExportFacts(context);
  const exports = buildResolvedExportFacts(context);
  const exportTargets = createExportTargetIndex(exports);
  const imports = buildResolvedImportFacts(context, exportTargets, exports);
  return {
    name: input.repo.name,
    imports,
    exports,
    packageExports,
  };
}

export async function writeResolvedModuleFacts(
  generationPath: string,
  facts: ResolvedModuleFacts,
): Promise<void> {
  await mkdir(join(generationPath, "facts"), { recursive: true });
  await writeJsonAtomically(
    join(generationPath, "facts", "resolution.json"),
    ResolvedModuleFactsSchema.parse(facts),
  );
}

interface ResolutionContext extends BuildRepoResolvedModuleFactsInput {
  filesByRelativePath: Map<string, string>;
  packagesByName: Map<string, DiscoveredPackage>;
  packageByFile: Map<string, DiscoveredPackage>;
  symbolsByFile: Map<string, CodeNode[]>;
  compilerOptions: ts.CompilerOptions;
  tsPaths: string[];
}

async function createResolutionContext(input: BuildRepoResolvedModuleFactsInput): Promise<ResolutionContext> {
  return {
    ...input,
    filesByRelativePath: new Map(input.repo.files.map((file) => [file.relativePath, file.absolutePath])),
    packagesByName: new Map(input.repo.packages.map((pkg) => [pkg.name, pkg])),
    packageByFile: createPackageByFile(input.repo),
    symbolsByFile: createSymbolIndex(input.astSymbolsByFile, input.scipSymbolNodes),
    ...(await loadCompilerResolution(input.repo.path)),
  };
}

function buildPackageExportFacts(context: ResolutionContext): ResolvedPackageExportFact[] {
  return context.repo.packages.flatMap((pkg) => {
    const packageRelativePath = repoRelativePath(context.repo, pkg.path);
    return packageExportEntries(pkg.exports).map((entry) => {
      const target = resolvePackageExportTarget(context, pkg, entry.exportName);
      return {
        id: `${pkg.name}:${entry.exportName}`,
        ownerRepo: context.repo.name,
        packageName: pkg.name,
        packageRelativePath,
        exportName: entry.exportName,
        targetPattern: entry.targetPattern,
        ...target,
      };
    });
  }).sort(compareById);
}

function buildResolvedExportFacts(context: ResolutionContext): ResolvedExportFact[] {
  const facts: ResolvedExportFact[] = [];
  for (const [relativePath, fileFact] of context.fileFactsByRelativePath) {
    for (const exportFact of fileFact.exports) {
      const target = exportFact.moduleSpecifier
        ? resolveModuleSpecifier(context, relativePath, exportFact.moduleSpecifier)
        : {
            status: "resolved" as const,
            targetFile: relativePath,
            targetPackage: context.packageByFile.get(relativePath)?.name,
            resolutionSource: "local-export",
          };
      const targetSymbol = target.targetFile
        ? resolveExportTargetSymbol(context, target.targetFile, exportFact.localName, exportFact.exportedName)
        : undefined;
      facts.push({
        id: `${relativePath}:${exportFact.idSuffix}`,
        ownerRepo: context.repo.name,
        exporterFile: relativePath,
        exportIdSuffix: exportFact.idSuffix,
        exportKind: exportFact.exportKind,
        exportedName: exportFact.exportedName,
        localName: exportFact.localName,
        moduleSpecifier: exportFact.moduleSpecifier,
        sourceRange: exportFact.range,
        containingChunkIdSuffix: exportFact.containingChunkIdSuffix,
        ...target,
        targetSymbolId: targetSymbol?.id,
        targetSymbolName: targetSymbol?.name,
        targetSymbolKind: targetSymbol?.kind,
        confidence: confidenceForTarget(target, targetSymbol),
      });
    }
  }
  return facts.sort(compareById);
}

function buildResolvedImportFacts(
  context: ResolutionContext,
  exportTargets: Map<string, ResolvedExportFact>,
  exports: ResolvedExportFact[],
): ResolvedImportFact[] {
  const facts: ResolvedImportFact[] = [];
  for (const [relativePath, fileFact] of context.fileFactsByRelativePath) {
    for (const importFact of fileFact.imports) {
      const target = resolveModuleSpecifier(context, relativePath, importFact.moduleSpecifier);
      const targetSymbol = target.targetFile
        ? resolveImportTargetSymbol(context, exportTargets, exports, target.targetFile, importFact)
        : undefined;
      facts.push({
        id: `${relativePath}:${importFact.idSuffix}`,
        ownerRepo: context.repo.name,
        importerFile: relativePath,
        importIdSuffix: importFact.idSuffix,
        moduleSpecifier: importFact.moduleSpecifier,
        importKind: importFact.importKind,
        importedName: importFact.importedName,
        localName: importFact.localName,
        isDefault: importFact.isDefault,
        isNamespace: importFact.isNamespace,
        sourceRange: importFact.range,
        containingChunkIdSuffix: importFact.containingChunkIdSuffix,
        ...target,
        targetSymbolId: targetSymbol?.id,
        targetSymbolName: targetSymbol?.name,
        targetSymbolKind: targetSymbol?.kind,
        confidence: confidenceForTarget(target, targetSymbol),
      });
    }
  }
  return facts.sort(compareById);
}

function resolveModuleSpecifier(
  context: ResolutionContext,
  importerFile: string,
  moduleSpecifier: string,
): ResolvedModuleTarget {
  const tsResolved = resolveWithTypescript(context, importerFile, moduleSpecifier);
  if (tsResolved) {
    return tsResolved;
  }

  if (moduleSpecifier.startsWith(".")) {
    const targetFile = resolveSourceFile(
      context,
      normalizeRelativePath(join(dirname(importerFile), moduleSpecifier)),
    );
    return targetFile
      ? resolvedTarget(context, targetFile, "relative")
      : unresolvedTarget("unresolved-module");
  }

  const packageName = packageNameFromSpecifier(moduleSpecifier);
  if (packageName) {
    const pkg = context.packagesByName.get(packageName);
    if (!pkg) {
      return dependencyIsDeclared(context, importerFile, packageName)
        ? { status: "external", resolutionSource: "external-package", fallbackReason: "external-package" }
        : unresolvedTarget("unresolved-module");
    }
    const subpath = packageSubpath(moduleSpecifier, packageName);
    const packageTarget = resolvePackageExportTarget(context, pkg, subpath);
    if (packageTarget.status === "resolved") {
      return packageTarget;
    }
    return {
      ...packageTarget,
      targetPackage: pkg.name,
      targetPackageExport: subpath,
    };
  }
  return unresolvedTarget("unresolved-module");
}

function resolveWithTypescript(
  context: ResolutionContext,
  importerFile: string,
  moduleSpecifier: string,
): ResolvedModuleTarget | undefined {
  const containingFile = resolve(context.repo.path, importerFile);
  const resolved = ts.resolveModuleName(
    moduleSpecifier,
    containingFile,
    context.compilerOptions,
    ts.sys,
  ).resolvedModule;
  if (!resolved?.resolvedFileName) {
    return undefined;
  }
  const targetFile = sourceFileForAbsolutePath(context, resolved.resolvedFileName);
  if (!targetFile) {
    return undefined;
  }
  return resolvedTarget(context, targetFile, resolutionSourceForTs(context, moduleSpecifier));
}

function resolvePackageExportTarget(
  context: ResolutionContext,
  pkg: DiscoveredPackage,
  exportName: string,
): ResolvedModuleTarget {
  const target = packageExportTarget(pkg.exports, exportName);
  if (!target) {
    const fallbackFile = exportName === "."
      ? resolveSourceFile(context, repoRelativePath(context.repo, join(pkg.path, "src", "index")))
        ?? resolveSourceFile(context, repoRelativePath(context.repo, join(pkg.path, "index")))
      : resolveSourceFile(context, repoRelativePath(context.repo, join(pkg.path, exportName.slice(2))));
    return fallbackFile
      ? resolvedTarget(context, fallbackFile, "package-subpath", pkg.name, exportName)
      : {
          status: "unresolved",
          targetPackage: pkg.name,
          targetPackageExport: exportName,
          resolutionSource: "package-subpath",
          fallbackReason: "unresolved-package-export",
        };
  }
  if (target.includes("*")) {
    return {
      status: "unresolved",
      targetPackage: pkg.name,
      targetPackageExport: exportName,
      resolutionSource: "package-exports",
      fallbackReason: "pattern-package-export",
    };
  }
  const targetFile = resolveSourceFile(context, repoRelativePath(context.repo, resolve(pkg.path, target)));
  return targetFile
    ? resolvedTarget(context, targetFile, "package-exports", pkg.name, exportName)
    : {
        status: "unresolved",
        targetPackage: pkg.name,
        targetPackageExport: exportName,
        resolutionSource: "package-exports",
        fallbackReason: "unresolved-package-export",
      };
}

function packageExportTarget(exportsValue: unknown, exportName: string): string | undefined {
  if (typeof exportsValue === "string") {
    return exportName === "." ? exportsValue : undefined;
  }
  if (!exportsValue || typeof exportsValue !== "object") {
    return undefined;
  }
  const exportsRecord = exportsValue as Record<string, unknown>;
  const exact = conditionalExportTarget(exportsRecord[exportName]);
  if (exact) {
    return exact;
  }
  for (const [key, value] of Object.entries(exportsRecord)) {
    if (!key.includes("*")) {
      continue;
    }
    const match = matchPatternExport(key, exportName);
    if (!match) {
      continue;
    }
    const target = conditionalExportTarget(value);
    return target?.replaceAll("*", match);
  }
  if (exportName === ".") {
    return conditionalExportTarget(exportsRecord);
  }
  return undefined;
}

function conditionalExportTarget(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["types", "import", "default", "require", "node"]) {
    const nested = conditionalExportTarget(record[key]);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function resolveImportTargetSymbol(
  context: ResolutionContext,
  exportTargets: Map<string, ResolvedExportFact>,
  exports: ResolvedExportFact[],
  targetFile: string,
  importFact: FileFact["imports"][number],
): CodeNode | undefined {
  if (importFact.importKind === "side-effect" || importFact.isNamespace) {
    return undefined;
  }
  const exportedName = importFact.importedName === "default"
    ? "default"
    : importFact.importedName ?? importFact.localName;
  const reexport = exportTargets.get(exportKey(targetFile, exportedName));
  if (reexport?.targetSymbolId) {
    return findSymbolById(context, reexport.targetSymbolId);
  }
  const starReexport = resolveStarReexportedSymbol(context, exports, targetFile, exportedName);
  if (starReexport) {
    return starReexport;
  }
  return resolveExportTargetSymbol(context, targetFile, exportedName, importFact.localName);
}

function resolveStarReexportedSymbol(
  context: ResolutionContext,
  exports: ResolvedExportFact[],
  targetFile: string,
  exportedName: string | undefined,
  seen = new Set<string>(),
): CodeNode | undefined {
  if (!exportedName || exportedName === "*") {
    return undefined;
  }
  const seenKey = `${targetFile}:${exportedName}`;
  if (seen.has(seenKey)) {
    return undefined;
  }
  seen.add(seenKey);

  for (const exportFact of exports) {
    if (exportFact.exporterFile !== targetFile || exportFact.exportedName !== "*" || !exportFact.targetFile) {
      continue;
    }
    const direct = resolveExportTargetSymbol(context, exportFact.targetFile, exportedName, exportedName);
    if (direct) {
      return direct;
    }
    const nested = resolveStarReexportedSymbol(context, exports, exportFact.targetFile, exportedName, seen);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function resolveExportTargetSymbol(
  context: ResolutionContext,
  targetFile: string,
  localName: string | undefined,
  exportedName: string | undefined,
): CodeNode | undefined {
  const candidates = context.symbolsByFile.get(targetFile) ?? [];
  const names = [localName, exportedName].filter((name): name is string => Boolean(name && name !== "*"));
  for (const name of names) {
    const direct = candidates.find((symbol) =>
      symbol.name === name || stringFromMetadata(symbol.metadata, "qualifiedName") === name
    );
    if (direct) {
      return direct;
    }
  }
  if (exportedName === "default" && localName) {
    return candidates.find((symbol) => symbol.name === localName);
  }
  return undefined;
}

function createExportTargetIndex(exports: ResolvedExportFact[]): Map<string, ResolvedExportFact> {
  const index = new Map<string, ResolvedExportFact>();
  for (const exportFact of exports) {
    index.set(exportKey(exportFact.exporterFile, exportFact.exportedName), exportFact);
  }
  return index;
}

function createSymbolIndex(
  astSymbolsByFile: Map<string, CodeNode[]>,
  scipSymbolNodes: Map<string, CodeNode>,
): Map<string, CodeNode[]> {
  const byFile = new Map<string, Map<string, CodeNode>>();
  const add = (symbol: CodeNode) => {
    if (!symbol.file) {
      return;
    }
    const fileSymbols = byFile.get(symbol.file) ?? new Map<string, CodeNode>();
    fileSymbols.set(symbol.id, symbol);
    byFile.set(symbol.file, fileSymbols);
  };
  for (const symbols of astSymbolsByFile.values()) {
    for (const symbol of symbols) add(symbol);
  }
  for (const symbol of scipSymbolNodes.values()) add(symbol);
  return new Map(
    [...byFile.entries()].map(([file, symbols]) => [
      file,
      [...symbols.values()].sort((left, right) => symbolResolutionRank(left) - symbolResolutionRank(right)),
    ]),
  );
}

async function loadCompilerResolution(repoPath: string): Promise<{
  compilerOptions: ts.CompilerOptions;
  tsPaths: string[];
}> {
  const configPath = ts.findConfigFile(repoPath, ts.sys.fileExists, "tsconfig.json")
    ?? ts.findConfigFile(repoPath, ts.sys.fileExists, "jsconfig.json");
  if (!configPath) {
    return defaultCompilerResolution(repoPath);
  }
  const parsed = parseCompilerConfig(configPath);
  if (!parsed) {
    return defaultCompilerResolution(repoPath);
  }
  const baseConfigPath = parsed.options.paths
    ? undefined
    : ts.findConfigFile(repoPath, ts.sys.fileExists, "tsconfig.base.json");
  const baseParsed = baseConfigPath ? parseCompilerConfig(baseConfigPath) : undefined;
  const parsedOptions: ts.CompilerOptions = {
    ...(baseParsed?.options ?? {}),
    ...parsed.options,
    baseUrl: parsed.options.baseUrl ?? baseParsed?.options.baseUrl,
    paths: parsed.options.paths ?? baseParsed?.options.paths,
  };
  const compilerOptions = compilerOptionsForResolution(parsedOptions, repoPath);
  return {
    compilerOptions,
    tsPaths: Object.keys(compilerOptions.paths ?? {}),
  };
}

function parseCompilerConfig(configPath: string): ts.ParsedCommandLine | undefined {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error || !config.config) {
    return undefined;
  }
  return ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
}

function compilerOptionsForResolution(parsedOptions: ts.CompilerOptions, repoPath: string): ts.CompilerOptions {
  return {
    ...parsedOptions,
    allowJs: true,
    module: parsedOptions.module ?? ts.ModuleKind.ESNext,
    moduleResolution: parsedOptions.moduleResolution ?? ts.ModuleResolutionKind.Bundler,
    baseUrl: parsedOptions.baseUrl ?? repoPath,
  };
}

function defaultCompilerResolution(repoPath: string): {
  compilerOptions: ts.CompilerOptions;
  tsPaths: string[];
} {
  return {
    compilerOptions: {
      allowJs: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      baseUrl: repoPath,
    },
    tsPaths: [],
  };
}

function resolveSourceFile(context: ResolutionContext, candidateRelativePath: string): string | undefined {
  const normalized = normalizeRelativePath(candidateRelativePath);
  if (context.filesByRelativePath.has(normalized)) {
    return normalized;
  }
  const withoutExtension = stripKnownExtension(normalized);
  for (const extension of sourceExtensions) {
    const withExtension = `${withoutExtension}${extension}`;
    if (context.filesByRelativePath.has(withExtension)) {
      return withExtension;
    }
  }
  for (const extension of sourceExtensions) {
    const indexPath = `${withoutExtension.replace(/\/$/, "")}/index${extension}`;
    if (context.filesByRelativePath.has(indexPath)) {
      return indexPath;
    }
  }
  return undefined;
}

function sourceFileForAbsolutePath(context: ResolutionContext, path: string): string | undefined {
  const repoPath = normalizeAbsolutePath(context.repo.path);
  const absolutePath = normalizeAbsolutePath(stripKnownExtension(path));
  if (!absolutePath.startsWith(`${repoPath}/`) && absolutePath !== repoPath) {
    return undefined;
  }
  return resolveSourceFile(context, normalizeRelativePath(relative(repoPath, absolutePath)));
}

function resolvedTarget(
  context: ResolutionContext,
  targetFile: string,
  resolutionSource: string,
  targetPackage = context.packageByFile.get(targetFile)?.name,
  targetPackageExport?: string,
): ResolvedModuleTarget {
  return {
    status: "resolved",
    targetFile,
    targetPackage,
    targetPackageExport,
    resolutionSource,
  };
}

function unresolvedTarget(fallbackReason: string): ResolvedModuleTarget {
  return {
    status: "unresolved",
    fallbackReason,
  };
}

function confidenceForTarget(target: ResolvedModuleTarget, symbol: CodeNode | undefined): ResolvedImportFact["confidence"] {
  if (target.status !== "resolved") {
    return "unresolved";
  }
  if (symbol?.metadata.scipSymbol) {
    return "high";
  }
  return symbol ? "medium" : "fallback";
}

function createPackageByFile(repo: DiscoveredRepo): Map<string, DiscoveredPackage> {
  const packages = [...repo.packages].sort((left, right) => right.path.length - left.path.length);
  const byFile = new Map<string, DiscoveredPackage>();
  for (const file of repo.files) {
    const pkg = packages.find((candidate) => file.absolutePath.startsWith(`${candidate.path}/`));
    if (pkg) {
      byFile.set(file.relativePath, pkg);
    }
  }
  return byFile;
}

function packageExportEntries(exportsValue: unknown): Array<{ exportName: string; targetPattern?: string }> {
  if (typeof exportsValue === "string") {
    return [{ exportName: ".", targetPattern: exportsValue }];
  }
  if (!exportsValue || typeof exportsValue !== "object" || Array.isArray(exportsValue)) {
    return [];
  }
  return Object.entries(exportsValue as Record<string, unknown>)
    .filter(([key]) => key.startsWith("."))
    .map(([exportName, value]) => ({
      exportName,
      targetPattern: conditionalExportTarget(value),
    }))
    .sort((left, right) => left.exportName.localeCompare(right.exportName));
}

function dependencyIsDeclared(
  context: ResolutionContext,
  importerFile: string,
  packageName: string | undefined,
): boolean {
  if (!packageName) {
    return false;
  }
  const pkg = context.packageByFile.get(importerFile);
  return Boolean(pkg?.dependencies[packageName] || context.packagesByName.has(packageName));
}

function resolutionSourceForTs(context: ResolutionContext, moduleSpecifier: string): string {
  if (moduleSpecifier.startsWith(".")) {
    return "typescript-relative";
  }
  return context.tsPaths.some((pattern) => pathPatternMatches(pattern, moduleSpecifier))
    ? "typescript-paths"
    : "typescript";
}

function pathPatternMatches(pattern: string, moduleSpecifier: string): boolean {
  const [prefix, suffix = ""] = pattern.split("*");
  return moduleSpecifier.startsWith(prefix) && moduleSpecifier.endsWith(suffix);
}

function matchPatternExport(pattern: string, exportName: string): string | undefined {
  const [prefix, suffix = ""] = pattern.split("*");
  if (exportName.startsWith(prefix) && exportName.endsWith(suffix)) {
    return exportName.slice(prefix.length, exportName.length - suffix.length);
  }
  return undefined;
}

function packageNameFromSpecifier(moduleSpecifier: string): string | undefined {
  const parts = moduleSpecifier.split("/");
  if (moduleSpecifier.startsWith("@")) {
    return parts.length >= 2 ? parts.slice(0, 2).join("/") : undefined;
  }
  return parts[0];
}

function packageSubpath(moduleSpecifier: string, packageName: string): string {
  const suffix = moduleSpecifier.slice(packageName.length).replace(/^\//, "");
  return suffix ? `./${suffix}` : ".";
}

function repoRelativePath(repo: DiscoveredRepo, path: string): string {
  const absolutePath = isAbsolute(path) ? path : resolve(repo.path, path);
  return normalizeRelativePath(relative(repo.path, absolutePath));
}

function findSymbolById(context: ResolutionContext, symbolId: string): CodeNode | undefined {
  for (const symbols of context.symbolsByFile.values()) {
    const symbol = symbols.find((candidate) => candidate.id === symbolId);
    if (symbol) {
      return symbol;
    }
  }
  return undefined;
}

function exportKey(file: string, exportedName: string | undefined): string {
  return `${file}\0${exportedName ?? ""}`;
}

function symbolResolutionRank(node: CodeNode): number {
  return node.metadata.scipSymbol ? 0 : 1;
}

function stripKnownExtension(path: string): string {
  return path.replace(/\.(d\.)?[cm]?[jt]sx?$/, "");
}

function normalizeAbsolutePath(path: string): string {
  return normalizeRelativePath(resolve(path));
}

function stringFromMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compareById(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}
