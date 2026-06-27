/**
 * GroupingCachePort — the port for caching per-workflow naming/grouping labels (E3.3 / #56).
 *
 * Mirrors the `DecisionCachePort`/`IntentCachePort` pattern (ADR-0007 §3.4), but keyed
 * differently:
 *   - `IntentCachePort` is keyed by the redacted a11y skeleton → `ScreenIntent`.
 *   - `GroupingCachePort` is keyed by a STABLE CONTENT HASH of the REDACTED workflow+intent
 *     skeleton (`GroupingCacheKey`) → `WorkflowLabeling`. Two identical workflows share a
 *     labeling, and re-running the same input makes ZERO new LLM calls (FR6). This is
 *     intended and safe for labels: identical content ⇒ identical name/group.
 *
 * E3 ships an in-memory implementation (`InMemoryGroupingCache`, application layer).
 * E7 swaps a persistent implementation at the composition root — Open/Closed, zero refiner
 * change. The content-hash key is process-independent, so it does NOT preclude E7 cross-run
 * persistence.
 *
 * Security (T1/T2, ADR-0007 §3.4): the cache stores REDACTED-DERIVED `WorkflowLabeling` values
 * only — never raw a11y bodies, credentials, or screenshots. The key is derived from the
 * already-redacted skeleton, so no secret can appear in a key either.
 *
 * Additive domain port addition; no existing contracts broken.
 */
import type { ConfidenceScore } from "../models/workflow.js";

/**
 * The cacheable labeling result for one workflow (redacted-derived; no raw a11y/secret text).
 *   - `confidence` is non-null IFF the labeling was LLM-derived (mirrors workflow.inferenceConfidence).
 */
export interface WorkflowLabeling {
  readonly name: string;
  readonly description: string;
  readonly featureGroup: string;
  readonly confidence: ConfidenceScore | null;
}

export interface GroupingCachePort {
  /**
   * Retrieve a cached workflow labeling for the given content-hash key.
   * Returns null if no labeling is cached for this key.
   */
  get(key: string): Promise<WorkflowLabeling | null>;

  /**
   * Cache a workflow labeling under the given content-hash key.
   * Implementations must NOT persist raw PII, credentials, or screenshots (T2):
   * the caller stores a REDACTED-derived `WorkflowLabeling` only.
   */
  set(key: string, labeling: WorkflowLabeling): Promise<void>;
}
