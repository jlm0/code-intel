export type IndexProfile = "lean" | "balanced" | "monorepo" | "quality";

export type GeneratedSourceMode = "exclude" | "types-only" | "include";
export type EmbeddingInputMode = "minimal" | "semantic-header";
export type SemanticChunkMode = "minimal" | "bounded" | "expanded";
export type GraphRelationMode = "typed-and-relates";

export interface IndexPolicy {
  profile: IndexProfile;
  discovery: DiscoveryPolicy;
  chunks: ChunkPolicy;
  scip: ScipPolicy;
  embedding: EmbeddingPolicy;
  graph: GraphPolicy;
}

export interface DiscoveryPolicy {
  generatedSourceMode: GeneratedSourceMode;
  includeBuildArtifacts: boolean;
  allowedHiddenDirectories: string[];
  splitOutsidePackages: boolean;
}

export interface ChunkPolicy {
  semanticChunkMode: SemanticChunkMode;
  maxSmallObjectProperties: number;
}

export interface ScipPolicy {
  targetShardCost: number;
  legacyMaxFiles: number;
  splitRepoRoot: boolean;
  historyPenalty: number;
  maxRetrySplits: number;
  defaultHeapMb: number;
  tinyShardHeapEscalationMb: number;
  tinyShardMaxFiles: number;
  timeoutMs: number;
  projectReferencesEnabled: boolean;
}

export interface EmbeddingPolicy {
  inputMode: EmbeddingInputMode;
  tokenBudget: number;
  maxBatchSize: number;
  maxBatchPaddedTokens: number;
  maxBatchTotalTokens: number;
  durableCache: boolean;
}

export interface GraphPolicy {
  transitiveCallLimit: number;
  evidenceCallMode: "merge" | "per-evidence";
  heuristicEdgeLimit: number;
  relationMode: GraphRelationMode;
  nodeBatchSize: number;
  edgeBatchSize: number;
}

export type IndexPolicyOverrides = {
  discovery?: Partial<DiscoveryPolicy>;
  chunks?: Partial<ChunkPolicy>;
  scip?: Partial<ScipPolicy>;
  embedding?: Partial<EmbeddingPolicy>;
  graph?: Partial<GraphPolicy>;
};

export interface ResolveIndexPolicyInput {
  profile?: IndexProfile | string;
  overrides?: IndexPolicyOverrides;
}

export function resolveIndexPolicy(input: ResolveIndexPolicyInput = {}): IndexPolicy {
  const profile = normalizeProfile(input.profile);
  const baseline = profileDefaults[profile];
  return {
    profile,
    discovery: {
      ...baseline.discovery,
      ...input.overrides?.discovery,
      allowedHiddenDirectories: [
        ...new Set([
          ...baseline.discovery.allowedHiddenDirectories,
          ...(input.overrides?.discovery?.allowedHiddenDirectories ?? []),
        ]),
      ].sort(),
    },
    chunks: {
      ...baseline.chunks,
      ...input.overrides?.chunks,
    },
    scip: {
      ...baseline.scip,
      ...input.overrides?.scip,
    },
    embedding: {
      ...baseline.embedding,
      ...input.overrides?.embedding,
    },
    graph: {
      ...baseline.graph,
      ...input.overrides?.graph,
    },
  };
}

export function normalizeProfile(value: IndexProfile | string | undefined): IndexProfile {
  if (value === "lean" || value === "balanced" || value === "monorepo" || value === "quality") {
    return value;
  }
  return "balanced";
}

const commonGraph: GraphPolicy = {
  transitiveCallLimit: 2_000,
  evidenceCallMode: "merge",
  heuristicEdgeLimit: 5_000,
  relationMode: "typed-and-relates",
  nodeBatchSize: 200,
  edgeBatchSize: 100,
};

