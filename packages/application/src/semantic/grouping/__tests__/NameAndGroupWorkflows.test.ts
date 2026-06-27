/**
 * NameAndGroupWorkflows — orchestrator integration (#56 / E3.3).
 *
 * Asserts the authoritative-set invariant (LLM never invents/drops/reorders workflows),
 * tier-1-always, budget cap, cache zero-recall, redaction before any sink, and edge cases.
 */
import { describe, it, expect } from "vitest";
import { NameAndGroupWorkflows } from "../NameAndGroupWorkflows.js";
import { RuleNameStrategy } from "../RuleNameStrategy.js";
import { LlmNamingRefiner } from "../LlmNamingRefiner.js";
import { AppPurposeInferer } from "../AppPurposeInferer.js";
import { InMemoryGroupingCache } from "../InMemoryGroupingCache.js";
import { defaultGroupingConfig, UNGROUPED, UNKNOWN_PURPOSE } from "../GroupingConfig.js";
import type { GroupingConfig } from "../GroupingConfig.js";
import { IntentBudgetGuard } from "../../intent/IntentBudgetGuard.js";
import { CredentialRedactor } from "../../../crawl/redaction/CredentialRedactor.js";
import { FakeLlmPort } from "../../../test-support/FakeLlmPort.js";
import type { FakeLlmResponse } from "../../../test-support/FakeLlmPort.js";
import type { CrawlBudget, IntentModel, Workflow } from "@flowscout/domain";
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

function makeOrchestrator(options: {
  script?: readonly FakeLlmResponse[];
  config?: GroupingConfig;
  crawlBudget?: CrawlBudget;
  cache?: InMemoryGroupingCache;
}): {
  uc: NameAndGroupWorkflows;
  fake: FakeLlmPort;
  guard: IntentBudgetGuard;
  cache: InMemoryGroupingCache;
} {
  const fake = new FakeLlmPort(options.script ?? []);
  const guard = new IntentBudgetGuard(options.crawlBudget ?? budget());
  const cache = options.cache ?? new InMemoryGroupingCache();
  const redactor = new CredentialRedactor();
  const config = options.config ?? defaultGroupingConfig();
  const refiner = new LlmNamingRefiner(fake, guard, cache, redactor);
  const inferer = new AppPurposeInferer(fake, guard, cache, redactor, config);
  const uc = new NameAndGroupWorkflows(redactor, new RuleNameStrategy(), refiner, inferer, config);
  return { uc, fake, guard, cache };
}

