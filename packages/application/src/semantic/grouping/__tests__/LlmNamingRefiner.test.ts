/**
 * LlmNamingRefiner — tier-2 budgeted/cached/redacted refinement + id-allowlist merge (#56).
 * Driven by the scripted FakeLlmPort; no SDK, no network.
 */
import { describe, it, expect } from "vitest";
import { LlmNamingRefiner } from "../LlmNamingRefiner.js";
import { InMemoryGroupingCache } from "../InMemoryGroupingCache.js";
import { groupingCacheKey } from "../GroupingCacheKey.js";
import { IntentBudgetGuard } from "../../intent/IntentBudgetGuard.js";
import { CredentialRedactor } from "../../../crawl/redaction/CredentialRedactor.js";
import { FakeLlmPort } from "../../../test-support/FakeLlmPort.js";
import type { FakeLlmResponse } from "../../../test-support/FakeLlmPort.js";
import type { WorkflowLabeling } from "@flowscout/domain";
import { budget } from "./fixtures.js";

const TIER1: WorkflowLabeling = {
  name: "Tier1 name",
  description: "Tier1 desc",
  featureGroup: "Ungrouped",
  confidence: null,
};

function refinerWith(
  script: readonly FakeLlmResponse[],
  guard = new IntentBudgetGuard(budget()),
  cache = new InMemoryGroupingCache(),
): {
  refiner: LlmNamingRefiner;
  fake: FakeLlmPort;
  guard: IntentBudgetGuard;
  cache: InMemoryGroupingCache;
} {
  const fake = new FakeLlmPort(script);
  const refiner = new LlmNamingRefiner(fake, guard, cache, new CredentialRedactor());
  return { refiner, fake, guard, cache };
}

function ok(content: string, promptTokens = 50, completionTokens = 10): FakeLlmResponse {
  return { kind: "ok", content, promptTokens, completionTokens };
}

const SKELETON = "Workflow: w1";

describe("LlmNamingRefiner", () => {
  it("parse success ⇒ llm-sourced labeling with non-null confidence, cached", async () => {
    const json = JSON.stringify({
      workflows: [
        {
          id: "wf-1",
          name: "Sign in",
          description: "Authenticate",
          featureGroup: "Authentication",
        },
      ],
    });
    const { refiner, fake, cache } = refinerWith([ok(json)]);
    const key = groupingCacheKey(SKELETON);
    const out = await refiner.refine("wf-1", TIER1, key, SKELETON);
    expect(out.name).toBe("Sign in");
    expect(out.featureGroup).toBe("Authentication");
    expect(out.confidence).not.toBeNull();
    expect(fake.callCount).toBe(1);
    expect(cache.has(key)).toBe(true);
  });

  it("INVARIANT: an invented/extra id is dropped (allowlist) ⇒ tier-1 kept", async () => {
    const json = JSON.stringify({
      workflows: [
        { id: "wf-INVENTED", name: "Bogus", description: "x", featureGroup: "Hacked" },
        { id: "another-fake", name: "Nope", description: "y", featureGroup: "z" },
      ],
    });
    const { refiner } = refinerWith([ok(json)]);
    const out = await refiner.refine("wf-1", TIER1, groupingCacheKey(SKELETON), SKELETON);
    expect(out).toEqual(TIER1); // no matching id ⇒ tier-1 stands
  });

  it("INVARIANT: LLM omits the workflow ⇒ tier-1 kept", async () => {
    const { refiner } = refinerWith([ok(JSON.stringify({ workflows: [] }))]);
    const out = await refiner.refine("wf-1", TIER1, groupingCacheKey(SKELETON), SKELETON);
    expect(out).toEqual(TIER1);
  });

  it("LLM blanks the name ⇒ tier-1 kept (never empty)", async () => {
    const json = JSON.stringify({
      workflows: [{ id: "wf-1", name: "  ", description: "d", featureGroup: "g" }],
    });
    const { refiner } = refinerWith([ok(json)]);
    const out = await refiner.refine("wf-1", TIER1, groupingCacheKey(SKELETON), SKELETON);
    expect(out).toEqual(TIER1);
  });

  it("blank featureGroup/description fall back to tier-1 values", async () => {
    const json = JSON.stringify({
      workflows: [{ id: "wf-1", name: "Real name", description: "", featureGroup: "" }],
    });
    const { refiner } = refinerWith([ok(json)]);
    const out = await refiner.refine("wf-1", TIER1, groupingCacheKey(SKELETON), SKELETON);
    expect(out.name).toBe("Real name");
    expect(out.description).toBe(TIER1.description);
    expect(out.featureGroup).toBe(TIER1.featureGroup);
  });

  it("unparseable output ⇒ tier-1 fallback (call still counted)", async () => {
    const { refiner, guard } = refinerWith([ok("not json at all")]);
    const out = await refiner.refine("wf-1", TIER1, groupingCacheKey(SKELETON), SKELETON);
    expect(out).toEqual(TIER1);
    expect(guard.callsUsed).toBe(1);
  });

  it("thrown/timeout ⇒ tier-1 fallback, records a failed call with 0 tokens", async () => {
    const guard = new IntentBudgetGuard(budget());
    const { refiner } = refinerWith([{ kind: "throws" }], guard);
    const out = await refiner.refine("wf-1", TIER1, groupingCacheKey(SKELETON), SKELETON);
    expect(out).toEqual(TIER1);
    expect(guard.callsUsed).toBe(1);
    expect(guard.tokensUsed).toBe(0);
  });

  it("over budget ⇒ no call, tier-1 stands", async () => {
    const guard = new IntentBudgetGuard(budget({ maxLlmCalls: 0 }));
    const { refiner, fake } = refinerWith([ok("{}")], guard);
    const out = await refiner.refine("wf-1", TIER1, groupingCacheKey(SKELETON), SKELETON);
    expect(out).toEqual(TIER1);
    expect(fake.callCount).toBe(0);
  });

  it("cache hit ⇒ ZERO new LLM call", async () => {
    const cache = new InMemoryGroupingCache();
    const key = groupingCacheKey(SKELETON);
    await cache.set(key, { name: "Cached", description: "d", featureGroup: "g", confidence: null });
    const { refiner, fake } = refinerWith([ok("{}")], new IntentBudgetGuard(budget()), cache);
    const out = await refiner.refine("wf-1", TIER1, key, SKELETON);
    expect(out.name).toBe("Cached");
    expect(fake.callCount).toBe(0);
  });

  it("redacts a secret echoed in the LLM output before it becomes a label or cache entry", async () => {
    const json = JSON.stringify({
      workflows: [
        {
          id: "wf-1",
          name: "Code is 482913 ready",
          description: "pin 123456",
          featureGroup: "Authentication",
        },
      ],
    });
    const { refiner, cache } = refinerWith([ok(json)]);
    const key = groupingCacheKey(SKELETON);
    const out = await refiner.refine("wf-1", TIER1, key, SKELETON);
    expect(out.name).not.toContain("482913");
    expect(out.description).not.toContain("123456");
    const cached = await cache.get(key);
    expect(JSON.stringify(cached)).not.toContain("482913");
  });
});
