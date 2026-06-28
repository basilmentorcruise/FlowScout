/**
 * BuildWorkflowMap — the E3.6 capstone use-case (#59). Assembles the five merged E3 pieces into
 * ONE finalized `WorkflowMap` for a run (the E4/E8 consumer contract).
 *
 * A THIN orchestrator: it owns the ORDER and the per-run budget reset, delegates every step to an
 * injected, already-built collaborator, and assembles the single map. It imports ONLY domain types
 * + application collaborators — never an adapter/SDK (NFR1). Root wiring is `packages/api` (#59 §6).
 *
 * Orchestration order (the only correct one — E3.6 §1):
 *   0. budget.reset()                                    — one shared counter, fresh per run (§4)
 *   1. graph = stateGraphRepository.findByRunId(runId)
 *        null / empty ⇒ return emptyMap(runId)           — NFR6, edge case
 *   2. extractor.extract(graph)                          — #54 pure, rule-based
 *   3. inferIntent.execute(graph)                        — #55 a11y-first, budgeted LLM (ONCE)
 *   4. refineIdentities.execute(graph, intent)           — #58 post-hoc embedding pass → canonicalMap
 *   5. duplicateDetector.detect(workflows, canonicalMap, intent)  — #58 pure: sets isHiddenPath + groups
 *   6. nameAndGroup.execute(detected.workflows, intent)  — #56 budgeted LLM, RELABEL-only
 *   7. assemble WorkflowMap
 *
 * Why DETECT BEFORE GROUP (critical): the detector sets `isHiddenPath` on the hidden routes;
 * `NameAndGroupWorkflows` is the LAST relabel pass and spreads `...workflow` (copying
 * id/steps/isHiddenPath through unchanged). Running detect first means the FINAL workflow objects
 * already carry the flag — grouping never reads or drops it, but this keeps a single copy pass.
 *
 * Why INTENT ONCE before refine AND group: refine consumes it for its confident-label veto, and
 * both the detector and naming/grouping consume the same `IntentModel`. Inferring it once keeps the
 * budget honest and the inputs consistent.
 *
 * Resilience (NFR6): the three async passes (#55/#56/#58) each degrade INTERNALLY (tier-1 /
 * a11y-only / null confidence) and never throw on inference failure — so there is NO try/catch
 * around them here; the only defensive boundary is the `graph == null` check. Exactly ONE
 * well-formed `WorkflowMap` is always returned per run.
 *
 * Determinism (NFR2): extraction is deterministic; detect returns `workflows.map(...)` (same
 * order/count); grouping iterates input order (same order/count). Same graph + same fakes ⇒
 * deep-equal map.
 */
import type { StateGraphRepository, WorkflowMap } from "@flowscout/domain";
import type { WorkflowExtractor } from "./extraction/WorkflowExtractor.js";
import type { InferIntent } from "./intent/InferIntent.js";
import type { RefineIdentities } from "./sameness/RefineIdentities.js";
import type { SemanticDuplicateDetector } from "./sameness/SemanticDuplicateDetector.js";
import type { NameAndGroupWorkflows } from "./grouping/NameAndGroupWorkflows.js";
import type { RunBudgetMeter } from "./budget/RunBudgetMeter.js";

/** A clock seam (deterministic in tests). Returns an ISO-8601 timestamp. */
export type Clock = () => string;

export class BuildWorkflowMap {
  constructor(
    private readonly stateGraphRepository: StateGraphRepository,
    private readonly extractor: WorkflowExtractor,
    private readonly inferIntent: InferIntent,
    private readonly refineIdentities: RefineIdentities,
    private readonly duplicateDetector: SemanticDuplicateDetector,
    private readonly nameAndGroup: NameAndGroupWorkflows,
    private readonly budget: RunBudgetMeter,
    private readonly clock: Clock = () => new Date().toISOString(),
  ) {}

  /**
   * Build the single finalized `WorkflowMap` for `runId`.
   *
   * @param runId  the run whose finalized `StateGraph` is loaded from the repository port.
   * @returns      exactly one well-formed `WorkflowMap` (degraded-safe, never torn).
   */
  async execute(runId: string): Promise<WorkflowMap> {
    // 0. One shared counter, fresh for this run (intent + naming + embedding draw on it).
    this.budget.reset();

    // 1. Load the finalized graph. A missing / empty graph yields a valid empty map (no crash).
    const graph = await this.stateGraphRepository.findByRunId(runId);
    if (graph === null || graph.nodes.size === 0) {
      return this.emptyMap(runId);
    }

    // 2. Extract end-to-end workflows (pure, deterministic).
    const { workflows } = this.extractor.extract(graph);

    // 3. Infer intent ONCE (consumed by refine, detect, and naming/grouping).
    const intent = await this.inferIntent.execute(graph);

    // 4. Post-hoc embedding pass → the canonical identity map (raw → canonical outcome).
    const refined = await this.refineIdentities.execute(graph, intent);

    // 5. Apply the canonical map: flag hidden routes + emit cross-identity duplicate groups.
    const detected = this.duplicateDetector.detect(workflows, refined.canonicalMap, intent);

    // 6. Name + feature-group (relabel-only) and infer the one-line app purpose.
    const named = await this.nameAndGroup.execute(detected.workflows, intent);

    // 7. Assemble the single finalized map.
    return {
      runId,
      finalisedAt: this.clock(),
      workflows: named.workflows,
      appPurpose: named.appPurpose,
      appPurposeConfidence: named.appPurposeConfidence,
      duplicateGroups: detected.duplicateGroups,
    };
  }

  /**
   * A valid, well-formed map for an empty / single-node / disconnected graph (no crash, NFR6).
   * `duplicateGroups: []` signals detection ran with nothing to find; `appPurpose` /
   * `appPurposeConfidence` are OMITTED (not-inferred — `exactOptionalPropertyTypes`).
   */
  private emptyMap(runId: string): WorkflowMap {
    return {
      runId,
      finalisedAt: this.clock(),
      workflows: [],
      duplicateGroups: [],
    };
  }
}
