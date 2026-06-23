/**
 * DecisionCachePort — the port for caching LLM policy decisions per StateIdentity.
 *
 * E2 ships an in-memory implementation (InMemoryDecisionCache, in application layer).
 * E7 swaps a persistent implementation at the composition root — Open/Closed, zero policy change.
 *
 * Security (T7): the cache stores REDACTED state representations only.
 * Never stores raw a11y bodies, credentials, or screenshots.
 *
 * ADR-0004 §3.4 — additive domain port addition; no existing contracts broken.
 */
import type { StateIdentity } from "../models/state-graph.js";
import type { PolicyDecision } from "./DecisionPolicyPort.js";

export interface DecisionCachePort {
  /**
   * Retrieve a cached decision for the given state identity.
   * Returns null if no decision is cached for this state.
   */
  get(stateId: StateIdentity): Promise<PolicyDecision | null>;

  /**
   * Cache a decision for the given state identity.
   * Implementations must NOT persist raw PII, credentials, or screenshots (T7).
   */
  set(stateId: StateIdentity, decision: PolicyDecision): Promise<void>;
}
