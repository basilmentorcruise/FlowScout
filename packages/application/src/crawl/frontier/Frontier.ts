/**
 * Frontier — stub implementation for #31 (walking skeleton).
 *
 * This file is OWNED BY #34 (E2.4). #31 ships a minimal stub so the loop
 * compiles and the walking skeleton runs with naive "all actions tried in
 * the order the policy provides them" tracking.
 *
 * #34 replaces the body of this class with full frontier/visited tracking,
 * backtrack handling, and loop detection — without editing the loop shell
 * or collaborators.ts.
 *
 * Frozen seam contract (Wave-1 MUST NOT change the interface):
 *   interface Frontier {
 *     getVisitCount(stateId: string): number;
 *     markVisited(stateId: string): void;
 *     getTriedActions(stateId: string): readonly CandidateAction[];
 *     markActionTried(stateId: string, action: CandidateAction): void;
 *   }
 *
 * Extension point for #35 (E2.5 hidden-affordance probes):
 *   registerProbeSource(source: ProbeSource): void
 * #34 must expose this API; #35 calls it. Do not add it here (#31 stub).
 */
import type { CandidateAction } from "@flowscout/domain";

/**
 * Frontier — tracks visited states and tried actions.
 * #31 stub: in-memory tracking with no backtrack logic (filled by #34).
 */
export class Frontier {
  private readonly visitCounts = new Map<string, number>();
  private readonly triedActions = new Map<string, CandidateAction[]>();

  /**
   * Returns how many times this state has been visited in the current run.
   */
  getVisitCount(stateId: string): number {
    return this.visitCounts.get(stateId) ?? 0;
  }

  /**
   * Records a visit to a state.
   */
  markVisited(stateId: string): void {
    const prev = this.visitCounts.get(stateId) ?? 0;
    this.visitCounts.set(stateId, prev + 1);
  }

  /**
   * Returns the list of actions already tried from this state.
   */
  getTriedActions(stateId: string): readonly CandidateAction[] {
    return this.triedActions.get(stateId) ?? [];
  }

  /**
   * Marks an action as tried from a state.
   */
  markActionTried(stateId: string, action: CandidateAction): void {
    const existing = this.triedActions.get(stateId) ?? [];
    this.triedActions.set(stateId, [...existing, action]);
  }
}
