#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packagePath = resolve(root, "package.json");
const lockPath = resolve(root, "package-lock.json");
const requested = process.argv[2];

if (!requested || requested === "--help" || requested === "-h") {
  usage();
  process.exit(requested ? 0 : 1);
}

const packageJson = readJson(packagePath);
const currentVersion = requireString(packageJson.version, "package.json version");
const nextVersion = resolveNextVersion(currentVersion, requested);

packageJson.version = nextVersion;
writeJson(packagePath, packageJson);

const lockJson = readJson(lockPath);
lockJson.version = nextVersion;
if (lockJson.packages?.[""]) {
  lockJson.packages[""].version = nextVersion;
}
writeJson(lockPath, lockJson);

console.log(`code-intel version bumped: ${currentVersion} -> ${nextVersion}`);
console.log("Next: npm run release:local");

function usage() {
  console.error("Usage: npm run version:bump -- <patch|minor|major|x.y.z>");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing ${label}.`);
  }
  return value;
}

function resolveNextVersion(currentVersion, requestedVersion) {
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requestedVersion)) {
    return requestedVersion;
  }

  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(currentVersion);
  if (!match) {
    throw new Error(`Cannot bump non-standard version ${currentVersion}. Pass an explicit x.y.z version.`);
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  if (requestedVersion === "patch") {
    return `${major}.${minor}.${patch + 1}`;
  }
  if (requestedVersion === "minor") {
    return `${major}.${minor + 1}.0`;
  }
  if (requestedVersion === "major") {
    return `${major + 1}.0.0`;
  }

  throw new Error(`Unknown version bump ${requestedVersion}. Use patch, minor, major, or x.y.z.`);
}
