/**
 * EmbeddingBudgetGuard + InMemoryEmbeddingCache + config defaults — unit suite (#58).
 * Mirrors the IntentBudgetGuard / InMemoryIntentCache coverage discipline.
 */
import { describe, it, expect } from "vitest";
import { EmbeddingBudgetGuard } from "../EmbeddingBudgetGuard.js";
import { InMemoryEmbeddingCache } from "../InMemoryEmbeddingCache.js";
import { defaultRefineIdentitiesConfig } from "../RefineIdentitiesConfig.js";
import { defaultDuplicateDetectorConfig } from "../DuplicateDetectorConfig.js";
import { budget, id } from "./fixtures.js";

describe("EmbeddingBudgetGuard", () => {
  it("gates on both call and token ceilings", () => {
    const guard = new EmbeddingBudgetGuard(budget({ maxLlmCalls: 2, maxTokens: 100 }));
    expect(guard.canCall()).toBe(true);
    expect(guard.callsUsed).toBe(0);
    expect(guard.tokensUsed).toBe(0);

    guard.recordUsage(10);
    expect(guard.callsUsed).toBe(1);
    expect(guard.tokensUsed).toBe(10);
    expect(guard.canCall()).toBe(true);

    guard.recordUsage(10);
    expect(guard.canCall()).toBe(false); // call ceiling reached
  });

  it("stops at the token ceiling", () => {
    const guard = new EmbeddingBudgetGuard(budget({ maxLlmCalls: 100, maxTokens: 5 }));
    guard.recordUsage(5);
    expect(guard.canCall()).toBe(false);
  });

  it("clamps negative token inputs to zero", () => {
    const guard = new EmbeddingBudgetGuard(budget());
    guard.recordUsage(-50);
    expect(guard.tokensUsed).toBe(0);
    expect(guard.callsUsed).toBe(1);
  });
});

describe("InMemoryEmbeddingCache", () => {
  it("stores and retrieves a vector by bucket identity; reports a miss as null", async () => {
    const cache = new InMemoryEmbeddingCache();
    const key = id("n-a");
    expect(await cache.get(key)).toBeNull();
    expect(cache.has(key)).toBe(false);

    await cache.set(key, [1, 2, 3]);
    expect(await cache.get(key)).toEqual([1, 2, 3]);
    expect(cache.has(key)).toBe(true);
    expect(cache.size).toBe(1);
  });

  it("distinguishes a cached EMPTY vector from a miss", async () => {
    const cache = new InMemoryEmbeddingCache();
    const key = id("n-degraded");
    await cache.set(key, []);
    expect(await cache.get(key)).toEqual([]); // not null
  });
});

describe("config defaults", () => {
  it("default RefineIdentitiesConfig enables confident labels", () => {
    expect(defaultRefineIdentitiesConfig()).toEqual({ labelsFromIntent: true });
  });
  it("default DuplicateDetectorConfig confirms with intent", () => {
    expect(defaultDuplicateDetectorConfig()).toEqual({ confirmWithIntent: true });
  });
});
