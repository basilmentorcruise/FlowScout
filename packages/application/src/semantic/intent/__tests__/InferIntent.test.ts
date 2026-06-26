/**
 * InferIntent integration suite — the two-tier orchestrator end-to-end with fakes (AC1–AC7).
 *
 * Wires the REAL CredentialRedactor + A11yIntentDeriver + LlmIntentRefiner over a FakeLlmPort,
 * an InMemoryIntentCache, and an IntentBudgetGuard. Asserts: tier-1-only path makes ZERO calls;
 * redaction before every sink; budget never exceeded; cache makes repeat screens free; well-formed
 * model on empty/single-node graphs; degraded screens refined to source=llm.
 */
import { describe, it, expect } from "vitest";
import { InferIntent, defaultInferIntentConfig } from "../InferIntent.js";
import { A11yIntentDeriver } from "../A11yIntentDeriver.js";
import { LlmIntentRefiner } from "../LlmIntentRefiner.js";
import { IntentBudgetGuard } from "../IntentBudgetGuard.js";
import { InMemoryIntentCache } from "../InMemoryIntentCache.js";
import { CredentialRedactor } from "../../../crawl/redaction/CredentialRedactor.js";
import { FakeLlmPort } from "../../../test-support/FakeLlmPort.js";
import type { InferIntentConfig } from "../InferIntent.js";
import type { CrawlBudget } from "@flowscout/domain";
import {
  node,
  edge,
  id,
  graph,
  budget,
  SIGN_IN_SNAPSHOT,
  UNLABELLED_SNAPSHOT,
  SECRET_SNAPSHOT,
} from "./fixtures.js";

function buildInfer(
  fake: FakeLlmPort,
  config: InferIntentConfig,
  b: CrawlBudget = budget(),
): { infer: InferIntent; cache: InMemoryIntentCache; guard: IntentBudgetGuard } {
  const guard = new IntentBudgetGuard(b);
  const cache = new InMemoryIntentCache();
  const refiner = new LlmIntentRefiner(fake, guard, cache);
  const infer = new InferIntent(new CredentialRedactor(), new A11yIntentDeriver(), refiner, config);
  return { infer, cache, guard };
}

describe("InferIntent — tier-1 only (AC1: no LLM call)", () => {
  it("produces structured intent with zero LLM calls when refinement is disabled", async () => {
    const fake = new FakeLlmPort();
    const { infer } = buildInfer(fake, { refinementEnabled: false, refineOnlyWeak: false });
    const g = graph(
      [node({ id: id("s1"), label: "Sign In", a11ySnapshot: SIGN_IN_SNAPSHOT })],
      [edge({ fromId: id("s1"), toId: id("s2"), actionType: "tap", actionPayload: "Log In" })],
    );

    const model = await infer.execute(g);

    expect(fake.callCount).toBe(0);
    expect(model.runId).toBe("run-1");
    expect(model.screens).toHaveLength(1);
    const screen = model.screens[0];
    expect(screen?.source).toBe("a11y");
    expect(screen?.confidence).toBeNull();
    expect(screen?.controls[0]?.affordance).toBe("submit");
  });

  it("does NOT refine a strong (fully a11y) screen even when refinement is enabled", async () => {
    const fake = new FakeLlmPort();
    const { infer } = buildInfer(fake, defaultInferIntentConfig());
    const g = graph(
      [node({ id: id("s1"), label: "Sign In", a11ySnapshot: SIGN_IN_SNAPSHOT })],
      [edge({ fromId: id("s1"), toId: id("s2"), actionType: "tap", actionPayload: "Log In" })],
    );
    await infer.execute(g);
    expect(fake.callCount).toBe(0); // strong tier-1 ⇒ refineOnlyWeak skips it
  });
});

describe("InferIntent — well-formed model on empty / single-node graphs (AC7)", () => {
  it("returns an empty-but-present model for an empty graph", async () => {
    const fake = new FakeLlmPort();
    const { infer } = buildInfer(fake, defaultInferIntentConfig());
    const model = await infer.execute(graph([], []));
    expect(model.screens).toEqual([]);
    expect(model.runId).toBe("run-1");
  });

  it("returns a single screen with empty controls for a single node with no edges", async () => {
    const fake = new FakeLlmPort();
    const { infer } = buildInfer(fake, { refinementEnabled: false, refineOnlyWeak: false });
    const g = graph([node({ id: id("only"), label: "Home", a11ySnapshot: "{}" })], []);
    const model = await infer.execute(g);
    expect(model.screens).toHaveLength(1);
    expect(model.screens[0]?.controls).toEqual([]);
    expect(model.screens[0]?.purpose).toBe("Home screen");
  });
});

describe("InferIntent — redaction before every sink (AC5)", () => {
  it("never leaks a secret into the prompt or the stored intent", async () => {
    const refined = JSON.stringify({ purpose: "Login", controls: [] });
    const fake = new FakeLlmPort([{ kind: "ok", content: refined }]);
    const { infer } = buildInfer(fake, { refinementEnabled: true, refineOnlyWeak: false });
    const g = graph(
      [node({ id: id("s1"), label: "Login", a11ySnapshot: SECRET_SNAPSHOT })],
      [edge({ fromId: id("s1"), toId: id("s2"), actionType: "typeText", actionPayload: "482913" })],
    );

    const model = await infer.execute(g);

    // No secret in the prompt sent to the LLM.
    expect(fake.allPromptText).not.toContain("hunter2-SECRET");
    expect(fake.allPromptText).not.toContain("482913");
    // No secret in the produced model.
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain("hunter2-SECRET");
    expect(serialized).not.toContain("482913");
  });
});

