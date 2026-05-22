import { join, resolve } from "node:path";

export const hashEmbeddingDimension = 64;
export const hashEmbeddingModel = "local-hash-v1";
export const jinaEmbeddingModel = "jinaai/jina-embeddings-v2-base-code";
export const jinaEmbeddingDimension = 768;
export const defaultEmbeddingProvider = "jina";

export interface EmbeddingProvider {
  provider: "hash" | "jina";
  model: string;
  dimension: number;
  maxInputTokens: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  countTokens(texts: string[]): Promise<number[]>;
}

export interface EmbeddingProviderOptions {
  provider?: string;
  model?: string;
  indexPath?: string;
}

export async function createEmbeddingProvider(options: EmbeddingProviderOptions = {}): Promise<EmbeddingProvider> {
  const providerName = normalizeProviderName(options.provider ?? process.env.CODE_INTEL_EMBEDDING_PROVIDER);
  if (providerName === "jina") {
    return new JinaEmbeddingProvider({
      model: options.model ?? process.env.CODE_INTEL_EMBEDDING_MODEL ?? jinaEmbeddingModel,
      cachePath: resolve(options.indexPath ?? ".code-intel", "models"),
    });
  }

  return createHashEmbeddingProvider();
}

export function createHashEmbeddingProvider(): EmbeddingProvider {
  return {
    provider: "hash",
    model: hashEmbeddingModel,
    dimension: hashEmbeddingDimension,
    maxInputTokens: 8_192,
    async embed(text: string) {
      return embedText(text);
    },
    async embedBatch(texts: string[]) {
      return texts.map(embedText);
    },
    async countTokens(texts: string[]) {
      return texts.map((text) => tokenize(text).length);
    },
  };
}

export function embedText(text: string): number[] {
  const vector = Array.from({ length: hashEmbeddingDimension }, () => 0);
  for (const token of tokenize(text)) {
    const index = hashToken(token) % hashEmbeddingDimension;
    vector[index] += 1;
  }

  return normalizeVector(vector);
}

class JinaEmbeddingProvider implements EmbeddingProvider {
  readonly provider = "jina" as const;
  readonly dimension = jinaEmbeddingDimension;
  readonly maxInputTokens = 8_192;
  private extractor?: FeatureExtractionPipeline;
  private tokenizer?: TokenizerLike;

  constructor(
    private readonly options: {
      model: string;
      cachePath: string;
    },
  ) {}

  get model(): string {
    return this.options.model;
  }

  async embed(text: string): Promise<number[]> {
    const [embedding] = await this.embedBatch([text]);
    return embedding ?? [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const extractor = await this.getExtractor();
    const tensor = await extractor(texts, { pooling: "mean", normalize: true });
    const values = tensor.tolist() as number[] | number[][];
    if (Array.isArray(values[0])) {
      return (values as number[][]).map((vector) => normalizeVector(vector));
    }
    return [normalizeVector(values as number[])];
  }

  async countTokens(texts: string[]): Promise<number[]> {
    if (texts.length === 0) {
      return [];
    }
    const tokenizer = await this.getTokenizer();
    return texts.map((text) =>
      tokenizer.encode(text, {
        add_special_tokens: true,
      }).length
    );
  }

  private async getExtractor(): Promise<FeatureExtractionPipeline> {
    if (!this.extractor) {
      const transformers = await import("@huggingface/transformers");
      this.extractor = await transformers.pipeline("feature-extraction", this.options.model, {
        cache_dir: join(this.options.cachePath),
      });
    }
    return this.extractor;
  }

  private async getTokenizer(): Promise<TokenizerLike> {
    if (!this.tokenizer) {
      const transformers = await import("@huggingface/transformers");
      this.tokenizer = await transformers.AutoTokenizer.from_pretrained(this.options.model, {
        cache_dir: join(this.options.cachePath),
      }) as TokenizerLike;
    }
    return this.tokenizer;
  }
}

function normalizeProviderName(value: string | undefined): "hash" | "jina" {
  if (!value) {
    return defaultEmbeddingProvider;
  }
  if (value === "hash" || value === "local-hash-v1") {
    return "hash";
  }
  if (value === "jina" || value === jinaEmbeddingModel) {
    return "jina";
  }
  throw new Error(`Unsupported embedding provider: ${value}`);
}

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeVector(vector: number[]): number[] {
  const length = Math.hypot(...vector);
  return length === 0 ? vector : vector.map((value) => value / length);
}

type FeatureExtractionPipeline = {
  (texts: string | string[], options?: { pooling?: "mean"; normalize?: boolean }): Promise<{ tolist(): unknown }>;
};

type TokenizerLike = {
  encode(text: string, options?: { add_special_tokens?: boolean }): number[];
};
