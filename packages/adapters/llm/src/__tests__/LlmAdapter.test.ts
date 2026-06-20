/**
 * LlmAdapter + LlmDecisionPolicy stub tests.
 * Verifies that all methods reject with "not yet implemented" until E2/E3 lands.
 */
import { describe, it, expect } from "vitest";
import { LlmAdapter, LlmDecisionPolicy } from "../LlmAdapter.js";
import type { A11ySnapshot, StateIdentity } from "@flowscout/domain";

describe("LlmAdapter (stub)", () => {
  const adapter = new LlmAdapter();

  it("complete rejects with not-implemented error", async () => {
    await expect(
      adapter.complete([{ role: "user", content: "hello" }], { maxTokens: 100 }),
    ).rejects.toThrow("not yet implemented");
  });
});

describe("LlmDecisionPolicy (stub)", () => {
  const policy = new LlmDecisionPolicy(new LlmAdapter());

  it("decide rejects with not-implemented error", async () => {
    const ctx = {
      runId: "run-1",
      currentStateId: "state-1" as StateIdentity,
      a11ySnapshot: '{"role":"application"}' as A11ySnapshot,
      triedActions: [],
      visitCount: 0,
    };
    await expect(policy.decide(ctx)).rejects.toThrow("not yet implemented");
  });
});
