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

export class IntentBudgetGuard {
  private _callsUsed = 0;
  private _tokensUsed = 0;

  constructor(private readonly budget: CrawlBudget) {}

  /** Number of LLM calls counted so far (successful + failed). */
  get callsUsed(): number {
    return this._callsUsed;
  }

  /** Total tokens (prompt + completion) counted so far. */
  get tokensUsed(): number {
    return this._tokensUsed;
  }

  /**
   * True iff another LLM call is permitted under BOTH levers.
   * Tier-2 MUST consult this before `LlmPort.complete(...)`.
   */
  canCall(): boolean {
    return this._callsUsed < this.budget.maxLlmCalls && this._tokensUsed < this.budget.maxTokens;
  }

  /**
   * Records one LLM call's usage. MUST be invoked after every `complete(...)` attempt —
   * a failed/timed-out call passes `(0, 0)` but still increments the call counter.
   *
   * Negative token inputs are clamped to 0 (defensive — a provider must never reduce usage).
   */
  recordUsage(promptTokens: number, completionTokens: number): void {
    this._callsUsed += 1;
    this._tokensUsed += Math.max(0, promptTokens) + Math.max(0, completionTokens);
  }
}
