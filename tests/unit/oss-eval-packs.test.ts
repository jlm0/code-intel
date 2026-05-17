import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  loadEvalPack,
  prepareEvalCorpus,
  type EvalGateMetadata,
  type LoadedEvalPack,
} from "../../src/eval/eval-pack.js";

const execFileAsync = promisify(execFile);

const ossSuiteIds = [
  "oss-ghostfolio-app-flow",
  "oss-openstatus-app-flow",
  "oss-hermes-agent-ui",
];

describe("OSS eval packs", () => {
  it("loads Ghostfolio, OpenStatus, and Hermes packs as pinned external-git target suites", async () => {
    const packs = await Promise.all(
      ossSuiteIds.map((suite) =>
        loadEvalPack({
          suite,
          workspaceRoot: process.cwd(),
        }),
      ),
    );

    expect(packs.map(({ pack }) => pack.id)).toEqual(ossSuiteIds);

    for (const loadedPack of packs) {
      expect(loadedPack.pack.kind).toBe("external-git");
      expect(loadedPack.pack.corpus.type).toBe("git");
      expect(loadedPack.pack.corpus.ref).toMatch(/^[0-9a-f]{40}$/);
      expect(loadedPack.pack.corpus.sparsePaths.length).toBeGreaterThan(5);
      expect(loadedPack.cases.length).toBeGreaterThan(0);
      expect(loadedPack.astCases.length).toBeGreaterThan(0);
      expect(loadedPack.graphCases.length).toBeGreaterThan(0);
      expect(collectGates(loadedPack).every((gate) => gate.status !== "required")).toBe(true);
      expect(collectGates(loadedPack).map((gate) => gate.layer)).toEqual(
        expect.arrayContaining(["AST", "SCIP", "fusion", "graph", "ranking"]),
      );
    }
  });

  it("keeps each new OSS pack focused on a distinct general JS/TS capability shape", async () => {
    const ghostfolio = await loadEvalPack({ suite: "oss-ghostfolio-app-flow", workspaceRoot: process.cwd() });
    const openstatus = await loadEvalPack({ suite: "oss-openstatus-app-flow", workspaceRoot: process.cwd() });
    const hermes = await loadEvalPack({ suite: "oss-hermes-agent-ui", workspaceRoot: process.cwd() });

    expect(collectCapabilities(ghostfolio)).toEqual(
      expect.arrayContaining([
        "angular-to-nest-controller",
        "service-to-database",
        "test-to-implementation",
      ]),
    );
    expect(collectCapabilities(openstatus)).toEqual(
      expect.arrayContaining([
        "monitoring-route-to-database",
        "UI-to-data/API",
        "route-to-database",
      ]),
    );
    expect(collectCapabilities(hermes)).toEqual(
      expect.arrayContaining([
        "gateway-client-protocol",
        "React/Ink UI-to-hook",
        "hook-to-gateway-client",
      ]),
    );
  });

  it("caches external git corpora by pack id and pinned ref with sparse checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-intel-oss-eval-cache-test-"));
    const origin = join(root, "origin");
    const packRoot = join(root, "pack");
    const evalCachePath = join(root, "cache");

    try {
      await mkdir(join(origin, "src"), { recursive: true });
      await mkdir(join(packRoot, "cases"), { recursive: true });
      await writeFile(join(origin, "package.json"), JSON.stringify({ name: "cache-test" }, null, 2));
      await writeFile(join(origin, "README.md"), "not part of sparse checkout\n");
      await writeFile(join(origin, "src", "index.ts"), "export const cached = true;\n");
      await git(["init"], origin);
      await git(["config", "user.email", "code-intel@example.com"], origin);
      await git(["config", "user.name", "Code Intel"], origin);
      await git(["add", "."], origin);
      await git(["commit", "-m", "test: seed corpus"], origin);
      const ref = (await git(["rev-parse", "HEAD"], origin)).stdout.trim();

      await writeFile(join(packRoot, "pack.json"), JSON.stringify(createGitPack(origin, ref), null, 2));
      await writeFile(join(packRoot, "cases", "app-flow.json"), JSON.stringify(createNoopCases(), null, 2));
      const loadedPack = await loadEvalPack({
        evalPackPath: join(packRoot, "pack.json"),
        workspaceRoot: root,
      });

      const fetched = await prepareEvalCorpus({
        loadedPack,
        workspaceRoot: root,
        evalCachePath,
        fetch: true,
      });
      expect(fetched.source).toMatchObject({
        ref,
        resolvedRef: ref,
        sparsePaths: ["package.json", "src/**"],
      });
      await expect(stat(join(fetched.path, "package.json"))).resolves.toBeTruthy();
      await expect(stat(join(fetched.path, "src", "index.ts"))).resolves.toBeTruthy();
      await expect(stat(join(fetched.path, "README.md"))).rejects.toMatchObject({ code: "ENOENT" });

      await rm(origin, { recursive: true, force: true });
      const cached = await prepareEvalCorpus({
        loadedPack,
        workspaceRoot: root,
        evalCachePath,
        fetch: false,
      });
      expect(cached.path).toBe(fetched.path);
      await expect(readFile(join(cached.path, "src", "index.ts"), "utf8")).resolves.toContain("cached");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function collectGates(loadedPack: LoadedEvalPack): EvalGateMetadata[] {
  return [
    ...loadedPack.cases.map((testCase) => testCase.gate),
    ...loadedPack.astCases.map((testCase) => testCase.gate),
    ...loadedPack.graphCases.map((testCase) => testCase.gate),
  ];
}

function collectCapabilities(loadedPack: LoadedEvalPack): string[] {
  return collectGates(loadedPack).map((gate) => gate.capability);
}

function createGitPack(origin: string, ref: string): Record<string, unknown> {
  return {
    schemaVersion: "code-intel.eval-pack.v1",
    id: "cache-test-pack",
    name: "Cache Test Pack",
    version: "1.0.0",
    kind: "external-git",
    description: "Fixture pack for external git cache behavior.",
    corpus: {
      type: "git",
      url: pathToFileURL(origin).href,
      ref,
      repoPaths: ["."],
      sparsePaths: ["package.json", "src/**"],
    },
    caseFiles: ["cases/app-flow.json"],
  };
}

function createNoopCases(): Array<Record<string, unknown>> {
  return [
    {
      id: "cache-test.noop",
      name: "Noop parser case",
      mode: "find-symbol",
      query: "cached",
      gate: {
        id: "cache-test.scoreboard",
        status: "scoreboard",
        capability: "external-git-cache",
        layer: "eval",
      },
      expected: [
        {
          file: "src/index.ts",
        },
      ],
    },
  ];
}

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
  });
}
