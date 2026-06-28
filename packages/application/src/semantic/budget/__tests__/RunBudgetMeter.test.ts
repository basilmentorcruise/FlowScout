/**
 * RunBudgetMeter + the additive shared-meter guard ctors (#59 §4).
 *
 * Verifies the single shared counter and that BOTH guards (`IntentBudgetGuard`,
 * `EmbeddingBudgetGuard`) delegate to it when handed a `RunBudgetMeter`, while the existing
 * `CrawlBudget` ctor path keeps its self-meter (back-compat, additive-only).
 */
import { describe, it, expect } from "vitest";
import type { CrawlBudget } from "@flowscout/domain";
import { RunBudgetMeter } from "../RunBudgetMeter.js";
import { IntentBudgetGuard } from "../../intent/IntentBudgetGuard.js";
import { EmbeddingBudgetGuard } from "../../sameness/EmbeddingBudgetGuard.js";

function budget(overrides: Partial<CrawlBudget> = {}): CrawlBudget {
  return {
    maxSteps: 100,
    maxLlmCalls: 3,
    maxTokens: 1_000,
    maxRevisitsPerState: 3,
    plateauWindow: 40,
    plateauWarnRatio: 0.75,
    ...overrides,
  };
}

describe("RunBudgetMeter", () => {
  it("counts calls + tokens and gates on BOTH levers", () => {
    const meter = new RunBudgetMeter(budget({ maxLlmCalls: 2, maxTokens: 1_000 }));
    expect(meter.canCall()).toBe(true);
    meter.recordUsage(100, 20);
    expect(meter.callsUsed).toBe(1);
    expect(meter.tokensUsed).toBe(120);
    expect(meter.canCall()).toBe(true);
    meter.recordUsage(10);
    expect(meter.callsUsed).toBe(2);
    expect(meter.canCall()).toBe(false); // calls lever bites
  });

  it("the tokens lever bites independently of the calls lever", () => {
    const meter = new RunBudgetMeter(budget({ maxLlmCalls: 99, maxTokens: 50 }));
    meter.recordUsage(60);
    expect(meter.canCall()).toBe(false);
  });

  it("clamps negative token inputs to 0 and counts every attempt", () => {
    const meter = new RunBudgetMeter(budget());
    meter.recordUsage(-5, -10);
    expect(meter.callsUsed).toBe(1);
    expect(meter.tokensUsed).toBe(0);
  });

  it("reset() clears the per-run counters", () => {
    const meter = new RunBudgetMeter(budget({ maxLlmCalls: 1 }));
    meter.recordUsage(100, 20);
    expect(meter.canCall()).toBe(false);
    meter.reset();
    expect(meter.callsUsed).toBe(0);
    expect(meter.tokensUsed).toBe(0);
    expect(meter.canCall()).toBe(true);
  });
});

describe("shared-meter guard ctors (additive)", () => {
  it("IntentBudgetGuard + EmbeddingBudgetGuard delegate to ONE shared meter", () => {
    const meter = new RunBudgetMeter(budget({ maxLlmCalls: 2, maxTokens: 1_000 }));
    const intentGuard = new IntentBudgetGuard(meter);
    const embeddingGuard = new EmbeddingBudgetGuard(meter);

    intentGuard.recordUsage(100, 20); // 1 call on the shared meter
    expect(meter.callsUsed).toBe(1);
    expect(embeddingGuard.callsUsed).toBe(1); // sees the intent spend (same counter)
    expect(embeddingGuard.canCall()).toBe(true);

    embeddingGuard.recordUsage(10); // 2nd shared call
    expect(meter.callsUsed).toBe(2);
    expect(intentGuard.canCall()).toBe(false); // shared cap reached for BOTH
    expect(embeddingGuard.canCall()).toBe(false);
  });

  it("the CrawlBudget ctor path keeps a PRIVATE self-meter (back-compat)", () => {
    const shared = budget({ maxLlmCalls: 5 });
    const a = new IntentBudgetGuard(shared);
    const b = new EmbeddingBudgetGuard(shared);
    a.recordUsage(100, 20);
    expect(a.callsUsed).toBe(1);
    expect(b.callsUsed).toBe(0); // independent counters — no cross-talk via the budget object
  });
});
