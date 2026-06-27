/**
 * GroupingConfig — configuration for the two-tier naming/grouping (#56, ADR-0007 §3.1).
 *
 * No magic literals: every tunable (enable flag, refine-only-weak, char caps) is injected.
 * Mirrors `InferIntentConfig` (#55).
 */

/** Sentinel feature group for a workflow with no confident grouping (ADR-0007 §2). */
export const UNGROUPED = "Ungrouped";

/** Sentinel app purpose when none can be inferred (ADR-0007 §2). */
export const UNKNOWN_PURPOSE = "Unknown";

/** Configuration for the two-tier naming/grouping (injected). */
export interface GroupingConfig {
  /** Master switch for tier-2 (LLM naming/grouping). When false, ONLY tier-1 runs (zero LLM calls). */
  readonly refinementEnabled: boolean;
  /**
   * When true, tier-2 naming is attempted only for workflows whose tier-1 label is WEAK
   * (provisional/"Ungrouped" — low signal), keeping the LLM rare. When false, tier-2 is
   * attempted for every workflow (still budget- and cache-gated).
   */
  readonly refineOnlyWeak: boolean;
  /**
   * When true, a single per-map app-purpose LLM call is attempted (still budget- and
   * cache-gated). When false (or refinement disabled), the rule-based purpose stands.
   */
  readonly inferPurposeWithLlm: boolean;
}

/** Conservative default: rule-first, refine only weak workflows, attempt one purpose call. */
export function defaultGroupingConfig(): GroupingConfig {
  return { refinementEnabled: true, refineOnlyWeak: true, inferPurposeWithLlm: true };
}
