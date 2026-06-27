/**
 * InMemoryEmbeddingCache — process-lifetime implementation of `EmbeddingCachePort` (#58).
 *
 * Mirrors `InMemoryIntentCache` / `InMemoryDecisionCache` exactly. E3 ships this as the default; E7
 * swaps a persistent implementation at the composition root (Open/Closed — the port is the stable
 * abstraction; the orchestrator never changes).
 *
 * Security (T7, ADR-0005 §4.4): stores embedding VECTORS only — no raw a11y bodies, screenshots, or
 * PII. The key is the bucket's a11y `StateIdentity` (never raw text), so no secret can appear in a
 * key either. This class makes ZERO embedding calls.
 *
 * Port-only: no adapter/SDK imports (NFR1).
 */
import type { EmbeddingCachePort, StateIdentity } from "@flowscout/domain";

/**
 * Per-run in-memory embedding cache keyed by the bucket's a11y `StateIdentity`.
 *
 * Thread safety: JavaScript is single-threaded; no concurrent mutation possible.
 * Lifetime: process-scoped (E7 provides durable persistence).
 */
export class InMemoryEmbeddingCache implements EmbeddingCachePort {
  private readonly _cache = new Map<StateIdentity, readonly number[]>();

  /** Returns the cached vector for the bucket identity, or null on a miss. O(1). */
  get(key: StateIdentity): Promise<readonly number[] | null> {
    return Promise.resolve(this._cache.get(key) ?? null);
  }

  /**
   * Caches the embedding vector under the bucket identity. Overwrites any prior entry. O(1).
   * The cache is a passive store — the caller guarantees the vector came from a redacted skeleton.
   */
  set(key: StateIdentity, vector: readonly number[]): Promise<void> {
    this._cache.set(key, vector);
    return Promise.resolve();
  }

  /** Number of cached entries (for testing/telemetry). */
  get size(): number {
    return this._cache.size;
  }

  /** True if the bucket identity has a cached entry (for testing). */
  has(key: StateIdentity): boolean {
    return this._cache.has(key);
  }
}
