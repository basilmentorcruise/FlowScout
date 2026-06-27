/**
 * RefineIdentitiesConfig — named config for the post-hoc embedding-pass orchestrator (#58).
 *
 * No magic literals (ADR-0001 §6). Defaulted here, overridable at the composition root (#59).
 */

/** Configuration for `RefineIdentities` (the embedding-pass orchestrator). */
export interface RefineIdentitiesConfig {
  /**
   * When true AND an `IntentModel` is supplied, a bucket's `semanticLabel` (the refiner's veto-gate
   * input) is set from the outcome screen's intent — but ONLY when `ScreenIntent.source === "llm"`
   * (a confident label). Degraded/a11y purposes are never passed (an over-eager veto only ever
   * SUPPRESSES a merge — the safe direction — but we keep it conservative). When false, no labels
   * are passed and the refiner relies on cosine alone.
   */
  readonly labelsFromIntent: boolean;
}

/** Conservative default: pass confident (llm) labels as veto input when an intent is available. */
export function defaultRefineIdentitiesConfig(): RefineIdentitiesConfig {
  return { labelsFromIntent: true };
}
