/**
 * LlmIntentRefiner (tier-2) unit suite — budgeted/cached/abortable LLM path (AC3/AC6).
 *
 * Covers: parse-success ⇒ source=llm + non-null confidence; unparseable ⇒ tier-1 fallback;
 * timeout/throw ⇒ tier-1 fallback (counts a call); budget gating; cache hit ⇒ zero new calls;
 * edgeId allowlist (LLM cannot widen authority); redaction (no secret in prompt).
 */
import { describe, it, expect } from "vitest";
import { LlmIntentRefiner } from "../LlmIntentRefiner.js";
import { IntentBudgetGuard } from "../IntentBudgetGuard.js";
import { InMemoryIntentCache } from "../InMemoryIntentCache.js";
import { FakeLlmPort } from "../../../test-support/FakeLlmPort.js";
import type { ScreenIntent } from "@flowscout/domain";
import { id, budget } from "./fixtures.js";

const TIER1: ScreenIntent = {
  stateId: id("s1"),
  purpose: "Unlabelled screen (2 elements, e.g. button)",
  source: "degraded",
  confidence: null,
  controls: [
    {
      edgeId: "e1",
      actionType: "tap",
      intent: "tap control at position 1",
      affordance: "unknown",
      source: "degraded",
      confidence: null,
    },
    {
      edgeId: "e2",
      actionType: "tap",
      intent: "tap control at position 2",
      affordance: "unknown",
      source: "degraded",
      confidence: null,
    },
  ],
};

function refiner(
  fake: FakeLlmPort,
  b = budget(),
): {
  refiner: LlmIntentRefiner;
  guard: IntentBudgetGuard;
  cache: InMemoryIntentCache;
} {
  const guard = new IntentBudgetGuard(b);
  const cache = new InMemoryIntentCache();
  return { refiner: new LlmIntentRefiner(fake, guard, cache), guard, cache };
}

const VALID_RESPONSE = JSON.stringify({
  purpose: "Sign-in screen",
  controls: [
    { edgeId: "e1", intent: "Submit the sign-in form", affordance: "submit" },
    { edgeId: "e2", intent: "Open password recovery", affordance: "navigation" },
  ],
});

describe("LlmIntentRefiner — parse success", () => {
  it("refines tier-1 to source=llm with non-null confidence", async () => {
    const fake = new FakeLlmPort([
      { kind: "ok", content: VALID_RESPONSE, promptTokens: 50, completionTokens: 10 },
    ]);
    const { refiner: r, guard } = refiner(fake);

    const result = await r.refine(TIER1, "key-1", '{"role":"app"}');

    expect(result.source).toBe("llm");
    expect(result.purpose).toBe("Sign-in screen");
    expect(result.confidence).not.toBeNull();
    expect(result.controls[0]?.intent).toBe("Submit the sign-in form");
    expect(result.controls[0]?.source).toBe("llm");
    expect(guard.callsUsed).toBe(1);
    expect(guard.tokensUsed).toBe(60);
  });

  it("ignores LLM edgeIds not in the tier-1 allowlist (keeps tier-1 for omitted controls)", async () => {
    const rogue = JSON.stringify({
      purpose: "X",
      controls: [{ edgeId: "INJECTED", intent: "do evil", affordance: "submit" }],
    });
    const fake = new FakeLlmPort([{ kind: "ok", content: rogue }]);
    const { refiner: r } = refiner(fake);
    const result = await r.refine(TIER1, "k", "{}");
    // e1/e2 had no match ⇒ both retain tier-1 values; the rogue id is dropped.
    expect(result.controls.map((c) => c.edgeId)).toEqual(["e1", "e2"]);
    expect(result.controls.every((c) => c.source === "degraded")).toBe(true);
  });
});

