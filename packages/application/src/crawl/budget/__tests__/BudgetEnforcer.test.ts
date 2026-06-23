/**
 * BudgetEnforcer unit tests — #33 / E2.3.
 *
 * Acceptance criteria covered:
 * AC-1: maxSteps cap — shouldStop returns true at step ceiling → partial.
 * AC-2: maxRevisitsPerState — shouldStop returns true when visitCount exceeds cap.
 * AC-3: maxLlmCalls / maxTokens — shouldStop returns true at each cap.
 * AC-4: Coverage plateau — shouldStop returns true after plateauWindow non-new steps.
 * AC-5: BudgetWarningEvent emitted when warn margin crossed (all budgetType values).
 * AC-6: Mid-step exhaustion leaves no torn state (graceful partial).
 * AC-7: Failed/timed-out LLM calls still count (security T2/T6/T11).
 * AC-8: No magic numbers — config from CrawlBudget.
 *
 * All defaults come from CrawlBudget config — no hardcoded numbers in enforcer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BudgetEnforcer } from "../BudgetEnforcer.js";
import type { BudgetContext } from "../BudgetEnforcer.js";
import type {
  CrawlBudget,
  CrawlEventStream,
  BudgetWarningEvent,
  CrawlEvent,
} from "@flowscout/domain";
import { defaultCrawlBudget } from "@flowscout/domain";

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * A minimal in-process CrawlEventStream that collects published events.
 */
class SpyCrawlEventStream implements CrawlEventStream {
  readonly events: CrawlEvent[] = [];

  async publish(event: CrawlEvent): Promise<void> {
    this.events.push(event);
  }

  subscribe(_runId: string, _handler: (event: CrawlEvent) => void): () => void {
    return () => {
      /* no-op */
    };
  }

  warnings(): BudgetWarningEvent[] {
    return this.events.filter((e): e is BudgetWarningEvent => e.kind === "budget:warning");
  }

  warningsOfType(budgetType: BudgetWarningEvent["budgetType"]): BudgetWarningEvent[] {
    return this.warnings().filter((e) => e.budgetType === budgetType);
  }
}

/** Minimal CrawlBudget for tests (low values for fast execution). */
function testBudget(overrides: Partial<CrawlBudget> = {}): CrawlBudget {
  return {
    maxSteps: 10,
    maxLlmCalls: 5,
    maxTokens: 1000,
    maxRevisitsPerState: 3,
    plateauWindow: 4,
    plateauWarnRatio: 0.75,
    ...overrides,
  };
}

/** Helper: build a BudgetContext with sensible defaults. */
function makeCtx(overrides: Partial<BudgetContext> = {}): BudgetContext {
  return {
    stepCount: 0,
    maxSteps: 10,
    llmCallCount: 0,
    tokenCount: 0,
    currentStateId: "state-A",
    visitCount: 1,
    ...overrides,
  };
}

// ── AC-1: maxSteps cap ────────────────────────────────────────────────────────

describe("BudgetEnforcer — AC-1: maxSteps cap", () => {
  it("shouldStop returns false when stepCount < maxSteps", () => {
    const enforcer = new BudgetEnforcer(testBudget());
    expect(enforcer.shouldStop(makeCtx({ stepCount: 0, maxSteps: 10 }))).toBe(false);
    expect(enforcer.shouldStop(makeCtx({ stepCount: 9, maxSteps: 10 }))).toBe(false);
  });

  it("shouldStop returns true when stepCount === maxSteps", () => {
    const enforcer = new BudgetEnforcer(testBudget());
    expect(enforcer.shouldStop(makeCtx({ stepCount: 10, maxSteps: 10 }))).toBe(true);
  });

  it("shouldStop returns true when stepCount > maxSteps", () => {
    const enforcer = new BudgetEnforcer(testBudget());
    expect(enforcer.shouldStop(makeCtx({ stepCount: 15, maxSteps: 10 }))).toBe(true);
  });

  it("terminationReason is 'step-cap' when maxSteps reached", () => {
    const enforcer = new BudgetEnforcer(testBudget());
    enforcer.shouldStop(makeCtx({ stepCount: 10, maxSteps: 10 }));
    expect(enforcer.getTerminationReason()).toBe("step-cap");
  });
});

// ── AC-2: maxRevisitsPerState cap ─────────────────────────────────────────────

