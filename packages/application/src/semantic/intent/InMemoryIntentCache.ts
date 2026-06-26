/**
 * InMemoryIntentCache — process-lifetime in-memory implementation of `IntentCachePort` (#55).
 *
 * E3 ships this as the default; E7 swaps a persistent implementation at the composition root
 * (Open/Closed — the port is the stable abstraction; the refiner never changes).
 *
 * Security (T7, ADR-0006 §3.4): stores REDACTED `ScreenIntent` values only — no raw a11y
 * bodies, screenshots, or PII. The key is a content hash of the already-redacted skeleton
 * (`IntentCacheKey`), so no secret can appear in a key either. This class makes ZERO LLM calls.
 *
 * Port-only: no adapter/SDK imports (NFR1).
 */
import type { IntentCachePort, ScreenIntent } from "@flowscout/domain";

/**
 * Per-run in-memory intent cache keyed by the redacted-skeleton content hash.
 *
 * Thread safety: JavaScript is single-threaded; no concurrent mutation possible.
 * Lifetime: process-scoped (E7 provides durable persistence).
 */
export class InMemoryIntentCache implements IntentCachePort {
  private readonly _cache = new Map<string, ScreenIntent>();

  /** Returns the cached intent for the key, or null if not cached. O(1). */
  get(key: string): Promise<ScreenIntent | null> {
    return Promise.resolve(this._cache.get(key) ?? null);
  }

  /**
   * Caches a (REDACTED) screen intent under the key. Overwrites any prior entry. O(1).
   * The cache is a passive store — the caller guarantees redaction upstream.
   */
  set(key: string, intent: ScreenIntent): Promise<void> {
    this._cache.set(key, intent);
    return Promise.resolve();
  }

  /** Number of cached entries (for testing/telemetry). */
  get size(): number {
    return this._cache.size;
  }

  /** True if the key has a cached entry (for testing). */
  has(key: string): boolean {
    return this._cache.has(key);
  }
}
