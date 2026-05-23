import { describe, expect, it } from "vitest";

import { chunkEmbeddingInput } from "../../src/indexer/embedding-input.js";

describe("embedding input preparation", () => {
  it("does not silently character-truncate real source chunk input", () => {
    const tailSignal = "rare_after_cutoff_semantic_marker";
    const input = chunkEmbeddingInput({
      name: "oversizedSource",
      content: `${"const filler = 1;\n".repeat(500)}\nexport const finalSignal = "${tailSignal}";\n`,
    });

    expect(input).toContain(tailSignal);
    expect(input).not.toContain("[truncated");
  });

  it("can include compact semantic headers for disambiguating monorepo chunks", () => {
    const input = chunkEmbeddingInput({
      name: "createClient",
      content: "export const createClient = () => null;",
      fact: {
        embeddingInputMode: "semantic-header",
        embeddingInputHeader: {
          repo: "workspace",
          packageName: "@fixture/sdk",
          path: "packages/sdk/src/client.ts",
          qualifiedName: "createClient",
          kind: "Variable",
          exported: true,
          test: false,
          sourceRoot: "packages/sdk/src",
        },
      },
    });

    expect(input.split("\n").slice(0, 2)).toEqual([
      "repo=workspace package=@fixture/sdk path=packages/sdk/src/client.ts",
      "qualifiedName=createClient kind=Variable exported=true test=false sourceRoot=packages/sdk/src",
    ]);
    expect(input).toContain("export const createClient");
  });

  it("preserves minimal input mode for lean profile behavior", () => {
    const input = chunkEmbeddingInput({
      name: "leanChunk",
      content: "export const value = 1;",
      fact: {
        embeddingInputMode: "minimal",
        embeddingInputHeader: {
          repo: "workspace",
          path: "packages/sdk/src/client.ts",
        },
      },
    });

    expect(input).toBe("leanChunk\nexport const value = 1;");
  });
});
