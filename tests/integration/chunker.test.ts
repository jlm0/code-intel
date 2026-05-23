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

  it("adds profile-aware high-value declaration chunks without unbounded default growth", () => {
    const content = `
export const apiConfig = {
  endpoint: "/api",
  timeoutMs: 1000,
};

export enum PaymentState {
  Pending = "pending",
  Paid = "paid",
}

export namespace ApiContracts {
  export interface Payment {
    id: string;
  }
}

declare module "virtual:contracts" {
  export interface RuntimeContract {
    id: string;
  }
}
`;

    const balanced = chunkSourceFile({
      relativePath: "packages/api/generated/contracts.d.ts",
      content,
      policy: {
        semanticChunkMode: "bounded",
      },
    });
    const quality = chunkSourceFile({
      relativePath: "packages/api/generated/contracts.d.ts",
      content,
      policy: {
        semanticChunkMode: "expanded",
      },
    });

    expect(balanced.map((chunk) => chunk.name)).toEqual(
      expect.arrayContaining(["apiConfig", "PaymentState", "ApiContracts", "virtual:contracts"]),
    );
    expect(quality.length).toBeGreaterThanOrEqual(balanced.length);
    expect(balanced.length).toBeLessThanOrEqual(6);
  });
});
