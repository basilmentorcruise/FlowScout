/**
 * IntentCachePort — the port for caching inferred per-screen intent (E3.2 / #55).
 *
 * Mirrors the `DecisionCachePort` pattern (ADR-0006 §3.4), but keyed differently:
 *   - `DecisionCachePort` is keyed by `StateIdentity` → `PolicyDecision` (a crawl-decision cache).
 *   - `IntentCachePort` is keyed by a STABLE CONTENT HASH of the REDACTED a11y skeleton
 *     → `ScreenIntent`. Two distinct screen identities with the same redacted skeleton share
 *     one inference (cost amortization across identical content). This is intended and safe:
 *     identical content ⇒ identical purpose.
 *
 * E3 ships an in-memory implementation (`InMemoryIntentCache`, application layer).
 * E7 swaps a persistent implementation at the composition root — Open/Closed, zero refiner change.
 * The content-hash key is process-independent, so it does NOT preclude E7 cross-run persistence.
 *
 * Security (T7, ADR-0006 §3.4): the cache stores REDACTED `ScreenIntent` values only —
 * never raw a11y bodies, credentials, or screenshots. The key is derived from the
 * already-redacted skeleton, so no secret can appear in a key either.
 *
 * Additive domain port addition; no existing contracts broken.
 */
import type { ScreenIntent } from "../models/intent.js";

export interface IntentCachePort {
  /**
   * Retrieve a cached screen intent for the given content-hash key.
   * Returns null if no intent is cached for this key.
   */
  get(key: string): Promise<ScreenIntent | null>;

  /**
   * Cache an inferred screen intent under the given content-hash key.
   * Implementations must NOT persist raw PII, credentials, or screenshots (T7):
   * the caller stores a REDACTED `ScreenIntent` only.
   */
  set(key: string, intent: ScreenIntent): Promise<void>;
}
