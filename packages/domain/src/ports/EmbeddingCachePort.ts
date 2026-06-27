/**
 * EmbeddingCachePort — the port for caching one screen-embedding VECTOR per distinct a11y bucket
 * (E3.5 / #58, ADR-0005 §4.4 / §5).
 *
 * Mirrors the `IntentCachePort` / `DecisionCachePort` pattern, but keyed and valued differently:
 *   - keyed by the bucket's a11y `StateIdentity` (the SAME `EmbeddingInput.cacheKey` the port
 *     declares) — so the orchestrator issues EXACTLY ONE embedding per distinct bucket
 *     (ADR-0005 §4.4); a re-encounter of the same identity reuses the cached vector.
 *   - values are the embedding VECTOR only (`readonly number[]`) — never raw a11y text, never a
 *     screenshot, never PII. The vector is produced over the already-redacted skeleton (T1/T7), so
 *     no secret can reach the cache through it either.
 *
 * E3 ships an in-memory implementation (`InMemoryEmbeddingCache`, application layer); E7 swaps a
 * persistent implementation at the composition root (Open/Closed — the port is the stable seam, the
 * orchestrator never changes). The key is the process-independent `StateIdentity`, so it does NOT
 * preclude E7 cross-run persistence.
 *
 * Additive domain port addition — no existing contract broken (sanctioned by ADR-0005 §10).
 */
import type { StateIdentity } from "../models/state-graph.js";

export interface EmbeddingCachePort {
  /**
   * Retrieve the cached embedding vector for a bucket identity, or `null` on a miss.
   * A cached EMPTY vector (`[]`) is a valid degraded result — distinct from a miss (`null`).
   */
  get(key: StateIdentity): Promise<readonly number[] | null>;

  /**
   * Cache the embedding vector for a bucket identity. Overwrites any prior entry.
   * Implementations MUST NOT persist raw a11y bodies, credentials, or screenshots (T7): the value
   * is a numeric vector only, derived from the already-redacted skeleton upstream.
   */
  set(key: StateIdentity, vector: readonly number[]): Promise<void>;
}
