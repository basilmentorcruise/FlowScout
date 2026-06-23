/**
 * Tests for StateIdentity strategy — A11ySignatureStrategy + CompositeStateIdentityStrategy.
 *
 * Covers:
 * - AC1: Same screen via different paths (differing only in volatile content) → same identity.
 * - AC2: Two materially different screens → different identity.
 * - AC3: Empty/malformed a11y snapshot → degraded identity, never throws.
 * - AC4: Strategy is behind an interface; a stub strategy can replace the default without
 *        changing the calling code (Open/Closed verified).
 * - AC5: ≥3 eval scenarios covering same-screen-different-path, different-screen, volatile-content.
 * - AC6: Coverage gate met (100% line+branch on state-identity business logic).
 */
import { describe, it, expect } from "vitest";
import type { A11ySnapshot } from "../ports/MobileDriverPort.js";
import type { StateIdentityInput, StateIdentityStrategy } from "../ports/StateIdentityPort.js";
import { A11ySignatureStrategy } from "../models/state-identity/A11ySignatureStrategy.js";
import { CompositeStateIdentityStrategy } from "../models/state-identity/CompositeStateIdentityStrategy.js";
import type { Platform, StateIdentity } from "../models/state-graph.js";

// ---------------------------------------------------------------------------
// Named constants (no magic numbers in tests)
// ---------------------------------------------------------------------------
const SMALL_LIST_ROW_COUNT = 3;
const LARGE_LIST_ROW_COUNT = 200;
const SHALLOW_NEST_DEPTH = 5;
const DEEP_NEST_DEPTH = 20;
const OVERSIZED_BYTES = 600_000;
const HOUR_MODULO = 24;
const PAD_WIDTH = 2;
const STUB_CALL_EXPECTED = 2;
const SHA256_HEX_LENGTH = 64;
const SAMPLE_EMBED: readonly number[] = [0.1, 0.2, 0.3];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function snap(json: string): A11ySnapshot {
  return json as unknown as A11ySnapshot;
}

const IOS: Platform = "ios";

function makeInput(rawJson: string): StateIdentityInput {
  return { a11ySnapshot: snap(rawJson), platform: IOS };
}

// ---------------------------------------------------------------------------
// Fixture JSON builders
// ---------------------------------------------------------------------------

const HOME_SCREEN_JSON = JSON.stringify({
  type: "Application",
  children: [
    { type: "NavigationBar", label: "Home", children: [] },
    {
      type: "ScrollView",
      children: [
        { type: "Button", label: "Settings", children: [] },
        { type: "Button", label: "Profile", children: [] },
      ],
    },
  ],
});

// Same structure as HOME, but with volatile content injected (timestamp + counter).
const HOME_SCREEN_WITH_VOLATILE_JSON = JSON.stringify({
  type: "Application",
  children: [
    { type: "NavigationBar", label: "Home", children: [] },
    {
      type: "ScrollView",
      children: [
        { type: "Button", label: "Settings", children: [] },
        { type: "Button", label: "Profile", children: [] },
        // Volatile StaticText: timestamp + count — should not fork identity.
        { type: "StaticText", label: "Last sync: 2024-01-15T10:30:00Z — 42 items" },
      ],
    },
  ],
});

// Materially different screen.
const SETTINGS_SCREEN_JSON = JSON.stringify({
  type: "Application",
  children: [
    { type: "NavigationBar", label: "Settings", children: [] },
    {
      type: "Table",
      children: [
        { type: "Cell", label: "Notifications", children: [] },
        { type: "Cell", label: "Privacy", children: [] },
        { type: "Cell", label: "Account", children: [] },
      ],
    },
  ],
});

/** Generate a list screen JSON with n rows (each row has a timestamp label). */
function makeListScreenJson(rowCount: number): string {
  const rows = Array.from({ length: rowCount }, (_v, i) => ({
    type: "Cell",
    label: `Message ${String(i + 1)} — 2024-01-15T${String(i % HOUR_MODULO).padStart(PAD_WIDTH, "0")}:00:00Z`,
  }));
  return JSON.stringify({
    type: "Application",
    children: [
      { type: "NavigationBar", label: "Inbox", children: [] },
      { type: "Table", children: rows },
    ],
  });
}

/** Build a deeply nested tree of 'Group' nodes with a 'Button' leaf. */
function nestDeep(depth: number): object {
  if (depth === 0) return { type: "Button", label: "leaf" };
  return { type: "Group", children: [nestDeep(depth - 1)] };
}

// ---------------------------------------------------------------------------
// EVAL SCENARIOS (≥3, per ADR-0001 §7 / ADR-0004 §2.3)
// ---------------------------------------------------------------------------

