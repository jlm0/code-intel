import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { normalizeRelativePath } from "../core/ids.js";
import { schemaVersion, type FileFingerprint } from "../schema/schemas.js";
import type { EmbeddingProvider } from "../vectors/embedding.js";
import type { DiscoveredFile, DiscoveredRepo, DiscoveredWorkspace } from "../workspace/discovery.js";
import type { IndexPolicy } from "../core/index-policy.js";

export interface FingerprintedFile {
  discoveredFile: DiscoveredFile;
  fingerprint: FileFingerprint;
  content: string;
}

export async function fingerprintDiscoveredFile(
  repo: Pick<DiscoveredRepo, "name">,
  file: DiscoveredFile,
): Promise<FingerprintedFile> {
  const [stats, bytes] = await Promise.all([stat(file.absolutePath), readFile(file.absolutePath)]);
  return {
    discoveredFile: file,
    fingerprint: {
      repo: repo.name,
      relativePath: file.relativePath,
      packageName: file.packageName,
      language: file.language,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      contentHash: sha256(bytes),
    },
    content: bytes.toString("utf8"),
  };
}

export async function calculateConfigHash(input: {
  workspace: DiscoveredWorkspace;
  includeIgnored?: boolean;
  allowedHiddenDirectories?: string[];
  workspaceManifestPath?: string;
  embeddingProvider: EmbeddingProvider;
  policy?: IndexPolicy;
}): Promise<string> {
  const hash = createHash("sha256");
  hash.update(schemaVersion);
  hash.update(JSON.stringify({
    includeIgnored: input.includeIgnored === true,
    allowedHiddenDirectories: input.allowedHiddenDirectories ?? [],
    workspaceManifestPath: input.workspaceManifestPath ?? null,
    embedding: {
      provider: input.embeddingProvider.provider,
      model: input.embeddingProvider.model,
      dimension: input.embeddingProvider.dimension,
    },
    policy: input.policy ?? null,
  }));

  const configPaths = new Set<string>();
  if (input.workspaceManifestPath) {
    configPaths.add(join(input.workspace.workspaceRoot, input.workspaceManifestPath));
  }
  for (const repo of input.workspace.repos) {
    for (const filename of configFilenames) {
      configPaths.add(join(repo.path, filename));
    }
    for (const pkg of repo.packages) {
      for (const filename of configFilenames) {
        configPaths.add(join(pkg.path, filename));
      }
    }
    hash.update(JSON.stringify({
      repo: repo.name,
      path: normalizeRelativePath(relative(input.workspace.workspaceRoot, repo.path) || "."),
      packageManager: repo.packageManager,
      packages: repo.packages.map((pkg) => ({
        name: pkg.name,
        path: normalizeRelativePath(relative(input.workspace.workspaceRoot, pkg.path) || "."),
        sourceRoots: pkg.sourceRoots.map((root) =>
          normalizeRelativePath(relative(input.workspace.workspaceRoot, root) || "."),
        ),
        includePatterns: pkg.includePatterns ?? [],
        excludePatterns: pkg.excludePatterns,
      })),
    }));
  }

  for (const configPath of [...configPaths].sort()) {
    try {
      hash.update(normalizeRelativePath(relative(input.workspace.workspaceRoot, configPath) || "."));
      hash.update(await readFile(configPath));
    } catch {
      hash.update(`${normalizeRelativePath(relative(input.workspace.workspaceRoot, configPath) || ".")}:missing`);
    }
  }

  return hash.digest("hex");
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

const configFilenames = ["package.json", "tsconfig.json", "tsconfig.base.json", "jsconfig.json"];
