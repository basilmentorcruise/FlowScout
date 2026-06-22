/**
 * BudgetEnforcer — engine-owned cost/termination controls (#33 / E2.3).
 *
 * Enforces per-run caps in the engine, independent of policy output (T6, ADR-0004 §3.6):
 *   - maxSteps          — total step ceiling.
 *   - maxLlmCalls       — LLM-call ceiling (failed/timed-out calls still count — T2/T6).
 *   - maxTokens         — token spend ceiling (prompt + completion combined).
 *   - maxRevisitsPerState — per-state revisit cap; prevents A→B→A livelock.
 *   - plateauWindow     — no new distinct StateIdentity in N steps → coverage plateau.
 *
 * Emits BudgetWarningEvent as each cap's warn margin is crossed.
 * On exhaustion, signals the loop to finalize `partial` + a reason — no torn state.
 *
 * Security: caps enforced by the ENGINE, not the policy (T6).
 * Failed/timed-out/unparseable LLM calls STILL count toward budget (T2/T6/T11).
 * No magic numbers — all values come from CrawlBudget config (ADR-0001 §6).
 *
 * ADR-0004 §7.2: Wave-1 contract — ONLY the body of this class changes; the
 * public interface (shouldStop / recordStep) and BudgetContext shape do NOT change.
 */
import type { CrawlBudget, CrawlEventStream, BudgetWarningEvent } from "@flowscout/domain";
import { defaultCrawlBudget } from "@flowscout/domain";
import { PlateauDetector } from "./PlateauDetector.js";

/** Context the budget enforcer uses to evaluate caps. */
export interface BudgetContext {
  /** Total steps executed so far (before the current step). */
  readonly stepCount: number;
  /** Maximum steps allowed for this run. */
  readonly maxSteps: number;
  /** Number of LLM calls made so far (0 until #36 wires real usage reporting). */
  readonly llmCallCount: number;
  /** Total tokens consumed so far (0 until #36 wires real usage reporting). */
  readonly tokenCount: number;
  /** The state identity currently being visited. */
  readonly currentStateId: string;
  /** Visit count for the current state in this run (>= 1 after markVisited). */
  readonly visitCount: number;
}

/** Reason why the budget enforcer terminated the run. */
export type TerminationReason =
  | "step-cap"
  | "llm-call-cap"
  | "token-cap"
  | "revisit-cap"
  | "plateau";

/**
 * BudgetEnforcer — enforces per-run caps and emits budget warnings.
 *
 * Instantiate with the full CrawlBudget config + CrawlEventStream + runId so
 * warnings can be published. For the no-arg default (skeleton/test stub) the
 * constructor falls back to defaultCrawlBudget() with a no-op stream and no
 * runId — warnings are silently dropped (safe: the loop is not observing them).
 *
 * DI pattern: the real instance is always injected via CollaboratorOptions.budgetEnforcer
 * with proper config; the no-arg path is the #31 stub fallback only.
 */
export class BudgetEnforcer {
  private readonly budget: CrawlBudget;
  private readonly eventStream: CrawlEventStream | null;
  private readonly runId: string | null;
  private readonly plateau: PlateauDetector;

  /**
   * Tracks which warning types have already been emitted for this run to avoid
   * flooding the stream with repeated warnings for the same cap.
   */
  private readonly warnedBudgetTypes = new Set<string>();

  /** The reason this enforcer stopped the run (null until stopped). */
  private terminationReason: TerminationReason | null = null;

  constructor(
    budget?: CrawlBudget,
    eventStream?: CrawlEventStream | null,
    runId?: string,
  ) {
    this.budget = budget ?? defaultCrawlBudget();
    this.eventStream = eventStream ?? null;
    this.runId = runId ?? null;
    this.plateau = new PlateauDetector(this.budget.plateauWindow);
  }

  /**
   * Returns true if the run should stop (any cap is exhausted or plateau reached).
   * Called by the loop BEFORE executing an action (T6: engine-owned, not policy-owned).
   *
   * Security: caps hold regardless of what the policy returns.
   */
  shouldStop(ctx: BudgetContext): boolean {
    if (ctx.stepCount >= ctx.maxSteps) {
      this.terminationReason = "step-cap";
      return true;
    }
    if (ctx.llmCallCount >= this.budget.maxLlmCalls) {
      this.terminationReason = "llm-call-cap";
      return true;
    }
    if (ctx.tokenCount >= this.budget.maxTokens) {
      this.terminationReason = "token-cap";
      return true;
    }
    if (ctx.visitCount > this.budget.maxRevisitsPerState) {
      this.terminationReason = "revisit-cap";
      return true;
    }
    if (this.plateau.isPlateauReached()) {
      this.terminationReason = "plateau";
      return true;
    }
    return false;
  }

