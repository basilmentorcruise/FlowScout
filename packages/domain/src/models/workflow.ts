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
}

/** All workflows discovered in a single crawl run. */
export interface WorkflowMap {
  readonly runId: string;
  readonly workflows: readonly Workflow[];
  /** ISO-8601 timestamp when the map was finalised. */
  readonly finalisedAt: string;
}