describe("NameAndGroupWorkflows", () => {
  it("tier-1 always: names + groups + purpose with NO LLM call when nothing is weak", async () => {
    // refineOnlyWeak default + rich intent ⇒ no workflow is weak; purpose inference disabled here.
    const { uc, fake } = makeOrchestrator({
      config: { ...defaultGroupingConfig(), inferPurposeWithLlm: false },
    });
    const out = await uc.execute([LOGIN_WORKFLOW, CHECKOUT_WORKFLOW], RICH_INTENT);

    expect(fake.callCount).toBe(0);
    expect(out.workflows[0]?.featureGroup).toBe("Authentication");
    expect(out.workflows[1]?.featureGroup).toBe("Cart & Checkout");
    expect(out.workflows[0]?.inferenceConfidence).toBeNull();
    expect(out.appPurpose).toBe("An app for Authentication, Cart & Checkout");
    expect(out.appPurposeConfidence).toBeNull();
  });

  it("is deterministic + stably ordered for identical inputs", async () => {
    const a = await makeOrchestrator({ config: { ...defaultGroupingConfig(), inferPurposeWithLlm: false } }).uc.execute(
      [LOGIN_WORKFLOW, CHECKOUT_WORKFLOW],
      RICH_INTENT,
    );
    const b = await makeOrchestrator({ config: { ...defaultGroupingConfig(), inferPurposeWithLlm: false } }).uc.execute(
      [LOGIN_WORKFLOW, CHECKOUT_WORKFLOW],
      RICH_INTENT,
    );
    expect(a).toEqual(b);
  });

  it("INVARIANT: preserves cardinality, ids, ORDER and steps regardless of LLM output", async () => {
    // A malicious/buggy LLM returns extra ids, omits, blanks — applied to every (weak) call.
    const rogue: FakeLlmResponse = {
      kind: "ok",
      content: JSON.stringify({
        workflows: [
          { id: "INVENTED-1", name: "ghost", description: "x", featureGroup: "y" },
          { id: "INVENTED-2", name: "ghost2", description: "x", featureGroup: "y" },
        ],
      }),
    };
    const inputs = [LOGIN_WORKFLOW, CHECKOUT_WORKFLOW];
    const { uc } = makeOrchestrator({
      script: [rogue, rogue, rogue],
      config: { refinementEnabled: true, refineOnlyWeak: false, inferPurposeWithLlm: false },
    });
    const out = await uc.execute(inputs, RICH_INTENT);

    expect(out.workflows.map((w) => w.id)).toEqual(["wf-login", "wf-checkout"]);
    expect(out.workflows.length).toBe(2);
    expect(out.workflows[0]?.steps).toEqual(LOGIN_WORKFLOW.steps);
    expect(out.workflows[1]?.steps).toEqual(CHECKOUT_WORKFLOW.steps);
    // invented ids never appear as labels
    expect(JSON.stringify(out.workflows)).not.toContain("ghost");
  });

  it("tier-2 refines a WEAK workflow via the LLM (llm source, non-null confidence)", async () => {
    const weakWf = workflow({ id: "wf-weak", name: "Path", steps: [step(0, id("mystery"), "tap")] });
    const json = JSON.stringify({
      workflows: [{ id: "wf-weak", name: "Hidden settings", description: "Adjusts settings", featureGroup: "Profile & Settings" }],
    });
    const { uc, fake } = makeOrchestrator({
      script: [{ kind: "ok", content: json }],
      config: { ...defaultGroupingConfig(), inferPurposeWithLlm: false },
    });
    const out = await uc.execute([weakWf], intentModel([]));
    expect(fake.callCount).toBe(1);
    expect(out.workflows[0]?.name).toBe("Hidden settings");
    expect(out.workflows[0]?.featureGroup).toBe("Profile & Settings");
    expect(out.workflows[0]?.inferenceConfidence).not.toBeNull();
  });

  it("budget cap: never exceeds maxLlmCalls; over-budget workflows degrade to rule labels", async () => {
    // Distinct step text ⇒ distinct skeletons/keys (so each is a separate refine attempt).
    const weak = (n: number): Workflow =>
      workflow({ id: `wf-${String(n)}`, name: `P${String(n)}`, steps: [step(0, id(`m-${String(n)}`), `tap ${String(n)}`)] });
    const named = (n: number): FakeLlmResponse => ({
      kind: "ok",
      content: JSON.stringify({ workflows: [{ id: `wf-${String(n)}`, name: `Named ${String(n)}`, description: "d", featureGroup: "Media" }] }),
      promptTokens: 10,
      completionTokens: 5,
    });
    const inputs = [weak(0), weak(1), weak(2), weak(3)];
    const { uc, fake, guard } = makeOrchestrator({
      script: inputs.map((_, i) => named(i)),
      crawlBudget: budget({ maxLlmCalls: 2 }),
      config: { refinementEnabled: true, refineOnlyWeak: false, inferPurposeWithLlm: false },
    });
    const out = await uc.execute(inputs, intentModel([]));

    expect(fake.callCount).toBeLessThanOrEqual(2);
    expect(guard.callsUsed).toBeLessThanOrEqual(2);
    // first two refined, the rest degrade to rule "Ungrouped"
    expect(out.workflows[3]?.featureGroup).toBe(UNGROUPED);
    expect(out.workflows[3]?.inferenceConfidence).toBeNull();
    expect(out.workflows.length).toBe(4);
  });

  it("cache zero-recall: a second run over identical inputs makes ZERO new LLM calls", async () => {
    const json = JSON.stringify({
      workflows: [{ id: "wf-weak", name: "Refined", description: "d", featureGroup: "Media" }],
    });
    const weakWf = workflow({ id: "wf-weak", name: "Path", steps: [step(0, id("mystery"), "tap")] });
    const cache = new InMemoryGroupingCache();
    const purposeJson = JSON.stringify({ appPurpose: "A media app" });
    const { uc, fake } = makeOrchestrator({
      script: [{ kind: "ok", content: json }, { kind: "ok", content: purposeJson }],
      cache,
    });
    await uc.execute([weakWf], intentModel([]));
    const callsAfterFirst = fake.callCount;
    await uc.execute([weakWf], intentModel([]));
    expect(fake.callCount).toBe(callsAfterFirst); // no new calls on the second run
  });

  it("graceful degradation: LLM unavailable ⇒ rule names + Ungrouped/Unknown, exactly one full result", async () => {
    const weakWf = workflow({ id: "wf-weak", name: "Path", steps: [step(0, id("mystery"), "tap")] });
    const { uc } = makeOrchestrator({
      script: [{ kind: "throws" }, { kind: "throws" }],
      config: { refinementEnabled: true, refineOnlyWeak: false, inferPurposeWithLlm: true },
    });
    const out = await uc.execute([weakWf], intentModel([]));
    expect(out.workflows.length).toBe(1);
    expect(out.workflows[0]?.featureGroup).toBe(UNGROUPED);
    expect(out.appPurpose).toBe(UNKNOWN_PURPOSE);
    expect(out.appPurposeConfidence).toBeNull();
  });

  it("REDACTION: a seeded secret in intent never reaches labels, the prompt, or the cache", async () => {
    // Seeded secrets are OTP-shaped tokens — exactly what CredentialRedactor targets.
    const secretIntent: IntentModel = intentModel([
      screen(id("s-secret"), "Your code is 482913 to continue", [control("e1", "Enter the PIN 135790")]),
    ]);
    const wf = workflow({ id: "wf-sec", name: "Path", steps: [step(0, id("s-secret"), "type 482913")] });
    const echo = JSON.stringify({ workflows: [{ id: "wf-sec", name: "Verify 482913", description: "d", featureGroup: "Authentication" }] });
    const { uc, fake } = makeOrchestrator({
      script: [{ kind: "ok", content: echo }, { kind: "ok", content: "{}" }],
      config: { refinementEnabled: true, refineOnlyWeak: false, inferPurposeWithLlm: true },
    });
    const out = await uc.execute([wf], secretIntent);

    // #56's OWN output fields (name/description/featureGroup/appPurpose) must be secret-free.
    // (workflow.steps are #54's frozen input — passed through unchanged, redacted at source.)
    const w0 = out.workflows[0];
    const ownFields = JSON.stringify([
      w0?.name,
      w0?.description,
      w0?.featureGroup,
      out.appPurpose,
    ]);
    expect(ownFields).not.toContain("482913");
    expect(ownFields).not.toContain("135790");
    // And the secret must never reach the LLM prompt (skeleton is redacted before the call).
    expect(fake.allPromptText).not.toContain("482913");
    expect(fake.allPromptText).not.toContain("135790");
  });

  it("edge: empty workflow set ⇒ valid result, Unknown purpose, no crash", async () => {
    const { uc } = makeOrchestrator({});
    const out = await uc.execute([], intentModel([]));
    expect(out.workflows).toEqual([]);
    expect(out.appPurpose).toBe(UNKNOWN_PURPOSE);
    expect(out.appPurposeConfidence).toBeNull();
  });

  it("edge: single workflow with no intent match ⇒ provisional name + Ungrouped", async () => {
    const wf = workflow({ id: "wf-solo", name: "Solo path", steps: [step(0, id("nope"), "tap")] });
    const { uc } = makeOrchestrator({ config: { ...defaultGroupingConfig(), refinementEnabled: false } });
    const out = await uc.execute([wf], intentModel([]));
    expect(out.workflows.length).toBe(1);
    expect(out.workflows[0]?.name).toBe("Solo path");
    expect(out.workflows[0]?.featureGroup).toBe(UNGROUPED);
  });
});
