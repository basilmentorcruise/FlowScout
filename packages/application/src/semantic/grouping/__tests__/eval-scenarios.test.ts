/**
 * Eval scenarios — App-purpose + workflow naming & feature grouping (E3.3 / #56).
 *
 * Encoded per ADR-0001 §7 / ADR-0007 §4. Documented in `docs/sdlc/evals/grouping/README.md`.
 * Deterministic with the FakeLlmPort — they define the correctness invariants of the two-tier
 * (rule-first, budgeted-LLM) naming/grouping and catch regressions when prompts or rules change.
 */
import { describe, it, expect } from "vitest";
import { NameAndGroupWorkflows } from "../NameAndGroupWorkflows.js";
import { RuleNameStrategy } from "../RuleNameStrategy.js";
import { LlmNamingRefiner } from "../LlmNamingRefiner.js";
import { AppPurposeInferer } from "../AppPurposeInferer.js";
import { InMemoryGroupingCache } from "../InMemoryGroupingCache.js";
import { defaultGroupingConfig, UNGROUPED } from "../GroupingConfig.js";
import type { GroupingConfig } from "../GroupingConfig.js";
import { IntentBudgetGuard } from "../../intent/IntentBudgetGuard.js";
import { CredentialRedactor } from "../../../crawl/redaction/CredentialRedactor.js";
import { FakeLlmPort } from "../../../test-support/FakeLlmPort.js";
import type { FakeLlmResponse } from "../../../test-support/FakeLlmPort.js";
import type { IntentModel } from "@flowscout/domain";
import {
  LOGIN_WORKFLOW,
  CHECKOUT_WORKFLOW,
  RICH_INTENT,
  intentModel,
  screen,
  control,
  workflow,
  step,
  id,
  budget,
} from "./fixtures.js";

function nameAndGroup(fake: FakeLlmPort, config: GroupingConfig): NameAndGroupWorkflows {
  const guard = new IntentBudgetGuard(budget());
  const cache = new InMemoryGroupingCache();
  const redactor = new CredentialRedactor();
  const refiner = new LlmNamingRefiner(fake, guard, cache, redactor);
  const inferer = new AppPurposeInferer(fake, guard, cache, redactor, config);
  return new NameAndGroupWorkflows(redactor, new RuleNameStrategy(), refiner, inferer, config);
}

describe("grouping eval scenarios", () => {
  it("EVAL-1: login + checkout workflows → correct names + groups + coherent purpose via tier-1 (no LLM)", async () => {
    const fake = new FakeLlmPort();
    const uc = nameAndGroup(fake, { ...defaultGroupingConfig(), inferPurposeWithLlm: false });
    const out = await uc.execute([LOGIN_WORKFLOW, CHECKOUT_WORKFLOW], RICH_INTENT);

    expect(fake.callCount).toBe(0);
    expect(out.workflows[0]?.featureGroup).toBe("Authentication");
    expect(out.workflows[0]?.name).toBe("Sign in screen → Home dashboard");
    expect(out.workflows[1]?.featureGroup).toBe("Cart & Checkout");
    expect(out.appPurpose).toBe("An app for Authentication, Cart & Checkout");
    expect(out.appPurposeConfidence).toBeNull();
  });

  it("EVAL-2: weak/low-signal workflow → degraded tier-1, then llm-sourced refinement when enabled", async () => {
    const weakWf = workflow({ id: "wf-weak", name: "Path A → B", steps: [step(0, id("opaque"), "tap region")] });
    const emptyIntent: IntentModel = intentModel([]);

    // (a) refinement disabled ⇒ degraded tier-1 stands (Ungrouped, null confidence, zero LLM).
    const fakeA = new FakeLlmPort();
    const ucA = nameAndGroup(fakeA, { ...defaultGroupingConfig(), refinementEnabled: false });
    const outA = await ucA.execute([weakWf], emptyIntent);
    expect(fakeA.callCount).toBe(0);
    expect(outA.workflows[0]?.featureGroup).toBe(UNGROUPED);
    expect(outA.workflows[0]?.name).toBe("Path A → B");
    expect(outA.workflows[0]?.inferenceConfidence).toBeNull();

    // (b) refinement enabled + scripted LLM ⇒ one call, llm-sourced labeling.
    const refined: FakeLlmResponse = {
      kind: "ok",
      content: JSON.stringify({
        workflows: [{ id: "wf-weak", name: "Open hidden filters", description: "Reveals advanced search filters", featureGroup: "Search & Browse" }],
      }),
    };
    const fakeB = new FakeLlmPort([refined], { kind: "ok", content: "{}" });
    const ucB = nameAndGroup(fakeB, { refinementEnabled: true, refineOnlyWeak: true, inferPurposeWithLlm: false });
    const outB = await ucB.execute([weakWf], emptyIntent);
    expect(fakeB.callCount).toBe(1);
    expect(outB.workflows[0]?.name).toBe("Open hidden filters");
    expect(outB.workflows[0]?.featureGroup).toBe("Search & Browse");
    expect(outB.workflows[0]?.inferenceConfidence).not.toBeNull();
  });

  it("EVAL-3: secret-bearing intent → redacted everywhere (name/group/purpose), invariant intact", async () => {
    const secretIntent: IntentModel = intentModel([
      screen(id("s-otp"), "Enter the code 482913 we texted you", [control("e1", "Submit code 482913", "submit")]),
    ]);
    const wf = workflow({ id: "wf-otp", name: "Verify path", steps: [step(0, id("s-otp"), "type code")] });
    // LLM even echoes the secret back — it must still be scrubbed from #56's output + prompt.
    const echo: FakeLlmResponse = {
      kind: "ok",
      content: JSON.stringify({ workflows: [{ id: "wf-otp", name: "Verify 482913", description: "OTP entry", featureGroup: "Authentication" }] }),
    };
    const fake = new FakeLlmPort([echo, { kind: "ok", content: JSON.stringify({ appPurpose: "A secure app, code 482913" }) }]);
    const uc = nameAndGroup(fake, { refinementEnabled: true, refineOnlyWeak: false, inferPurposeWithLlm: true });
    const out = await uc.execute([wf], secretIntent);

    const w0 = out.workflows[0];
    expect(`${String(w0?.name)}|${String(w0?.description)}|${String(w0?.featureGroup)}|${out.appPurpose}`).not.toContain("482913");
    expect(fake.allPromptText).not.toContain("482913");
    // Authoritative-set invariant: id + steps intact.
    expect(out.workflows.map((w) => w.id)).toEqual(["wf-otp"]);
    expect(out.workflows[0]?.steps).toEqual(wf.steps);
  });
});
