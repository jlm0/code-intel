export const defaultIgnoredDirectories = new Set([
  ".cache",
  ".code-intel",
  ".git",
  ".next",
  ".nyc_output",
  ".turbo",
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

export function directoryIsIgnored(name: string): boolean {
  return defaultIgnoredDirectories.has(name);
}

export function defaultRipgrepIgnoreGlobs(): string[] {
  return [...defaultIgnoredDirectories].flatMap((directory) => [
    `!${directory}`,
    `!${directory}/**`,
    `!**/${directory}/**`,
  ]);
}
