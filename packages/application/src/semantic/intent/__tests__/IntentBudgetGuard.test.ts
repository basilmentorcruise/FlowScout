/**
 * IntentBudgetGuard unit suite — the cost chokepoint (ADR-0006 §3.3 / AC3).
 */
import { describe, it, expect } from "vitest";
import { IntentBudgetGuard } from "../IntentBudgetGuard.js";
import { budget } from "./fixtures.js";

describe("IntentBudgetGuard — call + token accounting", () => {
  it("permits calls until maxLlmCalls is reached", () => {
    const g = new IntentBudgetGuard(budget({ maxLlmCalls: 2, maxTokens: 1_000_000 }));
    expect(g.canCall()).toBe(true);
    g.recordUsage(10, 5);
    expect(g.canCall()).toBe(true);
    g.recordUsage(10, 5);
    expect(g.canCall()).toBe(false); // 2 calls used == maxLlmCalls
    expect(g.callsUsed).toBe(2);
  });

  it("stops calling once maxTokens is reached even with calls remaining", () => {
    const g = new IntentBudgetGuard(budget({ maxLlmCalls: 100, maxTokens: 30 }));
    expect(g.canCall()).toBe(true);
    g.recordUsage(20, 15); // 35 tokens > 30
    expect(g.canCall()).toBe(false);
    expect(g.tokensUsed).toBe(35);
  });

  it("counts a failed call (tokens 0) against maxLlmCalls", () => {
    const g = new IntentBudgetGuard(budget({ maxLlmCalls: 1, maxTokens: 1_000 }));
    g.recordUsage(0, 0); // failed/timed-out call
    expect(g.callsUsed).toBe(1);
    expect(g.tokensUsed).toBe(0);
    expect(g.canCall()).toBe(false);
  });

  it("clamps negative token inputs to zero (defensive)", () => {
    const g = new IntentBudgetGuard(budget({ maxLlmCalls: 10, maxTokens: 1_000 }));
    g.recordUsage(-5, -10);
    expect(g.tokensUsed).toBe(0);
    expect(g.callsUsed).toBe(1);
  });
});