describe("InferIntent — budget never exceeded across screens (AC3)", () => {
  it("caps LLM calls at maxLlmCalls and lets tier-1 stand for the rest", async () => {
    // 4 distinct degraded screens, but only 2 LLM calls allowed.
    const ok = JSON.stringify({ purpose: "Refined", controls: [] });
    const fake = new FakeLlmPort(
      Array.from({ length: 10 }, () => ({ kind: "ok" as const, content: ok })),
    );
    const { infer, guard } = buildInfer(
      fake,
      { refinementEnabled: true, refineOnlyWeak: false },
      budget({ maxLlmCalls: 2, maxTokens: 1_000_000 }),
    );
    const nodes = ["a", "b", "c", "d"].map((s) =>
      node({ id: id(s), label: "", a11ySnapshot: JSON.stringify({ role: "button", id: s }) }),
    );
    const model = await infer.execute(graph(nodes, []));

    expect(fake.callCount).toBeLessThanOrEqual(2);
    expect(guard.callsUsed).toBeLessThanOrEqual(2);
    const refinedCount = model.screens.filter((s) => s.source === "llm").length;
    expect(refinedCount).toBe(2); // exactly the budget; the rest are tier-1
    expect(model.screens).toHaveLength(4);
  });
});

describe("InferIntent — cache makes repeat screens free (AC3 FR6)", () => {
  it("makes ZERO new LLM calls on a second run of the same graph", async () => {
    const ok = JSON.stringify({ purpose: "Refined", controls: [] });
    const fake = new FakeLlmPort([
      { kind: "ok", content: ok },
      { kind: "ok", content: ok },
    ]);
    const { infer } = buildInfer(fake, { refinementEnabled: true, refineOnlyWeak: false });
    const g = graph([node({ id: id("s1"), label: "", a11ySnapshot: UNLABELLED_SNAPSHOT })], []);

    await infer.execute(g);
    const afterFirst = fake.callCount;
    expect(afterFirst).toBe(1);

    await infer.execute(g); // same redacted skeleton ⇒ cache hit
    expect(fake.callCount).toBe(afterFirst); // ZERO new calls
  });

  it("two distinct screens with identical redacted skeletons share one inference", async () => {
    const ok = JSON.stringify({ purpose: "Refined", controls: [] });
    const fake = new FakeLlmPort([{ kind: "ok", content: ok }]);
    const { infer } = buildInfer(fake, { refinementEnabled: true, refineOnlyWeak: false });
    const skeleton = JSON.stringify({ role: "button" }); // identical content
    const g = graph(
      [
        node({ id: id("s1"), label: "", a11ySnapshot: skeleton }),
        node({ id: id("s2"), label: "", a11ySnapshot: skeleton }),
      ],
      [],
    );
    await infer.execute(g);
    expect(fake.callCount).toBe(1); // second screen reused the cached inference
  });
});

describe("InferIntent — defensive: a throwing refiner never tears the model (AC6)", () => {
  it("returns the tier-1 screen when the refiner unexpectedly throws", async () => {
    const guard = new IntentBudgetGuard(budget());
    const cache = new InMemoryIntentCache();
    // A refiner whose refine() rejects — InferIntent's per-screen try/catch must absorb it.
    const throwingRefiner = new LlmIntentRefiner(
      { complete: () => Promise.reject(new Error("boom")) },
      guard,
      cache,
    );
    // Force a throw INSIDE refine() by stubbing the method to reject directly.
    throwingRefiner.refine = () => Promise.reject(new Error("unexpected"));
    const infer = new InferIntent(
      new CredentialRedactor(),
      new A11yIntentDeriver(),
      throwingRefiner,
      { refinementEnabled: true, refineOnlyWeak: false },
    );
    const g = graph([node({ id: id("s1"), label: "Home", a11ySnapshot: "{}" })], []);
    const model = await infer.execute(g);
    expect(model.screens).toHaveLength(1);
    expect(model.screens[0]?.source).toBe("a11y");
    expect(model.screens[0]?.purpose).toBe("Home screen");
  });
});

describe("InferIntent — degraded screen refined to source=llm (AC2 + AC3)", () => {
  it("refines a weak screen via the LLM and carries confidence", async () => {
    const refined = JSON.stringify({
      purpose: "Onboarding screen",
      controls: [{ edgeId: "e-x", intent: "Continue onboarding", affordance: "submit" }],
    });
    const fake = new FakeLlmPort([{ kind: "ok", content: refined }]);
    const { infer } = buildInfer(fake, defaultInferIntentConfig());
    const g = graph(
      [node({ id: id("s1"), label: "", a11ySnapshot: UNLABELLED_SNAPSHOT })],
      [
        edge({
          id: "e-x",
          fromId: id("s1"),
          toId: id("s2"),
          actionType: "tap",
          actionPayload: '{"x":1,"y":2}',
        }),
      ],
    );
    const model = await infer.execute(g);
    const screen = model.screens[0];
    expect(screen?.source).toBe("llm");
    expect(screen?.confidence).not.toBeNull();
    expect(screen?.purpose).toBe("Onboarding screen");
    expect(screen?.controls[0]?.intent).toBe("Continue onboarding");
  });
});
