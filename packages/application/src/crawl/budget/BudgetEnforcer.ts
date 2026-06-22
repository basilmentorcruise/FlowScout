/**
 * BudgetEnforcer — stub implementation for #31 (walking skeleton).
 *
 * This file is OWNED BY #33 (E2.3). #31 ships a minimal stub so the loop
 * compiles and the walking skeleton runs against the maxSteps ceiling.
 *
 * #33 replaces the body of this class with the full enforcement logic
 * (plateau detection, LLM-call cap, token cap, revisit cap, BudgetWarningEvent
 * emission) per ADR-0004 §3.6 and PRD-e2 FR4 — without editing the loop shell
 * or collaborators.ts.
 *
 * Frozen seam contract (Wave-1 MUST NOT change the interface):
 *   interface BudgetEnforcer {
 *     shouldStop(ctx: BudgetContext): boolean;
 *     recordStep(ctx: BudgetContext): void;
 *   }
 */

/** Context the budget enforcer uses to evaluate caps. */
export interface BudgetContext {
  /** Total steps executed so far (before the current step). */
  readonly stepCount: number;
  /** Maximum steps allowed for this run. */
  readonly maxSteps: number;
  /** Number of LLM calls made so far. */
  readonly llmCallCount: number;
  /** Total tokens consumed so far (prompt + completion). */
  readonly tokenCount: number;
  /** The state identity currently being visited. */
  readonly currentStateId: string;
  /** Visit count for the current state in this run. */
  readonly visitCount: number;
}

/**
 * BudgetEnforcer — enforces per-run caps.
 * #31 stub: only enforces maxSteps; all other caps are no-ops (filled by #33).
 */
export class BudgetEnforcer {
  /**
   * Returns true if the run should stop (any cap is exhausted).
   * Stub: only checks maxSteps.
   */
  shouldStop(ctx: BudgetContext): boolean {
    return ctx.stepCount >= ctx.maxSteps;
  }

  /**
   * Called after each step to record usage.
   * Stub: no-op — #33 fills in plateau/warning logic.
   */
  recordStep(_ctx: BudgetContext): void {
    // TODO(#33): plateau detection, BudgetWarningEvent emission
  }
}
