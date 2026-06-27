/**
 * SemanticDuplicateDetector — the pure, sync, deterministic duplicate / hidden-path detector
 * (#58, ADR-0005 §4.4 — the epic success-metric DIFFERENTIATOR).
 *
 * The SEMANTIC complement to E2's STRUCTURAL `DuplicatePathDetector` (same-raw-id convergence).
 * #58 scopes itself to the CROSS-identity case E2 misses: ≥2 workflows reach the SAME CANONICAL
 * outcome via DISTINCT raw state identities (the refiner merged those raw outcomes). It flags the
 * less-prominent route `isHiddenPath = true` and emits an expressible `DuplicatePathGroup`.
 *
 * PRECISION OVER RECALL (governing bias). The detector introduces NO new merging — it only READS the
 * refiner's (already precision-biased) canonical map. A false duplicate can only originate from a
 * false MERGE upstream, which ADR-0005 already biases against (0.94 gate, dead-band → distinct,
 * merge-only, label veto). The detector then adds a SECOND precision gate at flag time:
 *
 *   - CROSS-identity scoping: pure same-raw-id convergence (all raw outcome ids identical) stays
 *     E2's structural case (`duplicatePathNodeIds`) and is NOT flagged here — no double-flagging, and
 *     a similar-but-distinct pair (refiner kept them distinct → different canonical ids) is never
 *     even grouped (the precision floor — AC2).
 *   - OUTCOME-INTENT confirmation (`confirmWithIntent`): a candidate set is SUPPRESSED if the
 *     converging outcomes' `ScreenIntent` (source `llm`) purposes CONFIDENTLY CONFLICT. This is the
 *     class-level check at flag time that catches the transitive label-veto bypass the refiner's
 *     pairwise veto can miss (A–C–B co-classing — AC3) — handled WITHOUT editing the #57 refiner.
 *
 * Pure: no I/O, no SDK, no randomness. Never mutates inputs (returns `Workflow` COPIES).
 */
import type { Workflow, IntentModel, StateIdentity, CanonicalIdentityMap } from "@flowscout/domain";
import type { DuplicatePathGroup } from "@flowscout/domain";
import type { DuplicateDetectorConfig } from "./DuplicateDetectorConfig.js";

/** A semantic-duplicate set needs ≥2 workflows reaching ≥2 DISTINCT raw outcome identities. */
const MIN_GROUP_SIZE = 2;

/** The detection result: mutated-copy workflows + the expressible duplicate-group associations. */
export interface DuplicateDetectionResult {
  /** Workflow COPIES with `isHiddenPath` set on the less-prominent routes (immutability). */
  readonly workflows: readonly Workflow[];
  /** One `DuplicatePathGroup` per qualifying cross-identity convergence set. */
  readonly duplicateGroups: readonly DuplicatePathGroup[];
}

/** Internal: a workflow paired with its raw + canonical outcome identity. */
interface OutcomeRow {
  readonly workflow: Workflow;
  readonly rawOutcome: StateIdentity;
  readonly canonicalOutcome: StateIdentity;
}

export class SemanticDuplicateDetector {
  constructor(private readonly config: DuplicateDetectorConfig) {}

  /**
   * Detect semantic-duplicate / hidden-path sets.
   *
   * @param workflows    extracted workflows (#54) — read-only; never mutated.
   * @param canonicalMap the refined identity map (`RefineIdentities` / #57).
   * @param intent       optional intent overlay (#55) — the flag-time confirmation gate.
   */
  detect(
    workflows: readonly Workflow[],
    canonicalMap: CanonicalIdentityMap,
    intent?: IntentModel,
  ): DuplicateDetectionResult {
    const purposeByState = this.buildLlmPurposeMap(intent);

    // 1–2. Resolve each workflow's outcome identity and GROUP by canonical outcome.
    const groupsByCanonical = new Map<StateIdentity, OutcomeRow[]>();
    for (const workflow of workflows) {
      const rawOutcome = this.outcomeIdentity(workflow);
      if (rawOutcome === null) continue; // a stepless workflow has no outcome
      const canonicalOutcome = canonicalMap.get(rawOutcome) ?? rawOutcome;
      const row: OutcomeRow = { workflow, rawOutcome, canonicalOutcome };
      const list = groupsByCanonical.get(canonicalOutcome);
      if (list) list.push(row);
      else groupsByCanonical.set(canonicalOutcome, [row]);
    }

    const duplicateGroups: DuplicatePathGroup[] = [];
    const hiddenIds = new Set<string>();

    // Deterministic group iteration order (by canonical outcome id).
    const canonicalOutcomes = [...groupsByCanonical.keys()].sort((a, b) =>
      (a as string) < (b as string) ? -1 : 1,
    );

    for (const canonicalOutcome of canonicalOutcomes) {
      const rows = groupsByCanonical.get(canonicalOutcome) as OutcomeRow[];
      const group = this.evaluateGroup(canonicalOutcome, rows, purposeByState);
      if (group === null) continue;
      duplicateGroups.push(group);
      for (const hidden of group.hiddenWorkflowIds) hiddenIds.add(hidden);
    }

    // Return COPIES — flag the hidden routes, never mutate the inputs (immutability).
    const out: Workflow[] = workflows.map((w) =>
      hiddenIds.has(w.id) ? { ...w, isHiddenPath: true } : w,
    );

    return { workflows: out, duplicateGroups };
  }