describe("BudgetEnforcer — AC-2: maxRevisitsPerState cap", () => {
  it("shouldStop returns false when visitCount <= maxRevisitsPerState", () => {
    const enforcer = new BudgetEnforcer(testBudget({ maxRevisitsPerState: 3 }));
    expect(enforcer.shouldStop(makeCtx({ visitCount: 1 }))).toBe(false);
    expect(enforcer.shouldStop(makeCtx({ visitCount: 3 }))).toBe(false);
  });

  it("shouldStop returns true when visitCount > maxRevisitsPerState", () => {
    const enforcer = new BudgetEnforcer(testBudget({ maxRevisitsPerState: 3 }));
    expect(enforcer.shouldStop(makeCtx({ visitCount: 4 }))).toBe(true);
  });

  it("terminationReason is 'revisit-cap' when revisit cap reached", () => {
    const enforcer = new BudgetEnforcer(testBudget({ maxRevisitsPerState: 2 }));
    enforcer.shouldStop(makeCtx({ visitCount: 3 }));
    expect(enforcer.getTerminationReason()).toBe("revisit-cap");
  });
});

// ── AC-3: maxLlmCalls / maxTokens caps ───────────────────────────────────────

describe("BudgetEnforcer — AC-3: LLM call and token caps", () => {
  it("shouldStop returns false when llmCallCount < maxLlmCalls", () => {
    const enforcer = new BudgetEnforcer(testBudget({ maxLlmCalls: 5 }));
    expect(enforcer.shouldStop(makeCtx({ llmCallCount: 4 }))).toBe(false);
  });

  it("shouldStop returns true when llmCallCount >= maxLlmCalls", () => {
    const enforcer = new BudgetEnforcer(testBudget({ maxLlmCalls: 5 }));
    expect(enforcer.shouldStop(makeCtx({ llmCallCount: 5 }))).toBe(true);
    expect(enforcer.shouldStop(makeCtx({ llmCallCount: 10 }))).toBe(true);
  });

  it("terminationReason is 'llm-call-cap' when LLM cap reached", () => {
    const enforcer = new BudgetEnforcer(testBudget({ maxLlmCalls: 5 }));
    enforcer.shouldStop(makeCtx({ llmCallCount: 5 }));
    expect(enforcer.getTerminationReason()).toBe("llm-call-cap");
  });

  it("shouldStop returns false when tokenCount < maxTokens", () => {
    const enforcer = new BudgetEnforcer(testBudget({ maxTokens: 1000 }));
    expect(enforcer.shouldStop(makeCtx({ tokenCount: 999 }))).toBe(false);
  });

  it("shouldStop returns true when tokenCount >= maxTokens", () => {
    const enforcer = new BudgetEnforcer(testBudget({ maxTokens: 1000 }));
    expect(enforcer.shouldStop(makeCtx({ tokenCount: 1000 }))).toBe(true);
  });

  it("terminationReason is 'token-cap' when token cap reached", () => {
    const enforcer = new BudgetEnforcer(testBudget({ maxTokens: 1000 }));
    enforcer.shouldStop(makeCtx({ tokenCount: 1000 }));
    expect(enforcer.getTerminationReason()).toBe("token-cap");
  });

  // AC-7: Security — failed/timed-out LLM calls still count (T2/T6/T11).
  // The enforcer checks ctx.llmCallCount — the CALLER counts calls regardless
  // of success/failure. This test verifies the enforcer enforces the cap
  // against reported usage, even when the call "failed" (simulated by a high
  // count the caller accumulated from failed calls).
  it("enforces llmCallCount even when calls were failed/timed-out (T6/T11)", () => {
    const budget = testBudget({ maxLlmCalls: 3 });
    const enforcer = new BudgetEnforcer(budget);
    // Simulate: 3 calls made, all of which failed (caller still increments the count)
    const ctxWithFailedCalls = makeCtx({ llmCallCount: 3 });
    expect(enforcer.shouldStop(ctxWithFailedCalls)).toBe(true);
    expect(enforcer.getTerminationReason()).toBe("llm-call-cap");
  });
});

// ── AC-4: Coverage plateau ────────────────────────────────────────────────────

