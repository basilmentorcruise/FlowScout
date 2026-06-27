/**
 * DuplicatePathGroup — the expressible cross-workflow convergence association (E3.5 / #58).
 *
 * Emitted by the application `SemanticDuplicateDetector` when ≥2 workflows reach the SAME CANONICAL
 * outcome via DISTINCT raw state identities — the semantic-duplicate / hidden-path case E2's
 * structural `duplicatePathNodeIds` (same-raw-id convergence) misses.
 *
 * Design (ADR-0005 §4.4, mirroring #55's intent overlay): this convergence RELATION is a NEW,
 * separate structure — deliberately NOT a field on `Workflow`. A cross-workflow relation does not
 * belong on the `Workflow` entity (it would bloat the entity and couple sibling workflows). The
 * `Workflow.isHiddenPath` flag (the existing field) is set on the less-prominent route; this group
 * is the association #59/E4 binds onto the `WorkflowMap` to render "these N paths reach the same
 * place". #58 only PRODUCES `DuplicatePathGroup[]` alongside the mutated-copy `Workflow[]`.
 *
 * Additive-only domain model: nothing references it yet; no existing field changes.
 */
import type { StateIdentity } from "./state-graph.js";

/** One semantic-duplicate set: workflows converging on a shared CANONICAL outcome. */
export interface DuplicatePathGroup {
  /** The shared CANONICAL outcome identity these workflows converge on (post-refinement). */
  readonly outcomeIdentity: StateIdentity;
  /** All converging workflow ids (sorted lexicographically — deterministic). */
  readonly workflowIds: readonly string[];
  /** The PROMINENT route (most direct; not hidden) — fewest steps, lexicographic tie-break. */
  readonly canonicalWorkflowId: string;
  /** The routes flagged `isHiddenPath = true` (sorted lexicographically — deterministic). */
  readonly hiddenWorkflowIds: readonly string[];
}
