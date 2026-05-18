import { describe, expect, it } from "vitest";

import {
  createEmbeddingProvider,
  hashEmbeddingDimension,
  hashEmbeddingModel,
  jinaEmbeddingDimension,
  jinaEmbeddingModel,
} from "../../src/vectors/embedding.js";

describe("embedding provider selection", () => {
  it("uses Jina as the default semantic provider", async () => {
    const provider = await createEmbeddingProvider({ indexPath: "/tmp/code-intel-test-index" });

    expect(provider.provider).toBe("jina");
    expect(provider.model).toBe(jinaEmbeddingModel);
    expect(provider.dimension).toBe(jinaEmbeddingDimension);
  });

  it("keeps deterministic hash embeddings as an explicit fallback", async () => {
    const provider = await createEmbeddingProvider({
      provider: "hash",
      indexPath: "/tmp/code-intel-test-index",
    });

    expect(provider.provider).toBe("hash");
    expect(provider.model).toBe(hashEmbeddingModel);
    expect(provider.dimension).toBe(hashEmbeddingDimension);
  });
});
