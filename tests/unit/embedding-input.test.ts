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
});
