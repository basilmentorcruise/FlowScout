/**
 * Intent domain model (E3.2 / #55 — ADR-0006 §2).
 *
 * A SEMANTIC OVERLAY over a finalized state-graph: per-screen and per-control
 * inferred intent, computed post-crawl by the application `semantic/intent` use-case.
 *
 * Design (ADR-0006 §2): this is a NEW, separate structure — it is NOT attached to
 * `StateNode`/`StateEdge`. Those are E2 crawl-time records owned by the crawl loop.
 * Intent is an E3 post-hoc semantic concern: attaching inferred, possibly-LLM-derived,
 * confidence-bearing fields onto the crawl record would couple crawl persistence to
 * semantics (separation of concerns) and force every E2 producer to populate fields it
 * does not own (Open/Closed). The overlay instead joins back to the graph via
 * `StateIdentity` (screen) and `StateEdge.id` (control).
 *
 * Additive-only: no existing field changes — same posture as the additive
 * `DecisionCachePort` (ADR-0004 §3.4).
 */
import type { StateIdentity } from "./state-graph.js";
import type { ConfidenceScore } from "./workflow.js"; // reuse — no new confidence type

/**
 * How an intent value was derived (provenance — drives confidence + cost auditing).
 *
 *   - "a11y":     deterministic tier-1 derivation from accessibility labels/roles.
 *   - "degraded": tier-1 fallback when labels are missing/empty (role + position).
 *   - "llm":      tier-2 LLM refinement (the ONLY source that carries a confidence).
 */
export type IntentSource = "a11y" | "llm" | "degraded";

/**
 * Inferred intent for one control (an observed affordance / graph edge).
 *
 * Shape guarantee: `intent` is never empty (the degraded fallback fills it).
 * `confidence` is non-null IFF `source === "llm"`.
 */
export interface ControlIntent {
  /** Joins back to `StateEdge.id` (the observed affordance). */
  readonly edgeId: string;
  /**
   * Mirrors `StateEdge.actionType`. String-typed (not the `ActionType` union) to keep
   * the overlay decoupled from churn in the crawl action vocabulary.
   */
  readonly actionType: string;
  /** What this control is for, e.g. "Submit the sign-in form". Never empty. */
  readonly intent: string;
  /**
   * The affordance class, e.g.
   * "navigation" | "submit" | "input" | "toggle" | "dismiss" | "unknown".
   */
  readonly affordance: string;
  readonly source: IntentSource;
  /** Confidence for LLM-derived intent; null for a11y/degraded (mirrors workflow.inferenceConfidence). */
  readonly confidence: ConfidenceScore | null;
}

/**
 * Inferred intent for one screen + its controls.
 *
 * Shape guarantee: `purpose` is never empty (the degraded fallback fills it).
 * `confidence` is non-null IFF `source === "llm"`.
 */
export interface ScreenIntent {
  readonly stateId: StateIdentity;
  /** One-line purpose of the screen, e.g. "Sign-in screen". Never empty. */
  readonly purpose: string;
  readonly source: IntentSource;
  readonly confidence: ConfidenceScore | null;
  readonly controls: readonly ControlIntent[];
}

/**
 * All inferred intents for one run's graph — the consumer contract for #56.
 *
 * Always present and well-formed, even for an empty/single-node graph (NFR6).
 */
export interface IntentModel {
  readonly runId: string;
  readonly screens: readonly ScreenIntent[];
}
