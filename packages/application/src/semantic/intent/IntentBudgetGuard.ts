/**
 * IntentBudgetGuard — the SINGLE chokepoint that counts every tier-2 LLM call/token against
 * the run's `CrawlBudget` (#55, ADR-0006 §3.3 — the HARD COST CONSTRAINT, encoded).
 *
 * Invariants (tested):
 *   - `canCall()` gates tier-2: true ONLY while `callsUsed < maxLlmCalls` AND
 *     `tokensUsed < maxTokens`. When false, tier-2 is skipped and the tier-1 result stands.
 *   - `recordUsage(...)` is called after EVERY `LlmPort.complete(...)` attempt — including
 *     failures/timeouts (which record a call with tokens 0), exactly as `LLMPolicy` reports
 *     failed-call usage. This makes "every LLM call counts" a structural fact, not a hope.
 *
 * Pure: no I/O, no SDK, deterministic. Injected with the run's `CrawlBudget`; #55 honours the
 * budget it is handed (the composition root, #59, decides the allocation).
 */
import type { CrawlBudget } from "@flowscout/domain";
import { RunBudgetMeter } from "../budget/RunBudgetMeter.js";

export class IntentBudgetGuard {
  /**
   * The counter this guard delegates to (#59 §4). A `CrawlBudget` self-constructs a PRIVATE meter
   * (the existing, back-compat path — every pre-#59 guard/refiner test is untouched). A shared
   * `RunBudgetMeter` is used DIRECTLY (the #59 path — intent/naming/embedding draw on ONE ceiling).
   */
  private readonly meter: RunBudgetMeter;

  constructor(budgetOrMeter: CrawlBudget | RunBudgetMeter) {
    this.meter =
      budgetOrMeter instanceof RunBudgetMeter ? budgetOrMeter : new RunBudgetMeter(budgetOrMeter);
  }

  /** Number of LLM calls counted so far (successful + failed). */
  get callsUsed(): number {
    return this.meter.callsUsed;
  }

  /** Total tokens (prompt + completion) counted so far. */
  get tokensUsed(): number {
    return this.meter.tokensUsed;
  }

  /**
   * True iff another LLM call is permitted under BOTH levers.
   * Tier-2 MUST consult this before `LlmPort.complete(...)`.
   */
  canCall(): boolean {
    return this.meter.canCall();
  }

  /**
   * Records one LLM call's usage. MUST be invoked after every `complete(...)` attempt —
   * a failed/timed-out call passes `(0, 0)` but still increments the call counter.
   *
   * Negative token inputs are clamped to 0 (defensive — a provider must never reduce usage).
   */
  recordUsage(promptTokens: number, completionTokens: number): void {
    this.meter.recordUsage(promptTokens, completionTokens);
  }
}
