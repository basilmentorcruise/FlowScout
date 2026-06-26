/**
 * SamenessConfig — the named, precision-biased thresholds for E3 identity refinement (#57).
 *
 * Per ADR-0005 §3: all values are NAMED config constants (no magic numbers — ADR-0001 §6),
 * defaulted in `defaultSamenessConfig` and overridable at the composition root. The defaults
 * encode the precision-over-recall bias by construction (raised merge gate, dead-band → distinct,
 * veto-only label, degraded → a11y-only).
 *
 * Pure domain config — no I/O, no SDK, deterministic.
 */

/** Configuration for the gated-cascade sameness refinement (ADR-0005 §2/§3). */
export interface SamenessConfig {
  /**
   * MASTER SWITCH (FR4). When false, refinement is OFF: the refiner returns singleton classes
   * (exact E2 behaviour, byte-for-byte). When true, the cross-bucket merge cascade runs.
   */
  readonly refinementEnabled: boolean;
  /**
   * `MERGE_THRESHOLD` — the cross-bucket merge gate. Two screens in DIFFERENT a11y buckets merge
   * only if `cosine ≥ MERGE_THRESHOLD` (and the label gate does not veto). Raised from the
   * provisional 0.92 to 0.94 because precision dominates recall (ADR-0005 §3).
   */
  readonly mergeThreshold: number;
  /**
   * `MERGE_MARGIN` — the dead-band width. Cosines in
   * `[mergeThreshold − mergeMargin, mergeThreshold)` are "uncertain" → DISTINCT (do NOT merge),
   * recorded as a low-confidence telemetry note. Prevents threshold-edge flapping (ADR-0005 §3).
   */
  readonly mergeMargin: number;
  /**
   * `LABEL_VETO_ENABLED` — when true, a confident, normalized semantic-label DISAGREEMENT vetoes
   * a borderline embedding merge (pure precision guard). The label can only ever VETO a merge,
   * never CREATE one (ADR-0005 §2.2).
   */
  readonly labelVetoEnabled: boolean;
  /**
   * `MIN_EMBEDDING_DIM` — vectors below this dimensionality are rejected/degraded (a degenerate
   * embedding must not silently merge everything — ADR-0005 §3).
   */
  readonly minEmbeddingDim: number;
}

/** `MERGE_THRESHOLD` default (ADR-0005 §3). */
export const DEFAULT_MERGE_THRESHOLD = 0.94;
/** `MERGE_MARGIN` default — the dead-band width (ADR-0005 §3). */
export const DEFAULT_MERGE_MARGIN = 0.02;
/** `MIN_EMBEDDING_DIM` default (ADR-0005 §3). */
export const DEFAULT_MIN_EMBEDDING_DIM = 256;

/**
 * Default sameness config — precision-biased starting points (ADR-0005 §3), tunable at the root.
 *
 * | Field             | Default | Rationale (ADR-0005 §3)                                         |
 * | ----------------- | ------- | --------------------------------------------------------------- |
 * | refinementEnabled | true    | Refinement on; flip to false for byte-for-byte E2 behaviour.    |
 * | mergeThreshold    | 0.94    | Raised gate — a false merge is costlier than a miss.            |
 * | mergeMargin       | 0.02    | Dead-band `[0.92, 0.94)` → DISTINCT (telemetry only).           |
 * | labelVetoEnabled  | true    | Confident label disagreement vetoes a borderline merge.         |
 * | minEmbeddingDim   | 256     | Reject degenerate low-dim vectors (no silent merge-everything). |
 */
export function defaultSamenessConfig(): SamenessConfig {
  return {
    refinementEnabled: true,
    mergeThreshold: DEFAULT_MERGE_THRESHOLD,
    mergeMargin: DEFAULT_MERGE_MARGIN,
    labelVetoEnabled: true,
    minEmbeddingDim: DEFAULT_MIN_EMBEDDING_DIM,
  };
}
