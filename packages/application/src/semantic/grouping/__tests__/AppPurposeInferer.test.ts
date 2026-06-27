/**
 * AppPurposeInferer — per-map purpose: rule path + ONE budgeted/cached LLM call (#56).
 */
import { describe, it, expect } from "vitest";
import { AppPurposeInferer } from "../AppPurposeInferer.js";
import { InMemoryGroupingCache } from "../InMemoryGroupingCache.js";
import { defaultGroupingConfig, UNKNOWN_PURPOSE } from "../GroupingConfig.js";
import { purposeCacheKey } from "../GroupingCacheKey.js";
import type { GroupingConfig } from "../GroupingConfig.js";
import { IntentBudgetGuard } from "../../intent/IntentBudgetGuard.js";
import { CredentialRedactor } from "../../../crawl/redaction/CredentialRedactor.js";
import { FakeLlmPort } from "../../../test-support/FakeLlmPort.js";
import type { FakeLlmResponse } from "../../../test-support/FakeLlmPort.js";
import type { Workflow } from "@flowscout/domain";
import { workflow, step, id, budget } from "./fixtures.js";

function labeled(wfId: string, group: string): Workflow {
  return { ...workflow({ id: wfId, steps: [step(0, id(`s-${wfId}`), "x")] }), featureGroup: group };
}

function infererWith(
  script: readonly FakeLlmResponse[],
  config: GroupingConfig = defaultGroupingConfig(),
  guard = new IntentBudgetGuard(budget()),
  cache = new InMemoryGroupingCache(),
): { inferer: AppPurposeInferer; fake: FakeLlmPort; guard: IntentBudgetGuard; cache: InMemoryGroupingCache } {
  const fake = new FakeLlmPort(script);
  const inferer = new AppPurposeInferer(fake, guard, cache, new CredentialRedactor(), config);
  return { inferer, fake, guard, cache };
}

const SIGNAL = "Feature groups: Authentication, Cart & Checkout";

describe("AppPurposeInferer", () => {
  it("rule path: synthesises purpose from feature groups (frequency desc, name asc), null confidence", async () => {
    const { inferer, fake } = infererWith([], { ...defaultGroupingConfig(), inferPurposeWithLlm: false });
    const out = await inferer.infer(
      [labeled("a", "Cart & Checkout"), labeled("b", "Authentication"), labeled("c", "Authentication")],
      SIGNAL,
    );
    expect(out.appPurpose).toBe("An app for Authentication, Cart & Checkout");
    expect(out.appPurposeConfidence).toBeNull();
    expect(fake.callCount).toBe(0);
  });

  it("no groups ⇒ 'Unknown' with null confidence", async () => {
    const { inferer } = infererWith([], { ...defaultGroupingConfig(), inferPurposeWithLlm: false });
    const out = await inferer.infer([labeled("a", "Ungrouped")], "");
    expect(out.appPurpose).toBe(UNKNOWN_PURPOSE);
    expect(out.appPurposeConfidence).toBeNull();
  });

  it("tier-2: one scripted LLM call ⇒ llm purpose with non-null confidence", async () => {
    const json = JSON.stringify({ appPurpose: "A shopping app with secure sign-in" });
    const { inferer, fake } = infererWith([{ kind: "ok", content: json }]);
    const out = await inferer.infer([labeled("a", "Authentication")], SIGNAL);
    expect(out.appPurpose).toBe("A shopping app with secure sign-in");
    expect(out.appPurposeConfidence).not.toBeNull();
    expect(fake.callCount).toBe(1);
  });

  it("cache zero-recall: a second infer over the same signal makes no new LLM call", async () => {
    const json = JSON.stringify({ appPurpose: "A shopping app" });
    const { inferer, fake } = infererWith([{ kind: "ok", content: json }]);
    await inferer.infer([labeled("a", "Authentication")], SIGNAL);
    const out2 = await inferer.infer([labeled("a", "Authentication")], SIGNAL);
    expect(out2.appPurpose).toBe("A shopping app");
    expect(fake.callCount).toBe(1);
  });

  it("over budget ⇒ rule purpose stands, no call", async () => {
    const guard = new IntentBudgetGuard(budget({ maxLlmCalls: 0 }));
    const { inferer, fake } = infererWith([{ kind: "ok", content: "{}" }], defaultGroupingConfig(), guard);
    const out = await inferer.infer([labeled("a", "Authentication")], SIGNAL);
    expect(out.appPurpose).toBe("An app for Authentication");
    expect(out.appPurposeConfidence).toBeNull();
    expect(fake.callCount).toBe(0);
  });

  it("unparseable ⇒ rule fallback (call still counted)", async () => {
    const { inferer, guard } = infererWith([{ kind: "ok", content: "garbage" }]);
    const out = await inferer.infer([labeled("a", "Authentication")], SIGNAL);
    expect(out.appPurpose).toBe("An app for Authentication");
    expect(guard.callsUsed).toBe(1);
  });

  it("thrown ⇒ rule fallback, records failed call (0 tokens)", async () => {
    const guard = new IntentBudgetGuard(budget());
    const { inferer } = infererWith([{ kind: "throws" }], defaultGroupingConfig(), guard);
    const out = await inferer.infer([labeled("a", "Authentication")], SIGNAL);
    expect(out.appPurpose).toBe("An app for Authentication");
    expect(guard.callsUsed).toBe(1);
    expect(guard.tokensUsed).toBe(0);
  });

  it("refinement disabled ⇒ rule path only", async () => {
    const { inferer, fake } = infererWith([{ kind: "ok", content: "{}" }], {
      ...defaultGroupingConfig(),
      refinementEnabled: false,
    });
    const out = await inferer.infer([labeled("a", "Authentication")], SIGNAL);
    expect(out.appPurposeConfidence).toBeNull();
    expect(fake.callCount).toBe(0);
  });

  it("redacts a secret echoed by the LLM in the purpose + cache", async () => {
    const json = JSON.stringify({ appPurpose: "An app, login code 482913" });
    const { inferer, cache } = infererWith([{ kind: "ok", content: json }]);
    const out = await inferer.infer([labeled("a", "Authentication")], SIGNAL);
    expect(out.appPurpose).not.toContain("482913");
    const cached = await cache.get(purposeCacheKey(SIGNAL));
    expect(JSON.stringify(cached)).not.toContain("482913");
  });
});
