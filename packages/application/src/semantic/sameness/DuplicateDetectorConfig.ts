/**
 * DuplicateDetectorConfig — named config for `SemanticDuplicateDetector` (#58).
 *
 * No magic literals (ADR-0001 §6). Defaulted here, overridable at the composition root (#59).
 */

/** Configuration for the semantic duplicate / hidden-path detector. */
export interface DuplicateDetectorConfig {
  /**
   * When true AND an `IntentModel` is supplied, a candidate duplicate set is SUPPRESSED at flag time
   * if the converging outcomes' `ScreenIntent` (source `llm`) purposes CONFIDENTLY CONFLICT — the
   * class-level precision gate that catches the transitive label-veto bypass the refiner's pairwise
   * veto can miss (A–C–B co-classing). Absent / degraded / agreeing intents never suppress
   * (precision wins; a disagreement is the only thing that suppresses).
   */
  readonly confirmWithIntent: boolean;
}

/** Conservative default: confirm flagged groups against confident intent labels (precision floor). */
export function defaultDuplicateDetectorConfig(): DuplicateDetectorConfig {
  return { confirmWithIntent: true };
}