describe("A11ySignatureStrategy — eval scenarios", () => {
  const strategy = new A11ySignatureStrategy();

  it("EVAL-1: same screen via two paths with differing volatile content → same identity", () => {
    const path1Id = strategy.identify(makeInput(HOME_SCREEN_JSON));
    const path2Id = strategy.identify(makeInput(HOME_SCREEN_WITH_VOLATILE_JSON));
    expect(path1Id).toBe(path2Id);
  });

  it("EVAL-2: two materially different screens → different identities", () => {
    const homeId = strategy.identify(makeInput(HOME_SCREEN_JSON));
    const settingsId = strategy.identify(makeInput(SETTINGS_SCREEN_JSON));
    expect(homeId).not.toBe(settingsId);
  });

  it("EVAL-3: same list screen with 3 vs 200 rows → same identity (sibling collapse)", () => {
    const smallId = strategy.identify(makeInput(makeListScreenJson(SMALL_LIST_ROW_COUNT)));
    const largeId = strategy.identify(makeInput(makeListScreenJson(LARGE_LIST_ROW_COUNT)));
    expect(smallId).toBe(largeId);
  });

  it("EVAL-4: empty/malformed snapshot → degraded identity (never throws)", () => {
    const degradedId = strategy.identify(makeInput(""));
    expect(degradedId).toMatch(/^degraded:/);
    expect(() => strategy.identify(makeInput(""))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Degraded path (AC3 / security must: T11)
// ---------------------------------------------------------------------------

describe("A11ySignatureStrategy — degraded path (AC3)", () => {
  const strategy = new A11ySignatureStrategy();

  it("returns a degraded identity for an empty snapshot", () => {
    expect(strategy.identify(makeInput(""))).toMatch(/^degraded:/);
  });

  it("returns a degraded identity for whitespace-only snapshot", () => {
    expect(strategy.identify(makeInput("   "))).toMatch(/^degraded:/);
  });

  it("returns a degraded identity for non-JSON snapshot", () => {
    expect(strategy.identify(makeInput("not valid json {{{{"))).toMatch(/^degraded:/);
  });

  it("returns a degraded identity for a JSON string primitive", () => {
    expect(strategy.identify(makeInput('"just a string"'))).toMatch(/^degraded:/);
  });

  it("returns a degraded identity for a JSON number primitive", () => {
    expect(strategy.identify(makeInput("42"))).toMatch(/^degraded:/);
  });

  it("returns a degraded identity for null JSON", () => {
    expect(strategy.identify(makeInput("null"))).toMatch(/^degraded:/);
  });

  it("returns a degraded identity for a JSON array (not an object)", () => {
    expect(strategy.identify(makeInput('["array"]'))).toMatch(/^degraded:/);
  });

  it("returns a degraded identity for an oversized snapshot (DoS guard, T11)", () => {
    const oversized = "x".repeat(OVERSIZED_BYTES);
    const id = strategy.identify(makeInput(oversized));
    expect(id).toMatch(/^degraded:/);
    expect(() => strategy.identify(makeInput(oversized))).not.toThrow();
  });

  it("returns a degraded identity for valid JSON yielding an empty skeleton", () => {
    // StaticText at root with no accessibility identifier → content-only → empty skeleton.
    const contentOnly = JSON.stringify({ type: "StaticText", label: "plain text" });
    expect(strategy.identify(makeInput(contentOnly))).toMatch(/^degraded:/);
  });

  it("never throws for any malformed input", () => {
    const malformed = ["", "   ", "not json", '{"unclosed": ', '["array"]', "null", "42", "true"];
    for (const raw of malformed) {
      expect(() => strategy.identify(makeInput(raw))).not.toThrow();
    }
  });

  it("two different malformed snapshots get different degraded ids", () => {
    const id1 = strategy.identify(makeInput("invalid json A"));
    const id2 = strategy.identify(makeInput("invalid json B"));
    expect(id1).not.toBe(id2);
  });

  it("degraded identity matches 'degraded:' prefix + 64-char hex", () => {
    const id = strategy.identify(makeInput("garbage input"));
    expect(id).toMatch(/^degraded:[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("A11ySignatureStrategy — determinism", () => {
  const strategy = new A11ySignatureStrategy();

  it("returns the same identity for identical input on repeated calls", () => {
    const id1 = strategy.identify(makeInput(HOME_SCREEN_JSON));
    const id2 = strategy.identify(makeInput(HOME_SCREEN_JSON));
    expect(id1).toBe(id2);
  });

  it("five calls with the same input produce the same identity", () => {
    const CALL_COUNT = 5;
    const ids = Array.from({ length: CALL_COUNT }, () =>
      strategy.identify(makeInput(HOME_SCREEN_JSON)),
    );
    expect(new Set(ids).size).toBe(1);
  });

  it("returns a 64-char hex string for valid input (SHA-256 output format)", () => {
    const id = strategy.identify(makeInput(HOME_SCREEN_JSON));
    const hexPattern = new RegExp(`^[0-9a-f]{${String(SHA256_HEX_LENGTH)}}$`);
    expect(id).toMatch(hexPattern);
  });
});

// ---------------------------------------------------------------------------
// Volatile-content normalization
// ---------------------------------------------------------------------------

describe("A11ySignatureStrategy — volatile-content normalization", () => {
  const strategy = new A11ySignatureStrategy();

  it("collapses digit runs to # so labels with different numbers hash the same", () => {
    const s1 = JSON.stringify({
      type: "Application",
      children: [{ type: "Button", label: "Item 42" }],
    });
    const s2 = JSON.stringify({
      type: "Application",
      children: [{ type: "Button", label: "Item 99" }],
    });
    expect(strategy.identify(makeInput(s1))).toBe(strategy.identify(makeInput(s2)));
  });

  it("normalizes ISO timestamps to <ts>", () => {
    const s1 = JSON.stringify({
      type: "Application",
      children: [{ type: "StaticText", label: "Updated: 2024-01-15T10:30:00Z" }],
    });
    const s2 = JSON.stringify({
      type: "Application",
      children: [{ type: "StaticText", label: "Updated: 2025-06-20T09:00:00Z" }],
    });
    expect(strategy.identify(makeInput(s1))).toBe(strategy.identify(makeInput(s2)));
  });

  it("normalizes currency values to <num>", () => {
    const s1 = JSON.stringify({
      type: "Application",
      children: [{ type: "StaticText", label: "Total: $12.99" }],
    });
    const s2 = JSON.stringify({
      type: "Application",
      children: [{ type: "StaticText", label: "Total: $9.99" }],
    });
    expect(strategy.identify(makeInput(s1))).toBe(strategy.identify(makeInput(s2)));
  });

  it("normalizes percentages to <num>", () => {
    const s1 = JSON.stringify({
      type: "Application",
      children: [{ type: "StaticText", label: "Progress: 45%" }],
    });
    const s2 = JSON.stringify({
      type: "Application",
      children: [{ type: "StaticText", label: "Progress: 78%" }],
    });
    expect(strategy.identify(makeInput(s1))).toBe(strategy.identify(makeInput(s2)));
  });
});

// ---------------------------------------------------------------------------
// Structural token extraction
// ---------------------------------------------------------------------------

describe("A11ySignatureStrategy — stable key selection", () => {
  const strategy = new A11ySignatureStrategy();

  it("prefers accessibilityIdentifier over label as stable key", () => {
    const s1 = JSON.stringify({
      type: "Application",
      children: [
        { type: "Button", accessibilityIdentifier: "btn-settings", label: "Settings — 5m ago" },
      ],
    });
    const s2 = JSON.stringify({
      type: "Application",
      children: [
        { type: "Button", accessibilityIdentifier: "btn-settings", label: "Settings — 1h ago" },
      ],
    });
    expect(strategy.identify(makeInput(s1))).toBe(strategy.identify(makeInput(s2)));
  });

  it("uses testId as stable key when accessibilityIdentifier is absent", () => {
    const s1 = JSON.stringify({
      type: "Application",
      children: [{ type: "Button", testId: "settings-btn", label: "Settings — 5 mins ago" }],
    });
    const s2 = JSON.stringify({
      type: "Application",
      children: [{ type: "Button", testId: "settings-btn", label: "Settings — 1 hour ago" }],
    });
    expect(strategy.identify(makeInput(s1))).toBe(strategy.identify(makeInput(s2)));
  });

  it("falls back to role when neither identifier nor label is present", () => {
    const noLabel = JSON.stringify({ type: "Application", children: [{ type: "Button" }] });
    expect(strategy.identify(makeInput(noLabel))).not.toMatch(/^degraded:/);
  });

  it("uses 'role' field when 'type' is absent (W3C a11y tree format)", () => {
    const withRole = JSON.stringify({
      role: "Application",
      children: [{ role: "button", label: "Settings" }],
    });
    expect(strategy.identify(makeInput(withRole))).not.toMatch(/^degraded:/);
  });

  it("uses 'Unknown' role when both type and role are absent", () => {
    const noRole = JSON.stringify({ label: "content", children: [{ label: "child" }] });
    expect(strategy.identify(makeInput(noRole))).not.toMatch(/^degraded:/);
  });
});

describe("A11ySignatureStrategy — content-only leaf handling", () => {
  const strategy = new A11ySignatureStrategy();

  it("keeps a StaticText with accessibilityIdentifier (structurally meaningful)", () => {
    const s = JSON.stringify({
      type: "Application",
      children: [{ type: "StaticText", accessibilityIdentifier: "hero-title", label: "Welcome" }],
    });
    expect(strategy.identify(makeInput(s))).not.toMatch(/^degraded:/);
  });

  it("keeps a StaticText with testId (structurally meaningful)", () => {
    const s = JSON.stringify({
      type: "Application",
      children: [{ type: "StaticText", testId: "hero-title-test", label: "Welcome" }],
    });
    expect(strategy.identify(makeInput(s))).not.toMatch(/^degraded:/);
  });
});

// ---------------------------------------------------------------------------
// Depth bounding
// ---------------------------------------------------------------------------

describe("A11ySignatureStrategy — depth bounding", () => {
  const strategy = new A11ySignatureStrategy();

  it("identical trees at the same depth produce the same identity", () => {
    const tree1 = JSON.stringify({ type: "Application", children: [nestDeep(SHALLOW_NEST_DEPTH)] });
    const tree2 = JSON.stringify({ type: "Application", children: [nestDeep(SHALLOW_NEST_DEPTH)] });
    expect(strategy.identify(makeInput(tree1))).toBe(strategy.identify(makeInput(tree2)));
  });

  it("deeply nested tree produces a valid (non-degraded) identity", () => {
    const deep = JSON.stringify({ type: "Application", children: [nestDeep(DEEP_NEST_DEPTH)] });
    const id = strategy.identify(makeInput(deep));
    expect(id).not.toMatch(/^degraded:/);
  });
});

// ---------------------------------------------------------------------------
// Platform + optional E3 fields
// ---------------------------------------------------------------------------

describe("A11ySignatureStrategy — platform + optional E3 fields", () => {
  const strategy = new A11ySignatureStrategy();

  it("accepts android platform without error", () => {
    const id = strategy.identify({ a11ySnapshot: snap(HOME_SCREEN_JSON), platform: "android" });
    expect(id).not.toMatch(/^degraded:/);
  });

  it("ignores screenEmbedding — same a11y tree produces same id regardless", () => {
    const withEmbedding = strategy.identify({
      a11ySnapshot: snap(HOME_SCREEN_JSON),
      platform: IOS,
      screenEmbedding: SAMPLE_EMBED,
    });
    const withoutEmbedding = strategy.identify({
      a11ySnapshot: snap(HOME_SCREEN_JSON),
      platform: IOS,
    });
    expect(withEmbedding).toBe(withoutEmbedding);
  });

  it("ignores semanticLabel — same a11y tree produces same id regardless", () => {
    const withLabel = strategy.identify({
      a11ySnapshot: snap(HOME_SCREEN_JSON),
      platform: IOS,
      semanticLabel: "Home Screen",
    });
    const withoutLabel = strategy.identify({
      a11ySnapshot: snap(HOME_SCREEN_JSON),
      platform: IOS,
    });
    expect(withLabel).toBe(withoutLabel);
  });
});

// ---------------------------------------------------------------------------
// CompositeStateIdentityStrategy — AC4 (Open/Closed / DI seam)
// ---------------------------------------------------------------------------

describe("CompositeStateIdentityStrategy — DI / Open-Closed (AC4)", () => {
  it("delegates to the primary strategy", () => {
    const primary = new A11ySignatureStrategy();
    const composite = new CompositeStateIdentityStrategy(primary);
    const input = makeInput(HOME_SCREEN_JSON);
    expect(composite.identify(input)).toBe(primary.identify(input));
  });

  it("allows a stub/alternative primary strategy (AC4: Open/Closed verified)", () => {
    const stubId = "stub-identity-abc" as StateIdentity;
    const stub: StateIdentityStrategy = {
      identify: (_input: StateIdentityInput) => stubId,
    };
    const composite = new CompositeStateIdentityStrategy(stub);
    expect(composite.identify(makeInput(HOME_SCREEN_JSON))).toBe(stubId);
  });

  it("can replace default strategy without crawl-loop code change (DI contract)", () => {
    let callCount = 0;
    const countingStub: StateIdentityStrategy = {
      identify: (_input: StateIdentityInput): StateIdentity => {
        callCount++;
        return `counted-${String(callCount)}` as StateIdentity;
      },
    };
    const composite = new CompositeStateIdentityStrategy(countingStub);
    const id1 = composite.identify(makeInput(HOME_SCREEN_JSON));
    const id2 = composite.identify(makeInput(SETTINGS_SCREEN_JSON));
    expect(callCount).toBe(STUB_CALL_EXPECTED);
    expect(id1).toBe("counted-1");
    expect(id2).toBe("counted-2");
  });

  it("returns degraded identity when primary strategy returns it", () => {
    const fakeHash = "0".repeat(SHA256_HEX_LENGTH);
    const degradingStub: StateIdentityStrategy = {
      identify: (_input: StateIdentityInput): StateIdentity =>
        `degraded:${fakeHash}` as StateIdentity,
    };
    const composite = new CompositeStateIdentityStrategy(degradingStub);
    expect(composite.identify(makeInput(""))).toMatch(/^degraded:/);
  });
});
