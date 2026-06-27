/**
 * @flowscout/application — semantic/grouping module barrel (#56 / E3.3, ADR-0007).
 * App-purpose + workflow naming & feature grouping (rule-first, budgeted LLM). Depends only on
 * @flowscout/domain ports + application collaborators — no adapters, no SDK.
 */

export { NameAndGroupWorkflows } from "./NameAndGroupWorkflows.js";
export type { NameAndGroupResult } from "./NameAndGroupWorkflows.js";

export { RuleNameStrategy, FEATURE_GROUP_RULES, MAX_NAME_CHARS, MAX_DESCRIPTION_CHARS } from "./RuleNameStrategy.js";
export type { RedactedScreenSignal, RuleLabelingResult } from "./RuleNameStrategy.js";

export { LlmNamingRefiner } from "./LlmNamingRefiner.js";

export { AppPurposeInferer } from "./AppPurposeInferer.js";
export type { AppPurposeResult } from "./AppPurposeInferer.js";

export { InMemoryGroupingCache } from "./InMemoryGroupingCache.js";
export { groupingCacheKey, purposeCacheKey, GROUPING_KEY_PREFIX, PURPOSE_KEY_PREFIX } from "./GroupingCacheKey.js";

export { defaultGroupingConfig, UNGROUPED, UNKNOWN_PURPOSE } from "./GroupingConfig.js";
export type { GroupingConfig } from "./GroupingConfig.js";