describe("LlmIntentRefiner — graceful degradation (AC6)", () => {
  it("falls back to tier-1 on unparseable output (still counts the call)", async () => {
    const fake = new FakeLlmPort([{ kind: "ok", content: "not json{{" }]);
    const { refiner: r, guard } = refiner(fake);
    const result = await r.refine(TIER1, "k", "{}");
    expect(result).toEqual(TIER1);
    expect(guard.callsUsed).toBe(1);
  });

  it("falls back to tier-1 on a thrown/timed-out call and records a 0-token call", async () => {
    const fake = new FakeLlmPort([{ kind: "throws", error: new Error("aborted: timeout") }]);
    const { refiner: r, guard } = refiner(fake);
    const result = await r.refine(TIER1, "k", "{}");
    expect(result).toEqual(TIER1);
    expect(guard.callsUsed).toBe(1);
    expect(guard.tokensUsed).toBe(0);
  });

  it("falls back to tier-1 when the schema is structurally invalid", async () => {
    const fake = new FakeLlmPort([
      { kind: "ok", content: JSON.stringify({ purpose: "", controls: [] }) },
    ]);
    const { refiner: r } = refiner(fake);
    expect(await r.refine(TIER1, "k", "{}")).toEqual(TIER1);
  });

  it("falls back when a control entry is not an object", async () => {
    const fake = new FakeLlmPort([
      { kind: "ok", content: JSON.stringify({ purpose: "X", controls: ["nope"] }) },
    ]);
    const { refiner: r } = refiner(fake);
    expect(await r.refine(TIER1, "k", "{}")).toEqual(TIER1);
  });

  it("falls back when a control field has the wrong type", async () => {
    const bad = JSON.stringify({
      purpose: "X",
      controls: [{ edgeId: "e1", intent: 5, affordance: "submit" }],
    });
    const fake = new FakeLlmPort([{ kind: "ok", content: bad }]);
    const { refiner: r } = refiner(fake);
    expect(await r.refine(TIER1, "k", "{}")).toEqual(TIER1);
  });

  it("keeps tier-1 affordance when the LLM blanks the affordance field", async () => {
    const resp = JSON.stringify({
      purpose: "Sign-in",
      controls: [{ edgeId: "e1", intent: "Submit form", affordance: "" }],
    });
    const fake = new FakeLlmPort([{ kind: "ok", content: resp }]);
    const { refiner: r } = refiner(fake);
    const result = await r.refine(TIER1, "k", "{}");
    expect(result.controls[0]?.affordance).toBe("unknown"); // tier-1 value retained
    expect(result.controls[0]?.intent).toBe("Submit form");
    expect(result.controls[0]?.source).toBe("llm");
  });
});

describe("LlmIntentRefiner — budget gating (AC3)", () => {
  it("does not call the LLM when over budget; tier-1 stands", async () => {
    const fake = new FakeLlmPort([{ kind: "ok", content: VALID_RESPONSE }]);
    const { refiner: r } = refiner(fake, budget({ maxLlmCalls: 0 }));
    const result = await r.refine(TIER1, "k", "{}");
    expect(result).toEqual(TIER1);
    expect(fake.callCount).toBe(0);
  });
});

describe("LlmIntentRefiner — cache (AC3 FR6)", () => {
  it("returns the cached intent with zero new LLM call on a key hit", async () => {
    const fake = new FakeLlmPort([{ kind: "ok", content: VALID_RESPONSE }]);
    const { refiner: r } = refiner(fake);

    const first = await r.refine(TIER1, "shared-key", "{}");
    expect(fake.callCount).toBe(1);

    const second = await r.refine(TIER1, "shared-key", "{}");
    expect(fake.callCount).toBe(1); // ZERO new calls
    expect(second).toEqual(first);
  });
});

describe("LlmIntentRefiner — redaction discipline (AC5)", () => {
  it("only sends the skeleton it is handed (caller redacts upstream)", async () => {
    const fake = new FakeLlmPort([{ kind: "ok", content: VALID_RESPONSE }]);
    const { refiner: r } = refiner(fake);
    await r.refine(TIER1, "k", '{"label":"[REDACTED]"}');
    expect(fake.allPromptText).toContain("[REDACTED]");
    expect(fake.allPromptText).toContain("UNTRUSTED OBSERVED DATA");
  });
});
