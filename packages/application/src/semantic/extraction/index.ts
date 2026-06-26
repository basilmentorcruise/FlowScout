/**
 * @flowscout/application — semantic/extraction module barrel (#54 / E3.1).
 * Rule-based, pure workflow extraction from a finalized StateGraph. Depends only on
 * @flowscout/domain types — no adapters, no SDK, no port.
 */

export { WorkflowExtractor, defaultWorkflowExtractor, workflowId } from "./WorkflowExtractor.js";
export type { ExtractionResult } from "./WorkflowExtractor.js";

export { ruleBasedEntryPolicy, launchNodeId } from "./EntryPolicy.js";
export type { EntryPolicy } from "./EntryPolicy.js";

export { ruleBasedOutcomePolicy } from "./OutcomePolicy.js";
export type { OutcomePolicy } from "./OutcomePolicy.js";

export { defaultExtractionConfig } from "./ExtractionConfig.js";
export type { ExtractionConfig } from "./ExtractionConfig.js";

export { GraphAdjacency } from "./GraphAdjacency.js";
export { buildSteps } from "./WorkflowStepBuilder.js";