const profileDefaults: Record<IndexProfile, IndexPolicy> = {
  lean: {
    profile: "lean",
    discovery: {
      generatedSourceMode: "exclude",
      includeBuildArtifacts: false,
      allowedHiddenDirectories: [],
      splitOutsidePackages: true,
    },
    chunks: {
      semanticChunkMode: "minimal",
      maxSmallObjectProperties: 4,
    },
    scip: {
      targetShardCost: 160,
      legacyMaxFiles: 250,
      splitRepoRoot: true,
      historyPenalty: 2,
      maxRetrySplits: 3,
      defaultHeapMb: 768,
      tinyShardHeapEscalationMb: 1280,
      tinyShardMaxFiles: 2,
      timeoutMs: 90_000,
      projectReferencesEnabled: false,
    },
    embedding: {
      inputMode: "minimal",
      tokenBudget: 384,
      maxBatchSize: 8,
      maxBatchPaddedTokens: 2_048,
      maxBatchTotalTokens: 2_048,
      durableCache: true,
    },
    graph: {
      ...commonGraph,
      transitiveCallLimit: 0,
      heuristicEdgeLimit: 1_000,
    },
  },
  balanced: {
    profile: "balanced",
    discovery: {
      generatedSourceMode: "exclude",
      includeBuildArtifacts: false,
      allowedHiddenDirectories: [],
      splitOutsidePackages: true,
    },
    chunks: {
      semanticChunkMode: "minimal",
      maxSmallObjectProperties: 6,
    },
    scip: {
      targetShardCost: 220,
      legacyMaxFiles: 350,
      splitRepoRoot: true,
      historyPenalty: 2,
      maxRetrySplits: 4,
      defaultHeapMb: 1024,
      tinyShardHeapEscalationMb: 1536,
      tinyShardMaxFiles: 2,
      timeoutMs: 120_000,
      projectReferencesEnabled: false,
    },
    embedding: {
      inputMode: "minimal",
      tokenBudget: 512,
      maxBatchSize: 16,
      maxBatchPaddedTokens: 4_096,
      maxBatchTotalTokens: 4_096,
      durableCache: true,
    },
    graph: commonGraph,
  },
  monorepo: {
    profile: "monorepo",
    discovery: {
      generatedSourceMode: "types-only",
      includeBuildArtifacts: false,
      allowedHiddenDirectories: [],
      splitOutsidePackages: true,
    },
    chunks: {
      semanticChunkMode: "bounded",
      maxSmallObjectProperties: 6,
    },
    scip: {
      targetShardCost: 140,
      legacyMaxFiles: 250,
      splitRepoRoot: true,
      historyPenalty: 3,
      maxRetrySplits: 5,
      defaultHeapMb: 1024,
      tinyShardHeapEscalationMb: 1792,
      tinyShardMaxFiles: 2,
      timeoutMs: 150_000,
      projectReferencesEnabled: false,
    },
    embedding: {
      inputMode: "semantic-header",
      tokenBudget: 512,
      maxBatchSize: 12,
      maxBatchPaddedTokens: 3_072,
      maxBatchTotalTokens: 4_096,
      durableCache: true,
    },
    graph: {
      ...commonGraph,
      transitiveCallLimit: 1_000,
      heuristicEdgeLimit: 2_000,
      edgeBatchSize: 150,
    },
  },
  quality: {
    profile: "quality",
    discovery: {
      generatedSourceMode: "include",
      includeBuildArtifacts: false,
      allowedHiddenDirectories: [],
      splitOutsidePackages: true,
    },
    chunks: {
      semanticChunkMode: "expanded",
      maxSmallObjectProperties: 12,
    },
    scip: {
      targetShardCost: 320,
      legacyMaxFiles: 450,
      splitRepoRoot: true,
      historyPenalty: 2,
      maxRetrySplits: 4,
      defaultHeapMb: 1536,
      tinyShardHeapEscalationMb: 2048,
      tinyShardMaxFiles: 3,
      timeoutMs: 180_000,
      projectReferencesEnabled: true,
    },
    embedding: {
      inputMode: "semantic-header",
      tokenBudget: 768,
      maxBatchSize: 16,
      maxBatchPaddedTokens: 6_144,
      maxBatchTotalTokens: 6_144,
      durableCache: true,
    },
    graph: {
      ...commonGraph,
      transitiveCallLimit: 8_000,
      heuristicEdgeLimit: 10_000,
    },
  },
};