  // ── Group evaluation ───────────────────────────────────────────────────────

  /** Evaluate one canonical-outcome group; return a `DuplicatePathGroup` or null if not a duplicate. */
  private evaluateGroup(
    canonicalOutcome: StateIdentity,
    rows: readonly OutcomeRow[],
    purposeByState: ReadonlyMap<StateIdentity, string>,
  ): DuplicatePathGroup | null {
    // 3. A semantic-duplicate set needs ≥2 workflows AND ≥1 CROSS-identity merge (raw outcome ids
    //    not all identical). Pure same-raw-id convergence is E2's structural case — left to E2.
    if (rows.length < MIN_GROUP_SIZE) return null;
    const distinctRawOutcomes = new Set(rows.map((r) => r.rawOutcome as string));
    if (distinctRawOutcomes.size < MIN_GROUP_SIZE) return null;

    // 4. Precision-confirmation gate: suppress if confident (llm) outcome purposes conflict (AC3).
    if (this.config.confirmWithIntent && this.outcomePurposesConflict(rows, purposeByState)) {
      return null;
    }

    // 5. Prominence: most direct route (fewest steps) wins; lexicographic id tie-break.
    const sorted = [...rows].sort((a, b) => {
      const bySteps = a.workflow.steps.length - b.workflow.steps.length;
      if (bySteps !== 0) return bySteps;
      return a.workflow.id < b.workflow.id ? -1 : a.workflow.id > b.workflow.id ? 1 : 0;
    });
    const canonicalWorkflowId = (sorted[0] as OutcomeRow).workflow.id;
    const hiddenWorkflowIds = sorted
      .slice(1)
      .map((r) => r.workflow.id)
      .sort();
    const workflowIds = rows.map((r) => r.workflow.id).sort();

    return {
      outcomeIdentity: canonicalOutcome,
      workflowIds,
      canonicalWorkflowId,
      hiddenWorkflowIds,
    };
  }

  /**
   * True iff two DISTINCT raw outcomes in the set carry CONFIDENT (llm) purposes that disagree.
   * This is the class-level conflict check (catches the transitive A–C–B veto bypass). Absent /
   * degraded / agreeing purposes never conflict (precision wins only on a real disagreement).
   */
  private outcomePurposesConflict(
    rows: readonly OutcomeRow[],
    purposeByState: ReadonlyMap<StateIdentity, string>,
  ): boolean {
    const purposes = new Set<string>();
    for (const rawOutcome of new Set(rows.map((r) => r.rawOutcome))) {
      const purpose = purposeByState.get(rawOutcome);
      if (purpose !== undefined) purposes.add(purpose);
    }
    return purposes.size > 1;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** The outcome identity of a workflow = the raw `stateId` of its terminal step (or null). */
  private outcomeIdentity(workflow: Workflow): StateIdentity | null {
    if (workflow.steps.length === 0) return null;
    const terminal = workflow.steps[workflow.steps.length - 1];
    return terminal ? terminal.stateId : null;
  }

  /** Confident (llm) outcome purposes keyed by state identity, normalized for comparison. */
  private buildLlmPurposeMap(intent?: IntentModel): ReadonlyMap<StateIdentity, string> {
    const map = new Map<StateIdentity, string>();
    if (intent === undefined) return map;
    for (const screen of intent.screens) {
      if (screen.source === "llm" && screen.purpose.length > 0) {
        map.set(screen.stateId, normalizePurpose(screen.purpose));
      }
    }
    return map;
  }
}

/** Normalize a purpose for the conflict comparison: trim + lowercase + collapse whitespace. */
function normalizePurpose(purpose: string): string {
  return purpose.replace(/\s+/g, " ").trim().toLowerCase();
}
