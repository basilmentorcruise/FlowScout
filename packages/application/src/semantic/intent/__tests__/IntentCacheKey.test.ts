/**
 * IntentCacheKey + InMemoryIntentCache unit suite (ADR-0006 §3.4 / AC3 / AC5).
 */
import { describe, it, expect } from "vitest";
import { intentCacheKey, INTENT_KEY_PREFIX } from "../IntentCacheKey.js";
import { InMemoryIntentCache } from "../InMemoryIntentCache.js";
import type { ScreenIntent } from "@flowscout/domain";
import { id } from "./fixtures.js";

describe("intentCacheKey — stable content addressing", () => {
  it("is deterministic for identical content", () => {
    expect(intentCacheKey('{"a":1}')).toBe(intentCacheKey('{"a":1}'));
  });

  it("collapses cosmetic whitespace differences to one key", () => {
    expect(intentCacheKey('{"a":1}')).toBe(intentCacheKey('{"a":1}   \n'));
  });

  it("differs for different content", () => {
    expect(intentCacheKey('{"a":1}')).not.toBe(intentCacheKey('{"a":2}'));
  });

  it("carries the versioned prefix", () => {
    expect(intentCacheKey("x").startsWith(`${INTENT_KEY_PREFIX}:`)).toBe(true);
  });

  it("does not contain the raw input (it is hashed)", () => {
    const secret = "[REDACTED]-but-still-hashed";
    expect(intentCacheKey(secret)).not.toContain(secret);
  });
});

describe("InMemoryIntentCache — IntentCachePort impl", () => {
  const sample: ScreenIntent = {
    stateId: id("s1"),
    purpose: "Sign In screen",
    source: "llm",
    confidence: null,
    controls: [],
  };

  it("returns null on miss and stores/retrieves on hit", async () => {
    const cache = new InMemoryIntentCache();
    expect(await cache.get("k")).toBeNull();
    await cache.set("k", sample);
    expect(await cache.get("k")).toEqual(sample);
    expect(cache.size).toBe(1);
    expect(cache.has("k")).toBe(true);
  });

  it("overwrites an existing entry for the same key", async () => {
    const cache = new InMemoryIntentCache();
    await cache.set("k", sample);
    await cache.set("k", { ...sample, purpose: "Other" });
    expect((await cache.get("k"))?.purpose).toBe("Other");
    expect(cache.size).toBe(1);
  });
});
