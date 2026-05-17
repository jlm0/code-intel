import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { chunkSourceFile } from "../../src/treesitter/chunker.js";

const fixturePath = new URL("../fixtures/js-ts-workspace", import.meta.url).pathname;

describe("Tree-sitter chunking", () => {
  it("extracts TypeScript functions and classes", async () => {
    const filePath = join(fixturePath, "packages/core/src/tithe.ts");
    const chunks = chunkSourceFile({
      relativePath: "packages/core/src/tithe.ts",
      content: await readFile(filePath, "utf8"),
    });

    expect(chunks.map((chunk) => chunk.name)).toContain("calculateGivingTotal");
    expect(chunks.find((chunk) => chunk.name === "calculateGivingTotal")?.calls).toContain(
      "reduce",
    );
  });

  it("extracts TSX hook chunks", async () => {
    const filePath = join(fixturePath, "packages/ui/src/useGivingSummary.tsx");
    const chunks = chunkSourceFile({
      relativePath: "packages/ui/src/useGivingSummary.tsx",
      content: await readFile(filePath, "utf8"),
    });

    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "useGivingSummary", kind: "Function" }),
      ]),
    );
  });

  it("returns partial chunks for syntax-error files", async () => {
    const filePath = join(fixturePath, "packages/core/src/broken.ts");
    const chunks = chunkSourceFile({
      relativePath: "packages/core/src/broken.ts",
      content: await readFile(filePath, "utf8"),
    });

    expect(chunks.map((chunk) => chunk.name)).toContain("partiallyWritten");
  });
});