  /**
   * Records one completed step and emits BudgetWarningEvent as caps approach.
   * Called by the loop AFTER an action is executed and step count incremented.
   *
   * Security: failed/timed-out/unparseable LLM calls also cause recordStep to
   * be called (the engine counts them regardless of success — T2/T6/T11).
   */
  recordStep(ctx: BudgetContext): void {
    // Update plateau: visitCount === 1 means this is the first visit (new state).
    const isNewState = ctx.visitCount === 1;
    this.plateau.recordStep(isNewState);

    // Emit warnings for each cap approaching its limit.
    this.maybeWarnSteps(ctx);
    this.maybeWarnLlmCalls(ctx);
    this.maybeWarnTokens(ctx);
    this.maybeWarnRevisits(ctx);
    this.maybeWarnPlateau();
  }

  /** The termination reason set when shouldStop() first returned true. */
  getTerminationReason(): TerminationReason | null {
    return this.terminationReason;
  }

  // ── Private warning helpers ─────────────────────────────────────────────────

  private maybeWarnSteps(ctx: BudgetContext): void {
    const warnAt = Math.floor(ctx.maxSteps * this.budget.plateauWarnRatio);
    if (ctx.stepCount >= warnAt && ctx.stepCount < ctx.maxSteps) {
      this.emitWarning("steps", ctx.stepCount, ctx.maxSteps);
    }
  }

  private maybeWarnLlmCalls(ctx: BudgetContext): void {
    const warnAt = Math.floor(this.budget.maxLlmCalls * this.budget.plateauWarnRatio);
    if (ctx.llmCallCount >= warnAt && ctx.llmCallCount < this.budget.maxLlmCalls) {
      this.emitWarning("llm-calls", ctx.llmCallCount, this.budget.maxLlmCalls);
    }
  }

  private maybeWarnTokens(ctx: BudgetContext): void {
    const warnAt = Math.floor(this.budget.maxTokens * this.budget.plateauWarnRatio);
    if (ctx.tokenCount >= warnAt && ctx.tokenCount < this.budget.maxTokens) {
      this.emitWarning("tokens", ctx.tokenCount, this.budget.maxTokens);
    }
  }

  private maybeWarnRevisits(ctx: BudgetContext): void {
    // visitCount > 1 means it's a revisit; warn when approaching the cap.
    const warnAt = Math.floor(this.budget.maxRevisitsPerState * this.budget.plateauWarnRatio);
    if (ctx.visitCount > warnAt && ctx.visitCount <= this.budget.maxRevisitsPerState) {
      this.emitWarning("revisits", ctx.visitCount, this.budget.maxRevisitsPerState);
    }
  }

  private maybeWarnPlateau(): void {
    const stepsSince = this.plateau.getStepsSinceNewState();
    const warnAt = Math.floor(this.budget.plateauWindow * this.budget.plateauWarnRatio);
    if (stepsSince >= warnAt && stepsSince < this.budget.plateauWindow) {
      this.emitWarning("plateau", stepsSince, this.budget.plateauWindow);
    }
  }

  /**
   * Emits a BudgetWarningEvent at most once per budgetType per run.
   * Deduplication prevents event floods when the same cap is near the limit
   * for multiple consecutive steps.
   */
  private emitWarning(
    budgetType: BudgetWarningEvent["budgetType"],
    used: number,
    limit: number,
  ): void {
    if (this.warnedBudgetTypes.has(budgetType)) return;
    this.warnedBudgetTypes.add(budgetType);

    if (!this.eventStream || !this.runId) return;

    const event: BudgetWarningEvent = {
      kind: "budget:warning",
      runId: this.runId,
      budgetType,
      used,
      limit,
      timestamp: new Date().toISOString(),
    };

    // Fire-and-forget: the budget enforcer is called synchronously inside the
    // loop; we do not await here to keep shouldStop/recordStep synchronous.
    // The event will be published on the next microtask — safe because the
    // loop awaits the next driver call before checking shouldStop again.
    void this.eventStream.publish(event);
  }
}
