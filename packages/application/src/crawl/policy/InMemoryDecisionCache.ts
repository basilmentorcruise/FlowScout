/**
 * InMemoryDecisionCache — process-lifetime in-memory implementation of DecisionCachePort.
 *
 * E2 ships this as the default; E7 swaps in a persistent implementation at the
 * composition root (Open/Closed — the cache port is the stable abstraction).
 *
 * Security (T7, ADR-0004 §3.4):
 *   - Stores only PolicyDecision values — no raw a11y snapshots, screenshots, or PII.
 *   - The cache key is a StateIdentity (a hash), not the raw a11y body.
 *   - This class makes zero LLM calls — it is pure in-memory state.
 *
 * Port-only: no adapter/SDK imports (T10/NFR1). Pure domain + application logic.
 */
import type { StateIdentity } from "@flowscout/domain";
import type { PolicyDecision } from "@flowscout/domain";
import type { DecisionCachePort } from "@flowscout/domain";

/**
 * InMemoryDecisionCache — per-run in-memory cache keyed by StateIdentity.
 *
 * Thread safety: JavaScript is single-threaded; no concurrent mutation possible.
 * Lifetime: process-scoped. All entries are lost on process exit (E7 durable persistence).
 */
export class InMemoryDecisionCache implements DecisionCachePort {
  private readonly _cache = new Map<StateIdentity, PolicyDecision>();

  /**
   * Returns the cached decision for the given state, or null if not cached.
   * O(1) lookup.
   */
  get(stateId: StateIdentity): Promise<PolicyDecision | null> {
    return Promise.resolve(this._cache.get(stateId) ?? null);
  }

  /**
   * Caches a decision for the given state.
   * Overwrites any previously cached decision for the same state.
   * O(1) write.
   *
   * Security: caller (LLMPolicy) must pass a decision derived from a REDACTED
   * state representation — this cache is a passive store, it does not enforce
   * redaction itself.
   */
  set(stateId: StateIdentity, decision: PolicyDecision): Promise<void> {
    this._cache.set(stateId, decision);
    return Promise.resolve();
  }

  /** Returns the number of cached entries (for testing/telemetry). */
  get size(): number {
    return this._cache.size;
  }

  /** Returns true if the given stateId has a cached entry (for testing). */
  has(stateId: StateIdentity): boolean {
    return this._cache.has(stateId);
  }
}
