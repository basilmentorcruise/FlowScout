/**
 * RunBudgetMeter — the SINGLE shared cross-pass cost counter for `BuildWorkflowMap` (#59, E3.6 §4).
 *
 * The three async semantic passes spend against the run's `CrawlBudget`:
 *   - intent tier-2 (#55, via `IntentBudgetGuard`),
 *   - naming / app-purpose (#56, also via `IntentBudgetGuard`),
 *   - the post-hoc embedding pass (#58, via `EmbeddingBudgetGuard`).
 *
 * Before #59 each guard kept its OWN call/token counters, so total spend was NOT globally bounded
 * (each pass could independently spend up to `maxLlmCalls` / `maxTokens`). `RunBudgetMeter` is the
 * single source of truth both guards DELEGATE to (their additive ctor overload), so the COMBINED
 * LLM + embedding spend across the whole `BuildWorkflowMap` run is bounded by ONE
 * `maxLlmCalls` / `maxTokens` ceiling (E3.6 §6 / AC5).
 *
 * `reset()` is called once per `BuildWorkflowMap.execute()` (step 0) so the engine can be wired
 * once and the per-run counter reset, mirroring E2's wire-once `StartCrawlRun` precedent (R-2).
 *
 * Pure: no I/O, no SDK, deterministic. Shape mirrors the guards (`canCall` / `recordUsage` /
 * `callsUsed` / `tokensUsed`) so delegation is a trivial pass-through.
 */
import type { CrawlBudget } from "@flowscout/domain";

export class RunBudgetMeter {
  private _callsUsed = 0;
  private _tokensUsed = 0;

  constructor(private readonly budget: CrawlBudget) {}

  /** Number of calls counted so far across ALL passes (successful + failed/degraded). */
  get callsUsed(): number {
    return this._callsUsed;
  }

  /** Total tokens (prompt + completion) counted so far across ALL passes. */
  get tokensUsed(): number {
    return this._tokensUsed;
  }

  /**
   * True iff another call is permitted under BOTH levers — consulted by every pass before any
   * `LlmPort.complete(...)` / `EmbeddingPort.embed(...)`.
   */
  canCall(): boolean {
    return this._callsUsed < this.budget.maxLlmCalls && this._tokensUsed < this.budget.maxTokens;
  }

  /**
   * Records one call's usage. MUST be invoked after EVERY attempt — a failed/timed-out/degraded
   * call passes `0` tokens but still increments the call counter (T3). Negative token inputs are
   * clamped to 0 (defensive — a provider must never reduce usage).
   */
  recordUsage(promptTokens: number, completionTokens = 0): void {
    this._callsUsed += 1;
    this._tokensUsed += Math.max(0, promptTokens) + Math.max(0, completionTokens);
  }

  /** Reset the per-run counters. Called once per `BuildWorkflowMap.execute()` (step 0). */
  reset(): void {
    this._callsUsed = 0;
    this._tokensUsed = 0;
  }
}
