/**
 * @flowscout/application — semantic sameness subtree barrel (E3.5 / #58).
 *
 * The post-hoc embedding-pass orchestrator + the semantic duplicate / hidden-path detector, plus
 * their budget guard, cache impl, and configs. Re-exported from the application root barrel.
 */
export { RefineIdentities } from "./RefineIdentities.js";
export type { RefineIdentitiesResult, SkeletonProjector } from "./RefineIdentities.js";
export { defaultRefineIdentitiesConfig } from "./RefineIdentitiesConfig.js";
export type { RefineIdentitiesConfig } from "./RefineIdentitiesConfig.js";

export { SemanticDuplicateDetector } from "./SemanticDuplicateDetector.js";
export type { DuplicateDetectionResult } from "./SemanticDuplicateDetector.js";
export { defaultDuplicateDetectorConfig } from "./DuplicateDetectorConfig.js";
export type { DuplicateDetectorConfig } from "./DuplicateDetectorConfig.js";

export { EmbeddingBudgetGuard } from "./EmbeddingBudgetGuard.js";
export { InMemoryEmbeddingCache } from "./InMemoryEmbeddingCache.js";
