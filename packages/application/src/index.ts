/**
 * @flowscout/application — public API barrel.
 * Use-cases and composition-root types. Depends only on @flowscout/domain ports.
 */

export type { UseCase } from "./use-cases/UseCasePort.js";
export type { AppPorts } from "./composition-root/AppContext.js";
export { AppContext } from "./composition-root/AppContext.js";

// E2.1 — Walking-skeleton crawl loop
export { StartCrawlRun } from "./crawl/StartCrawlRun.js";
export type { StartCrawlRunInput } from "./crawl/StartCrawlRun.js";
export { defaultCollaborators } from "./crawl/collaborators.js";
export type {
  CrawlCollaborators,
  CollaboratorOptions,
  StateIdentityFn,
} from "./crawl/collaborators.js";
export { InMemoryStateGraphRepository } from "./crawl/persistence/InMemoryStateGraphRepository.js";

// E2.6 — Decision cache (in-memory implementation) + cached-knowledge policy (chain link)
export { InMemoryDecisionCache } from "./crawl/policy/InMemoryDecisionCache.js";
export { CachedKnowledgePolicy } from "./crawl/policy/CachedKnowledgePolicy.js";
export type { DecisionContextWithCandidates } from "./crawl/policy/CachedKnowledgePolicy.js";

// E2.7 — Capstone: redaction / 2FA boundary / duplicate-path / usage-reporter / safety
export { CredentialRedactor, REDACTED_MARKER } from "./crawl/redaction/CredentialRedactor.js";
export { CredentialBoundaryDetector } from "./crawl/twofa/CredentialBoundaryDetector.js";
export type {
  DetectionResult,
  CredentialPromptType,
} from "./crawl/twofa/CredentialBoundaryDetector.js";
export { DuplicatePathDetector } from "./crawl/duplicate/DuplicatePathDetector.js";
export { defaultEnumerateBaseCandidates } from "./crawl/BaseCandidateEnumerator.js";
export type { BaseCandidateEnumeratorFn } from "./crawl/BaseCandidateEnumerator.js";
export type { UsageReporter, LlmCallUsage } from "./crawl/UsageReporter.js";
export { NoOpUsageReporter } from "./crawl/UsageReporter.js";
export type { CrawlRunSafety } from "./crawl/CrawlRunSafety.js";

// E3.1 — Rule-based workflow extraction from the finalized state graph (#54)
export {
  WorkflowExtractor,
  defaultWorkflowExtractor,
  workflowId,
  ruleBasedEntryPolicy,
  launchNodeId,
  ruleBasedOutcomePolicy,
  defaultExtractionConfig,
  GraphAdjacency,
  buildSteps,
} from "./semantic/extraction/index.js";
export type {
  ExtractionResult,
  EntryPolicy,
  OutcomePolicy,
  ExtractionConfig,
} from "./semantic/extraction/index.js";

// E3.2 — Per-screen & per-control intent inference (a11y-first, budgeted LLM) (#55)
export { InferIntent, defaultInferIntentConfig } from "./semantic/intent/InferIntent.js";
export type { InferIntentConfig } from "./semantic/intent/InferIntent.js";
export { A11yIntentDeriver } from "./semantic/intent/A11yIntentDeriver.js";
export { LlmIntentRefiner } from "./semantic/intent/LlmIntentRefiner.js";
export { IntentBudgetGuard } from "./semantic/intent/IntentBudgetGuard.js";
export { InMemoryIntentCache } from "./semantic/intent/InMemoryIntentCache.js";
export { intentCacheKey, INTENT_KEY_PREFIX } from "./semantic/intent/IntentCacheKey.js";

// E3.3 — App-purpose + workflow naming & feature grouping (rule-first, budgeted LLM) (#56)
export {
  NameAndGroupWorkflows,
  RuleNameStrategy,
  LlmNamingRefiner,
  AppPurposeInferer,
  InMemoryGroupingCache,
  groupingCacheKey,
  purposeCacheKey,
  GROUPING_KEY_PREFIX,
  PURPOSE_KEY_PREFIX,
  FEATURE_GROUP_RULES,
  MAX_NAME_CHARS,
  MAX_DESCRIPTION_CHARS,
  defaultGroupingConfig,
  UNGROUPED,
  UNKNOWN_PURPOSE,
} from "./semantic/grouping/index.js";
export type {
  NameAndGroupResult,
  RedactedScreenSignal,
  RuleLabelingResult,
  AppPurposeResult,
  GroupingConfig,
} from "./semantic/grouping/index.js";

// E3.5 — Semantic duplicate / hidden-path detection: embedding-pass orchestrator + detector (#58)
export {
  RefineIdentities,
  defaultRefineIdentitiesConfig,
  SemanticDuplicateDetector,
  defaultDuplicateDetectorConfig,
  EmbeddingBudgetGuard,
  InMemoryEmbeddingCache,
} from "./semantic/sameness/index.js";
export type {
  RefineIdentitiesResult,
  SkeletonProjector,
  RefineIdentitiesConfig,
  DuplicateDetectionResult,
  DuplicateDetectorConfig,
} from "./semantic/sameness/index.js";

// E3.6 — Capstone: WorkflowMap assembly use-case + the shared cross-pass budget meter (#59)
export { BuildWorkflowMap } from "./semantic/BuildWorkflowMap.js";
export type { Clock } from "./semantic/BuildWorkflowMap.js";
export { RunBudgetMeter } from "./semantic/budget/RunBudgetMeter.js";
