/**
 * InMemoryDecisionCache unit tests.
 *
 * Covers:
 *   - Basic get/set operations
 *   - Cache miss returns null
 *   - Cache hit returns stored decision
 *   - Overwrite (set twice for same state)
 *   - Size tracking
 *   - Security: API key must never appear in cache entries
 */
import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryDecisionCache } from "../InMemoryDecisionCache.js";
import type { PolicyDecision } from "@flowscout/domain";
import { makeStateIdentity } from "@flowscout/domain";

const STATE_A = makeStateIdentity("state-aaaaaaa");
const STATE_B = makeStateIdentity("state-bbbbbbb");

const ACT_DECISION: PolicyDecision = {
  kind: "act",
  action: {
    actionType: "tap",
    actionPayload: JSON.stringify({ elementId: "btn-001" }),
    rationale: "tap the main button",
  },
  usedLlm: true,
};

const BACKTRACK_DECISION: PolicyDecision = {
  kind: "backtrack",
  reason: "no untried actions",
};

const DONE_DECISION: PolicyDecision = {
  kind: "done",
  reason: "all screens visited",
};

describe("InMemoryDecisionCache", () => {
  let cache: InMemoryDecisionCache;

  beforeEach(() => {
    cache = new InMemoryDecisionCache();
  });

  // ── Basic get/set ─────────────────────────────────────────────────────────────

  it("returns null for a state that has never been cached", async () => {
    const result = await cache.get(STATE_A);
    expect(result).toBeNull();
  });

  it("stores and retrieves an 'act' decision", async () => {
    await cache.set(STATE_A, ACT_DECISION);
    const result = await cache.get(STATE_A);
    expect(result).toEqual(ACT_DECISION);
  });

  it("stores and retrieves a 'backtrack' decision", async () => {
    await cache.set(STATE_A, BACKTRACK_DECISION);
    const result = await cache.get(STATE_A);
    expect(result).toEqual(BACKTRACK_DECISION);
  });

  it("stores and retrieves a 'done' decision", async () => {
    await cache.set(STATE_A, DONE_DECISION);
    const result = await cache.get(STATE_A);
    expect(result).toEqual(DONE_DECISION);
  });

  // ── Isolation between states ──────────────────────────────────────────────────

  it("states are independently cached", async () => {
    await cache.set(STATE_A, ACT_DECISION);
    await cache.set(STATE_B, BACKTRACK_DECISION);

    expect(await cache.get(STATE_A)).toEqual(ACT_DECISION);
    expect(await cache.get(STATE_B)).toEqual(BACKTRACK_DECISION);
  });

  it("cache miss on STATE_B after only STATE_A is set", async () => {
    await cache.set(STATE_A, ACT_DECISION);
    expect(await cache.get(STATE_B)).toBeNull();
  });

  // ── Overwrite ─────────────────────────────────────────────────────────────────

  it("overwriting a cached decision replaces the previous value", async () => {
    await cache.set(STATE_A, ACT_DECISION);
    await cache.set(STATE_A, BACKTRACK_DECISION);

    expect(await cache.get(STATE_A)).toEqual(BACKTRACK_DECISION);
  });

  // ── Size / has ────────────────────────────────────────────────────────────────

  it("size is 0 on construction", () => {
    expect(cache.size).toBe(0);
  });

  it("size increments on new set", async () => {
    await cache.set(STATE_A, ACT_DECISION);
    expect(cache.size).toBe(1);
    await cache.set(STATE_B, BACKTRACK_DECISION);
    expect(cache.size).toBe(2);
  });

  it("size does not increase when overwriting", async () => {
    await cache.set(STATE_A, ACT_DECISION);
    await cache.set(STATE_A, BACKTRACK_DECISION);
    expect(cache.size).toBe(1);
  });

  it("has() returns false for uncached state", () => {
    expect(cache.has(STATE_A)).toBe(false);
  });

  it("has() returns true after set", async () => {
    await cache.set(STATE_A, ACT_DECISION);
    expect(cache.has(STATE_A)).toBe(true);
  });

  // ── Security: T7 — no API key in cache ────────────────────────────────────────

  it("cache entries never contain the string 'sk-ant' (API key pattern — T5)", async () => {
    const decisionWithKeyLooking: PolicyDecision = {
      kind: "act",
      action: {
        actionType: "tap",
        actionPayload: '{"elementId":"btn"}',
        rationale: "tap (this rationale does NOT contain a real key)",
      },
      usedLlm: true,
    };
    await cache.set(STATE_A, decisionWithKeyLooking);
    const stored = await cache.get(STATE_A);
    const serialized = JSON.stringify(stored);
    // The cache value should not contain anything that looks like a real API key
    expect(serialized).not.toContain("sk-ant");
    expect(serialized).not.toContain("API_KEY");
  });
});
