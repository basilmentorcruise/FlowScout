/**
 * Workflow domain model.
 * A workflow is a semantically-grouped sequence of state transitions that achieves
 * a user goal (e.g., "sign in", "add item to cart").
 */
import type { StateEdge, StateIdentity } from "./state-graph.js";

/** A single step within a workflow. */
export interface WorkflowStep {
  readonly stepIndex: number;
  readonly stateId: StateIdentity;
  readonly edge: StateEdge | null; // null for the terminal state
  readonly description: string;
}

/** Confidence score for LLM-inferred groupings (0–1). */
export type ConfidenceScore = number & { readonly __brand: "ConfidenceScore" };

export function makeConfidenceScore(value: number): ConfidenceScore {
  if (value < 0 || value > 1) {
    throw new Error(`ConfidenceScore must be in [0, 1], got ${String(value)}`);
  }
  return value as ConfidenceScore;
}

/** A grouped, named workflow discovered during the crawl. */
export interface Workflow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly steps: readonly WorkflowStep[];
  /** Whether this workflow involves a hidden or non-obvious path. */
  readonly isHiddenPath: boolean;
  /** LLM confidence for the inferred grouping; null if rule-based. */
  readonly inferenceConfidence: ConfidenceScore | null;

  /**
   * NEW (#56, ADR-0007). The feature this workflow belongs to, e.g. "Authentication",
   * "Cart & Checkout". Inert, untrusted-origin text (E4 MUST output-encode — T7).
   *   - omitted/undefined  ⇒ pre-#56 object (back-compat) — E4 renders it ungrouped.
   *   - "Ungrouped"        ⇒ #56 ran but produced no confident group (LLM disabled/over-budget/low-signal).
   * Never empty when present. The deterministic fallback sets "Ungrouped", not undefined,
   * so a #56-processed map is distinguishable from a raw extractor map.
   */
  readonly featureGroup?: string;
}

/** All workflows discovered in a single crawl run. */
export interface WorkflowMap {
  readonly runId: string;
  readonly workflows: readonly Workflow[];
  /** ISO-8601 timestamp when the map was finalised. */
  readonly finalisedAt: string;

  /**
   * NEW (#56, ADR-0007). The app's overall one-line purpose, e.g. "A ride-hailing app for
   * booking trips". Inert, untrusted-origin text (E4 MUST output-encode — T7). Never empty
   * when present.
   *   - omitted/undefined  ⇒ pre-#56 / not-yet-inferred.
   *   - "Unknown"          ⇒ #56 ran but could not infer (LLM disabled/over-budget) — pairs with null confidence.
   */
  readonly appPurpose?: string;

  /**
   * NEW (#56, ADR-0007). Confidence for `appPurpose`.
   *   - a ConfidenceScore ⇒ LLM-derived purpose.
   *   - null              ⇒ rule-based / "Unknown" purpose (mirrors workflow.inferenceConfidence semantics).
   *   - undefined         ⇒ not inferred (pairs with appPurpose undefined).
   */
  readonly appPurposeConfidence?: ConfidenceScore | null;
}
