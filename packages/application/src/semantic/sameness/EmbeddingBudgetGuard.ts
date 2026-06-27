/**
 * EmbeddingBudgetGuard — the SINGLE chokepoint that counts every embedding call/token against the
 * run's `CrawlBudget` (#58, ADR-0005 §5 — the HARD COST CONSTRAINT for the post-hoc embedding pass).
 *
 * Shape-identical to `IntentBudgetGuard` (#55): `canCall` / `recordUsage` / `callsUsed` / `tokensUsed`
 * over the same `CrawlBudget`. Per ADR-0005 §5 the embedding pass folds into the EXISTING
 * `maxLlmCalls` / `maxTokens` ceiling — there is deliberately NO `maxEmbeddingCalls` knob (YAGNI;
 * add only if eval shows embedding volume needs independent bounding).
 *
 * Invariants (tested):
 *   - `canCall()` gates an embedding: true ONLY while `callsUsed < maxLlmCalls` AND
 *     `tokensUsed < maxTokens`. When false, the bucket is embedded a11y-only (no merge).
 *   - `recordUsage(...)` is called after EVERY `EmbeddingPort.embed(...)` attempt — including
 *     degraded/failed calls (which record a call with tokens 0) — so "every embedding call counts"
 *     is a structural fact, not a hope (T3).
 *
 * Pure: no I/O, no SDK, deterministic. Injected with the run's `CrawlBudget`; the composition root
 * (#59) decides the allocation and — per ADR-0005 §5 — will later unify this with `IntentBudgetGuard`
 * into one shared counter so intent/naming/embedding calls all draw on the SAME global ceiling.
 */
import type { CrawlBudget } from "@flowscout/domain";

export class EmbeddingBudgetGuard {
  private _callsUsed = 0;
  private _tokensUsed = 0;

  constructor(private readonly budget: CrawlBudget) {}

  /** Number of embedding calls counted so far (successful + degraded). */
  get callsUsed(): number {
    return this._callsUsed;
  }

  /** Total prompt tokens counted so far. */
  get tokensUsed(): number {
    return this._tokensUsed;
  }

  /**
   * True iff another embedding call is permitted under BOTH levers.
   * The orchestrator MUST consult this before `EmbeddingPort.embed(...)`.
   */
  canCall(): boolean {
    return this._callsUsed < this.budget.maxLlmCalls && this._tokensUsed < this.budget.maxTokens;
  }

  /**
   * Records one embedding call's usage. MUST be invoked after every `embed(...)` attempt — a
   * degraded/failed call passes `0` but still increments the call counter (T3).
   *
   * Negative token inputs are clamped to 0 (defensive — a provider must never reduce usage).
   */
  recordUsage(promptTokens: number): void {
    this._callsUsed += 1;
    this._tokensUsed += Math.max(0, promptTokens);
  }
}
