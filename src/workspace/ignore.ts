export const defaultIgnoredDirectories = new Set([
  ".cache",
  ".code-intel",
  ".expo",
  ".git",
  ".next",
  ".nx",
  ".nyc_output",
  ".turbo",
  ".vercel",
  ".yarn",
  "__generated__",
  "build",
  "coverage",
  "dist",
  "generated",
  "local-dev-multistack",
  "logs",
  "node_modules",
  "out",
  "playwright-report",
  "test-results",
  "tmp",
]);

export interface IgnorePolicyOptions {
  includeIgnored?: boolean;
  allowedHiddenDirectories?: string[];
  generatedSourceMode?: "exclude" | "types-only" | "include";
  includeBuildArtifacts?: boolean;
}

export function directoryIsIgnored(
  name: string,
  options: IgnorePolicyOptions & { relativePath?: string } = {},
): boolean {
  if (options.includeIgnored) {
    return false;
  }
  if (generatedDirectories.has(name) && options.generatedSourceMode !== undefined && options.generatedSourceMode !== "exclude") {
    return false;
  }
  if (buildArtifactDirectories.has(name) && options.includeBuildArtifacts === true) {
    return false;
  }
  if (hiddenDirectoryIsAllowed(name, options.relativePath, options.allowedHiddenDirectories)) {
    return false;
  }
  return defaultIgnoredDirectories.has(name) || hiddenDirectoryIsArtifact(name);
}

export const generatedDirectories = new Set(["__generated__", "generated"]);
export const buildArtifactDirectories = new Set([
  ".next",
  ".nx",
  ".turbo",
  ".vercel",
  "build",
  "coverage",
  "dist",
  "out",
]);

export function defaultRipgrepIgnoreGlobs(options: IgnorePolicyOptions = {}): string[] {
  if (options.includeIgnored) {
    return [];
  }
  const hiddenAllowlist = normalizeAllowedHiddenDirectories(options.allowedHiddenDirectories);
  const ignoredDirectories = [...defaultIgnoredDirectories].filter((directory) => !hiddenAllowlist.has(directory));
  return [
    ...ignoredDirectories.flatMap((directory) => [
      `!${directory}`,
      `!${directory}/**`,
      `!**/${directory}/**`,
    ]),
    "!.*",
    "!.*/*",
    "!**/.*/**",
    ...[...hiddenAllowlist].flatMap((directory) => [
      directory,
      `${directory}/**`,
      `**/${directory}/**`,
    ]),
  ];
}

export function normalizeAllowedHiddenDirectories(values: string[] | undefined): Set<string> {
  return new Set(
    (values ?? [])
      .map((value) => value.trim().replace(/\/+$/, ""))
      .filter((value) => value.startsWith(".") && value !== "." && value !== ".."),
  );
}

function hiddenDirectoryIsArtifact(
  name: string,
): boolean {
  return name.startsWith(".") && name !== "." && name !== "..";
}

function hiddenDirectoryIsAllowed(
  name: string,
  relativePath: string | undefined,
  allowedHiddenDirectories: string[] | undefined,
): boolean {
  const allowed = normalizeAllowedHiddenDirectories(allowedHiddenDirectories);
  if (allowed.size === 0) {
    return false;
  }
  return allowed.has(name) || (relativePath ? allowed.has(relativePath) : false);
}