describe("BudgetEnforcer — AC-4: coverage plateau", () => {
  it("shouldStop returns false before plateau window elapses", () => {
    const enforcer = new BudgetEnforcer(testBudget({ plateauWindow: 4 }));
    const ctx = makeCtx({ visitCount: 2 }); // revisit → not new state

    // 3 non-new steps → counter = 3 < window=4
    for (let i = 0; i < 3; i++) enforcer.recordStep(ctx);
    expect(enforcer.shouldStop(makeCtx())).toBe(false);
  });

  it("shouldStop returns true after plateau window elapses", () => {
    const enforcer = new BudgetEnforcer(testBudget({ plateauWindow: 4 }));
    // Record 4 non-new-state steps to reach the plateau
    const revisitCtx = makeCtx({ visitCount: 2 }); // visitCount > 1 → not new
    for (let i = 0; i < 4; i++) enforcer.recordStep(revisitCtx);

    // Now plateau is reached
    expect(enforcer.shouldStop(makeCtx())).toBe(true);
  });

  it("terminationReason is 'plateau' when plateau is reached", () => {
    const enforcer = new BudgetEnforcer(testBudget({ plateauWindow: 2 }));
    const revisitCtx = makeCtx({ visitCount: 2 });
    enforcer.recordStep(revisitCtx);
    enforcer.recordStep(revisitCtx);
    enforcer.shouldStop(makeCtx());
    expect(enforcer.getTerminationReason()).toBe("plateau");
  });

  it("new state discovered resets plateau counter", () => {
    const enforcer = new BudgetEnforcer(testBudget({ plateauWindow: 3 }));
    const revisitCtx = makeCtx({ visitCount: 2 });
    const newStateCtx = makeCtx({ visitCount: 1 });

    enforcer.recordStep(revisitCtx); // counter = 1
    enforcer.recordStep(revisitCtx); // counter = 2
    enforcer.recordStep(newStateCtx); // new state → counter resets to 0
    enforcer.recordStep(revisitCtx); // counter = 1

    // Plateau window=3 not yet reached after reset
    expect(enforcer.shouldStop(makeCtx())).toBe(false);
  });

  it("visitCount === 1 is treated as new state (resets plateau)", () => {
    const enforcer = new BudgetEnforcer(testBudget({ plateauWindow: 3 }));
    const firstVisitCtx = makeCtx({ visitCount: 1 });
    enforcer.recordStep(firstVisitCtx);
    // Counter should be 0 after a new state
    // 2 more non-new steps → counter = 2 < window=3 → no plateau
    enforcer.recordStep(makeCtx({ visitCount: 2 }));
    enforcer.recordStep(makeCtx({ visitCount: 2 }));
    expect(enforcer.shouldStop(makeCtx())).toBe(false);
  });
});

// ── AC-5: BudgetWarningEvent emission ────────────────────────────────────────

