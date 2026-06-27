/**
 * GroupingCacheKey + InMemoryGroupingCache — content-hash keys + in-memory port (#56).
 */
import { describe, it, expect } from "vitest";
import {
  groupingCacheKey,
  purposeCacheKey,
  GROUPING_KEY_PREFIX,
  PURPOSE_KEY_PREFIX,
} from "../GroupingCacheKey.js";
import { InMemoryGroupingCache } from "../InMemoryGroupingCache.js";
import { makeConfidenceScore } from "@flowscout/domain";

describe("groupingCacheKey", () => {
  it("is stable for identical content and prefixed", () => {
    const a = groupingCacheKey("Workflow: Sign in");
    const b = groupingCacheKey("Workflow: Sign in");
    expect(a).toBe(b);
    expect(a.startsWith(`${GROUPING_KEY_PREFIX}:`)).toBe(true);
  });

  it("normalises whitespace so cosmetically-different skeletons collapse", () => {
    expect(groupingCacheKey("a   b\n c")).toBe(groupingCacheKey("a b c"));
  });

  it("differs for different content", () => {
    expect(groupingCacheKey("login")).not.toBe(groupingCacheKey("checkout"));
  });

  it("purposeCacheKey uses a distinct prefix so it never collides with a workflow key", () => {
    const same = "Feature groups: Authentication";
    expect(purposeCacheKey(same).startsWith(`${PURPOSE_KEY_PREFIX}:`)).toBe(true);
    expect(purposeCacheKey(same)).not.toBe(groupingCacheKey(same));
  });
});

describe("InMemoryGroupingCache", () => {
  it("stores and retrieves a labeling; misses return null", async () => {
    const cache = new InMemoryGroupingCache();
    expect(await cache.get("k")).toBeNull();
    await cache.set("k", {
      name: "Sign in",
      description: "d",
      featureGroup: "Authentication",
      confidence: makeConfidenceScore(0.8),
    });
    expect(cache.has("k")).toBe(true);
    expect(cache.size).toBe(1);
    const got = await cache.get("k");
    expect(got?.name).toBe("Sign in");
  });

  it("overwrites an existing key", async () => {
    const cache = new InMemoryGroupingCache();
    await cache.set("k", { name: "a", description: "d", featureGroup: "g", confidence: null });
    await cache.set("k", { name: "b", description: "d", featureGroup: "g", confidence: null });
    expect((await cache.get("k"))?.name).toBe("b");
    expect(cache.size).toBe(1);
  });
});
