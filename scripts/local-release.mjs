#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = new Set(process.argv.slice(2));
const skipTests = args.has("--skip-tests");
const packOnly = args.has("--pack-only");

if (args.has("--help") || args.has("-h")) {
  usage();
  process.exit(0);
}

for (const arg of args) {
  if (!["--skip-tests", "--pack-only"].includes(arg)) {
    usage();
    throw new Error(`Unknown option ${arg}.`);
  }
}

const packageJson = readPackageJson();
const name = requireString(packageJson.name, "package name");
const version = requireString(packageJson.version, "package version");
const releaseDir = join(root, ".local-releases", `v${version}`);
const tarball = join(releaseDir, packFileName(name, version));

mkdirSync(releaseDir, { recursive: true });
if (existsSync(tarball)) {
  rmSync(tarball);
}

if (skipTests) {
  run("npm", ["run", "build"]);
} else {
  run("npm", ["test"]);
}

run("npm", ["pack", "--pack-destination", releaseDir]);

if (!existsSync(tarball)) {
  throw new Error(`Expected npm pack to create ${tarball}.`);
}

if (!packOnly) {
  run("npm", ["install", "-g", tarball]);
  const installedVersion = verifyInstalledVersion();
  if (installedVersion !== version) {
    throw new Error(`Installed code-intel version mismatch: expected ${version}, received ${installedVersion}.`);
  }
}

writeManifest({
  name,
  version,
  tarball,
  installed: !packOnly,
  gitCommit: capture("git", ["rev-parse", "HEAD"]).trim(),
  createdAt: new Date().toISOString(),
});

console.log(`code-intel ${version} ${packOnly ? "packed" : "installed"} from ${tarball}`);

function usage() {
  console.error("Usage: npm run release:local -- [--skip-tests] [--pack-only]");
}

function readPackageJson() {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing ${label}.`);
  }
  return value;
}

function packFileName(name, version) {
  return `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
}

function writeManifest(manifest) {
  writeFileSync(join(releaseDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed with exit code ${result.status}.`);
  }
}

function capture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function verifyInstalledVersion() {
  const prefix = capture("npm", ["prefix", "-g"]).trim();
  const binary = process.platform === "win32" ? join(prefix, "code-intel.cmd") : join(prefix, "bin", "code-intel");
  if (existsSync(binary)) {
    return capture(binary, ["--version"]).trim();
  }
  return capture("code-intel", ["--version"]).trim();
}