describe("BudgetEnforcer — AC-5: BudgetWarningEvent emission", () => {
  let stream: SpyCrawlEventStream;
  const runId = "run-warn-test";

  beforeEach(() => {
    stream = new SpyCrawlEventStream();
  });

  it("emits steps warning at plateauWarnRatio of maxSteps", async () => {
    const budget = testBudget({ maxSteps: 10, plateauWarnRatio: 0.75 });
    const enforcer = new BudgetEnforcer(budget, stream, runId);

    // At step 8 (>= 75% of 10 = 7.5 → floor = 7), warn is triggered
    // recordStep with stepCount >= warnAt AND < maxSteps
    enforcer.recordStep(makeCtx({ stepCount: 8, maxSteps: 10 }));

    // Allow microtasks to flush (fire-and-forget void publish)
    await Promise.resolve();

    const warnings = stream.warningsOfType("steps");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]).toMatchObject({
      kind: "budget:warning",
      runId,
      budgetType: "steps",
      limit: 10,
    });
  });

  it("emits llm-calls warning at plateauWarnRatio of maxLlmCalls", async () => {
    const budget = testBudget({ maxLlmCalls: 10, plateauWarnRatio: 0.75 });
    const enforcer = new BudgetEnforcer(budget, stream, runId);

    enforcer.recordStep(makeCtx({ llmCallCount: 8 }));
    await Promise.resolve();

    const warnings = stream.warningsOfType("llm-calls");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]).toMatchObject({
      kind: "budget:warning",
      runId,
      budgetType: "llm-calls",
      limit: 10,
    });
  });

  it("emits tokens warning at plateauWarnRatio of maxTokens", async () => {
    const budget = testBudget({ maxTokens: 1000, plateauWarnRatio: 0.75 });
    const enforcer = new BudgetEnforcer(budget, stream, runId);

    enforcer.recordStep(makeCtx({ tokenCount: 800 }));
    await Promise.resolve();

    const warnings = stream.warningsOfType("tokens");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]).toMatchObject({
      kind: "budget:warning",
      runId,
      budgetType: "tokens",
      limit: 1000,
    });
  });

  it("emits revisits warning at plateauWarnRatio of maxRevisitsPerState", async () => {
    const budget = testBudget({ maxRevisitsPerState: 4, plateauWarnRatio: 0.75 });
    const enforcer = new BudgetEnforcer(budget, stream, runId);

    // warnAt = floor(4 * 0.75) = 3; visitCount > 3 AND <= 4
    enforcer.recordStep(makeCtx({ visitCount: 4 }));
    await Promise.resolve();

    const warnings = stream.warningsOfType("revisits");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]).toMatchObject({
      kind: "budget:warning",
      runId,
      budgetType: "revisits",
      limit: 4,
    });
  });

  it("emits plateau warning at plateauWarnRatio of plateauWindow", async () => {
    const budget = testBudget({ plateauWindow: 4, plateauWarnRatio: 0.75 });
    const enforcer = new BudgetEnforcer(budget, stream, runId);

    // warnAt = floor(4 * 0.75) = 3; need stepsSinceNewState >= 3 < 4
    const revisitCtx = makeCtx({ visitCount: 2 });
    enforcer.recordStep(revisitCtx); // stepsSince = 1
    enforcer.recordStep(revisitCtx); // stepsSince = 2
    enforcer.recordStep(revisitCtx); // stepsSince = 3 >= warnAt
    await Promise.resolve();

    const warnings = stream.warningsOfType("plateau");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]).toMatchObject({
      kind: "budget:warning",
      runId,
      budgetType: "plateau",
      limit: 4,
    });
  });

  it("emits each warning type at most once (no event floods)", async () => {
    const budget = testBudget({ maxSteps: 10, plateauWarnRatio: 0.75 });
    const enforcer = new BudgetEnforcer(budget, stream, runId);

    // Call recordStep multiple times at the same warn level
    enforcer.recordStep(makeCtx({ stepCount: 8, maxSteps: 10 }));
    enforcer.recordStep(makeCtx({ stepCount: 9, maxSteps: 10 }));
    enforcer.recordStep(makeCtx({ stepCount: 10, maxSteps: 10 }));
    await Promise.resolve();

    const warnings = stream.warningsOfType("steps");
    // Should emit exactly one "steps" warning despite multiple steps above warn threshold
    expect(warnings.length).toBe(1);
  });

  it("does not emit warning when eventStream is null (no-arg constructor fallback)", () => {
    // The no-arg constructor (fallback stub) must not crash when emitting warnings
    const enforcer = new BudgetEnforcer();
    expect(() => {
      enforcer.recordStep(makeCtx({ stepCount: 400 }));
    }).not.toThrow();
  });

  it("warning event has correct runId", async () => {
    const budget = testBudget({ maxSteps: 10, plateauWarnRatio: 0.75 });
    const customRunId = "run-custom-abc123";
    const enforcer = new BudgetEnforcer(budget, stream, customRunId);

    enforcer.recordStep(makeCtx({ stepCount: 8, maxSteps: 10 }));
    await Promise.resolve();

    const warnings = stream.warnings();
    for (const w of warnings) {
      expect(w.runId).toBe(customRunId);
    }
  });
});

// ── AC-6: Graceful partial finalization (no torn state) ──────────────────────

describe("BudgetEnforcer — AC-6: graceful partial (T6 / NFR6)", () => {
  it("returns correct termination reason after step-cap stop", () => {
    const enforcer = new BudgetEnforcer(testBudget({ maxSteps: 5 }));
    const stopped = enforcer.shouldStop(makeCtx({ stepCount: 5, maxSteps: 5 }));
    expect(stopped).toBe(true);
    expect(enforcer.getTerminationReason()).toBe("step-cap");
  });

  it("returns correct termination reason after plateau stop", () => {
    const enforcer = new BudgetEnforcer(testBudget({ plateauWindow: 2 }));
    enforcer.recordStep(makeCtx({ visitCount: 2 })); // steps=1
    enforcer.recordStep(makeCtx({ visitCount: 2 })); // steps=2 >= window
    const stopped = enforcer.shouldStop(makeCtx());
    expect(stopped).toBe(true);
    expect(enforcer.getTerminationReason()).toBe("plateau");
  });

  it("terminationReason is null before any cap is reached", () => {
    const enforcer = new BudgetEnforcer(testBudget());
    enforcer.shouldStop(makeCtx({ stepCount: 0 }));
    expect(enforcer.getTerminationReason()).toBeNull();
  });

  it("shouldStop is deterministic — calling it multiple times does not alter state", () => {
    const enforcer = new BudgetEnforcer(testBudget({ maxSteps: 5 }));
    const firstCall = enforcer.shouldStop(makeCtx({ stepCount: 5, maxSteps: 5 }));
    const secondCall = enforcer.shouldStop(makeCtx({ stepCount: 5, maxSteps: 5 }));
    expect(firstCall).toBe(true);
    expect(secondCall).toBe(true);
    expect(enforcer.getTerminationReason()).toBe("step-cap");
  });
});

