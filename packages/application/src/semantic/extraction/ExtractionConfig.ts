/**
 * ExtractionConfig — caps value object for rule-based workflow extraction (#54 / E3.1).
 *
 * Application-layer config (NOT a domain concept), so it lives here, not in
 * `packages/domain/src/models/`. Both caps are NAMED — no magic numbers leak into
 * the traversal (AC3). Defaults mirror ADR-0004's revisit/plateau scale.
 */

/** Bounds on the bounded-DFS path enumeration. */
export interface ExtractionConfig {
  /** Maximum number of states in a single workflow path (per-path depth cap). */
  readonly maxPathLength: number;
  /** Maximum number of workflows emitted before enumeration stops deterministically. */
  readonly maxWorkflows: number;
}

/**
 * Default caps. `maxPathLength` mirrors ADR-0004's plateau/revisit scale; `maxWorkflows`
 * bounds the combinatorial blow-up on dense real graphs. Tunable, gate-checked as config.
 */
export const defaultExtractionConfig: ExtractionConfig = {
  maxPathLength: 40,
  maxWorkflows: 500,
};
