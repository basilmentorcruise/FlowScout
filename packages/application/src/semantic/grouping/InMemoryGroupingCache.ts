/**
 * InMemoryGroupingCache — process-lifetime in-memory `GroupingCachePort` (#56, ADR-0007 §3.4).
 *
 * E3 ships this as the default; E7 swaps a persistent implementation at the composition root
 * (Open/Closed — the port is the stable abstraction; the refiner never changes).
 *
 * Security (T1/T2): stores REDACTED-DERIVED `WorkflowLabeling` values only — no raw a11y
 * bodies, screenshots, or PII. The key is a content hash of the already-redacted skeleton
 * (`GroupingCacheKey`), so no secret can appear in a key either. This class makes ZERO LLM
 * calls. Port-only: no adapter/SDK imports (NFR1).
 */
import type { GroupingCachePort, WorkflowLabeling } from "@flowscout/domain";

/**
 * Per-run in-memory grouping cache keyed by the redacted-skeleton content hash.
 *
 * Thread safety: JavaScript is single-threaded; no concurrent mutation possible.
 * Lifetime: process-scoped (E7 provides durable persistence).
 */
export class InMemoryGroupingCache implements GroupingCachePort {
  private readonly _cache = new Map<string, WorkflowLabeling>();

  /** Returns the cached labeling for the key, or null if not cached. O(1). */
  get(key: string): Promise<WorkflowLabeling | null> {
    return Promise.resolve(this._cache.get(key) ?? null);
  }

  /**
   * Caches a (REDACTED-derived) workflow labeling under the key. Overwrites any prior
   * entry. O(1). The cache is a passive store — the caller guarantees redaction upstream.
   */
  set(key: string, labeling: WorkflowLabeling): Promise<void> {
    this._cache.set(key, labeling);
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