// ── AC-8: No magic numbers — config from CrawlBudget ─────────────────────────

describe("BudgetEnforcer — AC-8: config-driven (no magic numbers)", () => {
  it("respects custom maxSteps from budget config", () => {
    const enforcer = new BudgetEnforcer(testBudget({ maxSteps: 42 }));
    expect(enforcer.shouldStop(makeCtx({ stepCount: 41, maxSteps: 42 }))).toBe(false);
    expect(enforcer.shouldStop(makeCtx({ stepCount: 42, maxSteps: 42 }))).toBe(true);
  });

  it("respects custom maxLlmCalls from budget config", () => {
    const enforcer = new BudgetEnforcer(testBudget({ maxLlmCalls: 7 }));
    expect(enforcer.shouldStop(makeCtx({ llmCallCount: 6 }))).toBe(false);
    expect(enforcer.shouldStop(makeCtx({ llmCallCount: 7 }))).toBe(true);
  });

  it("respects custom maxTokens from budget config", () => {
    const enforcer = new BudgetEnforcer(testBudget({ maxTokens: 500 }));
    expect(enforcer.shouldStop(makeCtx({ tokenCount: 499 }))).toBe(false);
    expect(enforcer.shouldStop(makeCtx({ tokenCount: 500 }))).toBe(true);
  });

  it("respects custom plateauWindow from budget config", () => {
    const enforcer = new BudgetEnforcer(testBudget({ plateauWindow: 6 }));
    const revisitCtx = makeCtx({ visitCount: 2 });
    for (let i = 0; i < 5; i++) enforcer.recordStep(revisitCtx);
    expect(enforcer.shouldStop(makeCtx())).toBe(false);
    enforcer.recordStep(revisitCtx);
    expect(enforcer.shouldStop(makeCtx())).toBe(true);
  });

  it("defaultCrawlBudget() exports correct defaults (ADR-0004 §3.6)", () => {
    const budget = defaultCrawlBudget();
    expect(budget.maxSteps).toBe(400);
    expect(budget.maxLlmCalls).toBe(40);
    expect(budget.maxTokens).toBe(120_000);
    expect(budget.maxRevisitsPerState).toBe(3);
    expect(budget.plateauWindow).toBe(40);
    expect(budget.plateauWarnRatio).toBe(0.75);
  });

  it("no-arg BudgetEnforcer uses defaultCrawlBudget() — does not crash", () => {
    // The no-arg path is the #31 stub fallback: it falls back to defaultCrawlBudget.
    const enforcer = new BudgetEnforcer();
    // maxSteps in ctx < defaultCrawlBudget().maxSteps=400 → should not stop
    expect(enforcer.shouldStop(makeCtx({ stepCount: 0, maxSteps: 5 }))).toBe(false);
  });
});

// ── Integration: full loop simulation ────────────────────────────────────────

describe("BudgetEnforcer — integration: simulated crawl", () => {
  it("stops at maxSteps even when policy keeps returning actions", () => {
    const budget = testBudget({ maxSteps: 3, plateauWindow: 100 });
    const enforcer = new BudgetEnforcer(budget);

    let stepCount = 0;
    const maxSteps = 3;

    // Simulate the loop: shouldStop → act → recordStep → increment
    while (!enforcer.shouldStop(makeCtx({ stepCount, maxSteps }))) {
      enforcer.recordStep(makeCtx({ stepCount, visitCount: 1 }));
      stepCount++;
    }

    expect(stepCount).toBe(maxSteps);
    expect(enforcer.getTerminationReason()).toBe("step-cap");
  });

  it("stops at plateau after plateauWindow steps with no new state", () => {
    const budget = testBudget({ maxSteps: 100, plateauWindow: 3, plateauWarnRatio: 0.75 });
    const enforcer = new BudgetEnforcer(budget);

    // One new state discovered at the start
    enforcer.recordStep(makeCtx({ visitCount: 1 }));

    // Then revisiting the same state
    let steps = 0;
    let stopped = false;
    while (!enforcer.shouldStop(makeCtx({ stepCount: steps + 1, maxSteps: 100 }))) {
      enforcer.recordStep(makeCtx({ visitCount: 2, stepCount: steps + 1 }));
      steps++;
      if (steps > 200) break; // safety guard against infinite loop in test
    }

    expect(enforcer.getTerminationReason()).toBe("plateau");
    // plateauWindow = 3, so exactly 3 non-new steps
    expect(steps).toBe(3);
  });
});
