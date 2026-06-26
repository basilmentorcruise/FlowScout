/**
 * Eval scenarios — Per-screen & per-control intent inference (E3.2 / #55).
 *
 * Encoded per ADR-0001 §7 / ADR-0006 §4. Documented in
 * `docs/sdlc/evals/intent/README.md`. Deterministic with the FakeLlmPort — they define the
 * correctness invariants of the two-tier (a11y-first, budgeted-LLM) inference and catch
 * regressions when the prompt or derivation rules change.
 */
import { describe, it, expect } from "vitest";
import { InferIntent } from "../InferIntent.js";
import { A11yIntentDeriver } from "../A11yIntentDeriver.js";
import { LlmIntentRefiner } from "../LlmIntentRefiner.js";
import { IntentBudgetGuard } from "../IntentBudgetGuard.js";
import { InMemoryIntentCache } from "../InMemoryIntentCache.js";
import { CredentialRedactor } from "../../../crawl/redaction/CredentialRedactor.js";
import { FakeLlmPort } from "../../../test-support/FakeLlmPort.js";
import type { InferIntentConfig } from "../InferIntent.js";
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

function infer(fake: FakeLlmPort, config: InferIntentConfig): InferIntent {
  const guard = new IntentBudgetGuard(budget());
  const cache = new InMemoryIntentCache();
  const refiner = new LlmIntentRefiner(fake, guard, cache);
  return new InferIntent(new CredentialRedactor(), new A11yIntentDeriver(), refiner, config);
}

describe("intent eval scenarios", () => {
  it("EVAL-1: labelled login screen → correct screen purpose + per-control intents via tier-1 (no LLM)", async () => {
    const fake = new FakeLlmPort();
    const i = infer(fake, { refinementEnabled: true, refineOnlyWeak: true });
    const g = graph(
      [node({ id: id("login"), label: "Sign In", a11ySnapshot: SIGN_IN_SNAPSHOT })],
      [
        edge({
          id: "ev-email",
          fromId: id("login"),
          toId: id("login"),
          actionType: "typeText",
          actionPayload: "Email",
        }),
        edge({
          id: "ev-pwd",
          fromId: id("login"),
          toId: id("login"),
          actionType: "typeText",
          actionPayload: "Password",
        }),
        edge({
          id: "ev-submit",
          fromId: id("login"),
          toId: id("home"),
          actionType: "tap",
          actionPayload: "Log In",
        }),
      ],
    );

    const model = await i.execute(g);

    const screen = model.screens[0];
    expect(fake.callCount).toBe(0); // strong tier-1 ⇒ no LLM
    expect(screen?.purpose).toBe("Sign In screen");
    expect(screen?.source).toBe("a11y");
    expect(screen?.controls.find((c) => c.edgeId === "ev-submit")?.affordance).toBe("submit");
    expect(screen?.controls.filter((c) => c.affordance === "input")).toHaveLength(2);
    expect(screen?.controls.every((c) => c.confidence === null)).toBe(true);
  });

  it("EVAL-2: unlabelled/icon-only screen → degraded tier-1, then LLM-sourced refinement when enabled", async () => {
    // (a) refinement disabled ⇒ degraded tier-1 stands, no LLM.
    const noLlm = new FakeLlmPort();
    const tier1Only = infer(noLlm, { refinementEnabled: false, refineOnlyWeak: false });
    const g = graph(
      [node({ id: id("s"), label: "", a11ySnapshot: UNLABELLED_SNAPSHOT })],
      [
        edge({
          id: "ev-x",
          fromId: id("s"),
          toId: id("t"),
          actionType: "tap",
          actionPayload: '{"x":1,"y":2}',
        }),
      ],
    );
    const degraded = await tier1Only.execute(g);
    expect(noLlm.callCount).toBe(0);
    expect(degraded.screens[0]?.source).toBe("degraded");
    expect(degraded.screens[0]?.purpose.length).toBeGreaterThan(0);
    expect(degraded.screens[0]?.confidence).toBeNull();

    // (b) refinement enabled + scripted LLM ⇒ source=llm with confidence.
    const scripted = new FakeLlmPort([
      {
        kind: "ok",
        content: JSON.stringify({
          purpose: "Onboarding carousel",
          controls: [
            { edgeId: "ev-x", intent: "Advance to the next slide", affordance: "navigation" },
          ],
        }),
      },
    ]);
    const refined = await infer(scripted, {
      refinementEnabled: true,
      refineOnlyWeak: true,
    }).execute(g);
    expect(scripted.callCount).toBe(1);
    expect(refined.screens[0]?.source).toBe("llm");
    expect(refined.screens[0]?.confidence).not.toBeNull();
    expect(refined.screens[0]?.purpose).toBe("Onboarding carousel");
    expect(refined.screens[0]?.controls[0]?.intent).toBe("Advance to the next slide");
  });

  it("EVAL-3: secret-bearing snapshot → redacted everywhere (key, prompt, stored intent)", async () => {
    const scripted = new FakeLlmPort([
      { kind: "ok", content: JSON.stringify({ purpose: "Verify identity", controls: [] }) },
    ]);
    const i = infer(scripted, { refinementEnabled: true, refineOnlyWeak: false });
    const g = graph(
      [node({ id: id("verify"), label: "Verify", a11ySnapshot: SECRET_SNAPSHOT })],
      [
        edge({
          id: "ev-otp",
          fromId: id("verify"),
          toId: id("home"),
          actionType: "typeText",
          actionPayload: "482913",
        }),
      ],
    );

    const model = await i.execute(g);

    const promptText = scripted.allPromptText;
    expect(promptText).not.toContain("hunter2-SECRET"); // secure-field value masked
    expect(promptText).not.toContain("482913"); // OTP in observed label masked
    expect(promptText).toContain("[REDACTED]");

    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain("hunter2-SECRET");
    expect(serialized).not.toContain("482913");
  });
});
