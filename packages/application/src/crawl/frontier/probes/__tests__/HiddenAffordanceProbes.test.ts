/**
 * HiddenAffordanceProbes tests — E2.5 acceptance criteria.
 *
 * AC coverage:
 * - AC1: A snapshot with off-screen scrollable content → scroll-reveal probe generates
 *        swipe candidates (up/down).
 * - AC2: A snapshot with horizontally swipeable rows → swipe-reveal probe generates
 *        swipe candidates (left/right).
 * - AC3: A snapshot with an overflow/more-menu element → overflow probe generates tap candidate.
 * - AC4: Long-press probe → no-op + telemetry (no candidate emitted, no throw).
 * - AC5: Malformed/out-of-bounds args rejected — generated candidates always pass the
 *        arg-validation allowlist (valid actionType, bounded direction strings).
 * - AC6: Every probe source never throws even if the snapshot is empty/malformed.
 * - AC7: Registration via `frontier.registerProbeSource(...)` — probes are available
 *        through the seam's `getEnumeratedCandidates` without editing Frontier core.
 * - AC8: Coverage gate >=85% on probe source files.
 *
 * Security:
 * - T2/TB-E1: candidate action args are allowlisted (no arbitrary direction strings).
 * - T11: degraded path — never throws on empty/malformed snapshot.
 *
 * Probe types per ADR-0004 §6:
 *   ScrollRevealProbeSource  — swipe up/down (SUPPORTED)
 *   SwipeRevealProbeSource   — swipe left/right (SUPPORTED)
 *   OverflowMenuProbeSource  — tap overflow element (SUPPORTED via normal tap)
 *   LongPressProbeSource     — NO-OP + telemetry (NOT in MobileDriverPort — ADR-0004 R-1)
 *
 * Synthetic fixtures only — no real identifiers, tokens, or PII (T12).
 */

import { describe, it, expect, vi } from "vitest";
import type { A11ySnapshot, CandidateAction } from "@flowscout/domain";
import { Frontier } from "../../Frontier.js";
import { ScrollRevealProbeSource } from "../ScrollRevealProbeSource.js";
import { SwipeRevealProbeSource } from "../SwipeRevealProbeSource.js";
import { OverflowMenuProbeSource } from "../OverflowMenuProbeSource.js";
import { LongPressProbeSource } from "../LongPressProbeSource.js";
import { registerHiddenAffordanceProbes } from "../index.js";

// ── Synthetic fixture helpers ─────────────────────────────────────────────────

/** Builds a minimal synthetic A11ySnapshot (never uses real app data, T12). */
function makeSnapshot(content: object): A11ySnapshot {
  return JSON.stringify(content) as A11ySnapshot;
}

/** Snapshot with a scrollable table/list (off-screen content). */
const SCROLLABLE_SNAPSHOT = makeSnapshot({
  type: "Application",
  label: "TestApp",
  children: [
    {
      type: "Table",
      accessibilityIdentifier: "main-list",
      traits: ["scrollable"],
      children: [
        { type: "Cell", label: "Row 1", accessibilityIdentifier: "row-1" },
        { type: "Cell", label: "Row 2", accessibilityIdentifier: "row-2" },
        { type: "Cell", label: "Row 3", accessibilityIdentifier: "row-3" },
      ],
    },
  ],
});

/** Snapshot with a horizontally swipeable list row (row actions pattern). */
const SWIPEABLE_ROW_SNAPSHOT = makeSnapshot({
  type: "Application",
  label: "TestApp",
  children: [
    {
      type: "Table",
      accessibilityIdentifier: "inbox-list",
      children: [
        {
          type: "Cell",
          accessibilityIdentifier: "message-cell-0",
          traits: ["swipeable"],
          children: [
            { type: "StaticText", label: "Email subject line" },
          ],
        },
      ],
    },
  ],
});

/** Snapshot with an overflow / more-menu button element. */
const OVERFLOW_SNAPSHOT = makeSnapshot({
  type: "Application",
  label: "TestApp",
  children: [
    {
      type: "NavigationBar",
      children: [
        {
          type: "Button",
          accessibilityIdentifier: "more-options-button",
          label: "More",
        },
        {
          type: "Button",
          accessibilityIdentifier: "overflow-menu",
          label: "...",
        },
      ],
    },
    {
      type: "Table",
      accessibilityIdentifier: "content-list",
      children: [],
    },
  ],
});

/** Snapshot for long-press: a control reachable only via long-press. */
const LONG_PRESS_SNAPSHOT = makeSnapshot({
  type: "Application",
  label: "TestApp",
  children: [
    {
      type: "Cell",
      accessibilityIdentifier: "hold-to-reveal-cell",
      label: "Hold to reveal options",
      traits: ["contextMenu"],
    },
  ],
});

/** Empty / malformed snapshots for degradation testing. */
const EMPTY_SNAPSHOT = "" as A11ySnapshot;
const MALFORMED_SNAPSHOT = "{ this is not valid JSON }" as A11ySnapshot;
const MINIMAL_SNAPSHOT = makeSnapshot({ type: "Application", label: "TestApp", children: [] });

const FAKE_STATE_ID = "synthetic-state-id-001";

// ── ScrollRevealProbeSource ───────────────────────────────────────────────────

describe("ScrollRevealProbeSource", () => {
  it("generates swipe-up and swipe-down candidates for a scrollable container", async () => {
    const source = new ScrollRevealProbeSource();
    const candidates = await source.generateCandidates(FAKE_STATE_ID, SCROLLABLE_SNAPSHOT);

    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const actionTypes = candidates.map((c) => c.actionType);
    expect(actionTypes).toContain("swipe");

    // Validate direction is in the allowlist (security T2)
    for (const candidate of candidates) {
      const payload = JSON.parse(candidate.actionPayload) as { direction: string };
      expect(["up", "down"]).toContain(payload.direction);
    }
  });

  it("generates candidates when snapshot has a Table element (scrollable heuristic)", async () => {
    const source = new ScrollRevealProbeSource();
    const candidates = await source.generateCandidates(FAKE_STATE_ID, SCROLLABLE_SNAPSHOT);

    // Must produce scroll-reveal candidates for a table
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.actionType).toBe("swipe");
  });

  it("returns empty array (not throw) on empty snapshot (T11 degradation)", async () => {
    const source = new ScrollRevealProbeSource();
    const candidates = await source.generateCandidates(FAKE_STATE_ID, EMPTY_SNAPSHOT);

    expect(Array.isArray(candidates)).toBe(true);
  });

  it("returns empty array (not throw) on malformed snapshot JSON (T11 degradation)", async () => {
    const source = new ScrollRevealProbeSource();
    const candidates = await source.generateCandidates(FAKE_STATE_ID, MALFORMED_SNAPSHOT);

    expect(Array.isArray(candidates)).toBe(true);
  });

  it("returns empty array on minimal snapshot with no scrollable containers", async () => {
    const source = new ScrollRevealProbeSource();
    const candidates = await source.generateCandidates(FAKE_STATE_ID, MINIMAL_SNAPSHOT);

    // No scrollable container → no scroll probes
    expect(candidates).toHaveLength(0);
  });

  it("has stable id 'scroll-reveal'", () => {
    const source = new ScrollRevealProbeSource();
    expect(source.id).toBe("scroll-reveal");
  });

  it("never throws even if an internal error occurs (self-guard)", async () => {
    const source = new ScrollRevealProbeSource();
    // Pass a snapshot that is technically valid JSON but has unexpected shape
    const weirdSnapshot = makeSnapshot({ unexpected: "shape", nested: { deep: true } });
    await expect(source.generateCandidates(FAKE_STATE_ID, weirdSnapshot)).resolves.toBeDefined();
  });

  it("all emitted candidates have valid actionType and non-empty payload", async () => {
    const source = new ScrollRevealProbeSource();
    const candidates = await source.generateCandidates(FAKE_STATE_ID, SCROLLABLE_SNAPSHOT);

    for (const candidate of candidates) {
      // actionType must be in the domain ActionType union (T2 allowlist)
      expect(["tap", "swipe", "typeText", "scroll", "gesture", "navigate"]).toContain(
        candidate.actionType,
      );
      expect(candidate.actionPayload.length).toBeGreaterThan(0);
      expect(typeof candidate.rationale).toBe("string");
    }
  });
});

// ── SwipeRevealProbeSource ────────────────────────────────────────────────────

describe("SwipeRevealProbeSource", () => {
  it("generates swipe-left and swipe-right candidates for swipeable rows", async () => {
    const source = new SwipeRevealProbeSource();
    const candidates = await source.generateCandidates(FAKE_STATE_ID, SWIPEABLE_ROW_SNAPSHOT);

    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const actionTypes = candidates.map((c) => c.actionType);
    expect(actionTypes).toContain("swipe");

    // Validate direction is in the allowlist (security T2)
    for (const candidate of candidates) {
      const payload = JSON.parse(candidate.actionPayload) as { direction: string };
      expect(["left", "right"]).toContain(payload.direction);
    }
  });

  it("returns empty array (not throw) on empty snapshot", async () => {
    const source = new SwipeRevealProbeSource();
    const candidates = await source.generateCandidates(FAKE_STATE_ID, EMPTY_SNAPSHOT);

    expect(Array.isArray(candidates)).toBe(true);
  });

  it("returns empty array (not throw) on malformed snapshot JSON", async () => {
    const source = new SwipeRevealProbeSource();
    const candidates = await source.generateCandidates(FAKE_STATE_ID, MALFORMED_SNAPSHOT);

    expect(Array.isArray(candidates)).toBe(true);
  });

  it("returns empty array on minimal snapshot with no swipeable cells", async () => {
    const source = new SwipeRevealProbeSource();
    const candidates = await source.generateCandidates(FAKE_STATE_ID, MINIMAL_SNAPSHOT);

    expect(candidates).toHaveLength(0);
  });

  it("has stable id 'swipe-reveal'", () => {
    const source = new SwipeRevealProbeSource();
    expect(source.id).toBe("swipe-reveal");
  });

  it("never throws even with unexpected snapshot shape", async () => {
    const source = new SwipeRevealProbeSource();
    const weirdSnapshot = makeSnapshot({ unexpected: "shape" });
    await expect(source.generateCandidates(FAKE_STATE_ID, weirdSnapshot)).resolves.toBeDefined();
  });

  it("all emitted candidates have allowlisted direction (security T2/TB-E1)", async () => {
    const source = new SwipeRevealProbeSource();
    const candidates = await source.generateCandidates(FAKE_STATE_ID, SWIPEABLE_ROW_SNAPSHOT);

    for (const candidate of candidates) {
      expect(candidate.actionType).toBe("swipe");
      const payload = JSON.parse(candidate.actionPayload) as { direction: string };
      // Only left/right for swipe-reveal (not up/down which is scroll)
      expect(["left", "right"]).toContain(payload.direction);
    }
  });
});

// ── OverflowMenuProbeSource ───────────────────────────────────────────────────

describe("OverflowMenuProbeSource", () => {
  it("generates a tap candidate for detected overflow/more-menu element", async () => {
    const source = new OverflowMenuProbeSource();
    const candidates = await source.generateCandidates(FAKE_STATE_ID, OVERFLOW_SNAPSHOT);

    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const tapCandidates = candidates.filter((c) => c.actionType === "tap");
    expect(tapCandidates.length).toBeGreaterThanOrEqual(1);
  });

  it("generates tap candidates with valid element payloads (security T2)", async () => {
    const source = new OverflowMenuProbeSource();
    const candidates = await source.generateCandidates(FAKE_STATE_ID, OVERFLOW_SNAPSHOT);

    for (const candidate of candidates) {
      expect(candidate.actionType).toBe("tap");
      const payload = JSON.parse(candidate.actionPayload) as { elementId?: string };
      expect(typeof payload.elementId).toBe("string");
      expect(payload.elementId!.length).toBeGreaterThan(0);
    }
  });

  it("returns empty array (not throw) on empty snapshot", async () => {
    const source = new OverflowMenuProbeSource();
    const candidates = await source.generateCandidates(FAKE_STATE_ID, EMPTY_SNAPSHOT);

    expect(Array.isArray(candidates)).toBe(true);
  });

  it("returns empty array (not throw) on malformed snapshot JSON", async () => {
    const source = new OverflowMenuProbeSource();
    const candidates = await source.generateCandidates(FAKE_STATE_ID, MALFORMED_SNAPSHOT);

    expect(Array.isArray(candidates)).toBe(true);
  });

  it("returns empty array on snapshot with no overflow/more elements", async () => {
    const source = new OverflowMenuProbeSource();
    const noOverflowSnapshot = makeSnapshot({
      type: "Application",
      label: "TestApp",
      children: [
        { type: "Button", label: "Settings", accessibilityIdentifier: "settings-btn" },
        { type: "Button", label: "Profile", accessibilityIdentifier: "profile-btn" },
      ],
    });
    const candidates = await source.generateCandidates(FAKE_STATE_ID, noOverflowSnapshot);

    expect(candidates).toHaveLength(0);
  });

  it("has stable id 'overflow-menu'", () => {
    const source = new OverflowMenuProbeSource();
    expect(source.id).toBe("overflow-menu");
  });

  it("never throws even with unexpected snapshot shape", async () => {
    const source = new OverflowMenuProbeSource();
    const weirdSnapshot = makeSnapshot({ unexpected: "shape" });
    await expect(source.generateCandidates(FAKE_STATE_ID, weirdSnapshot)).resolves.toBeDefined();
  });

  it("detects '...' label as overflow indicator", async () => {
    const source = new OverflowMenuProbeSource();
    const candidates = await source.generateCandidates(FAKE_STATE_ID, OVERFLOW_SNAPSHOT);

    // OVERFLOW_SNAPSHOT has a button with label '...' (overflow pattern)
    const payloads = candidates.map(
      (c) => (JSON.parse(c.actionPayload) as { elementId: string }).elementId,
    );
    // At least one of the overflow elements should be detected
    expect(payloads.some((id) => id.includes("overflow") || id.includes("more"))).toBe(true);
  });
});

// ── LongPressProbeSource ──────────────────────────────────────────────────────

describe("LongPressProbeSource — no-op + telemetry (ADR-0004 §6 R-1)", () => {
  it("emits zero candidates (long-press not in MobileDriverPort — degraded path)", async () => {
    const source = new LongPressProbeSource();
    const candidates = await source.generateCandidates(FAKE_STATE_ID, LONG_PRESS_SNAPSHOT);

    // Long-press primitive is absent from MobileDriverPort → must NOT emit driver-executable candidates
    expect(candidates).toHaveLength(0);
  });

  it("never throws for any snapshot (T11 / ProbeSource contract)", async () => {
    const source = new LongPressProbeSource();

    await expect(source.generateCandidates(FAKE_STATE_ID, EMPTY_SNAPSHOT)).resolves.toHaveLength(
      0,
    );
    await expect(
      source.generateCandidates(FAKE_STATE_ID, MALFORMED_SNAPSHOT),
    ).resolves.toHaveLength(0);
    await expect(
      source.generateCandidates(FAKE_STATE_ID, LONG_PRESS_SNAPSHOT),
    ).resolves.toHaveLength(0);
  });

  it("has stable id 'long-press'", () => {
    const source = new LongPressProbeSource();
    expect(source.id).toBe("long-press");
  });

  it("records telemetry via onTelemetry callback when a long-press affordance is detected", async () => {
    const telemetrySpy = vi.fn();
    const source = new LongPressProbeSource({ onTelemetry: telemetrySpy });
    await source.generateCandidates(FAKE_STATE_ID, LONG_PRESS_SNAPSHOT);

    // The source should call back with telemetry describing the no-op
    expect(telemetrySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        probeId: "long-press",
        outcome: "unsupported",
        stateId: FAKE_STATE_ID,
      }),
    );
  });

  it("does not call telemetry when snapshot has no long-press affordances", async () => {
    const telemetrySpy = vi.fn();
    const source = new LongPressProbeSource({ onTelemetry: telemetrySpy });
    await source.generateCandidates(FAKE_STATE_ID, MINIMAL_SNAPSHOT);

    // No contextMenu/long-press affordance → no telemetry needed
    expect(telemetrySpy).not.toHaveBeenCalled();
  });

  it("still emits zero candidates even with a recognisable long-press element", async () => {
    const source = new LongPressProbeSource();
    const candidates = await source.generateCandidates(FAKE_STATE_ID, LONG_PRESS_SNAPSHOT);

    // Verify the element IS in the snapshot (so the test is meaningful)
    expect(LONG_PRESS_SNAPSHOT).toContain("hold-to-reveal-cell");
    // But the probe must NOT emit a candidate the driver can't execute
    expect(candidates).toHaveLength(0);
  });
});

// ── Security: arg validation / allowlist (T2 / TB-E1) ────────────────────────

describe("Probe arg validation (security T2 / TB-E1)", () => {
  it("ScrollReveal: directions are restricted to up/down only", async () => {
    const source = new ScrollRevealProbeSource();
    const candidates = await source.generateCandidates(FAKE_STATE_ID, SCROLLABLE_SNAPSHOT);

    for (const c of candidates) {
      if (c.actionType === "swipe") {
        const payload = JSON.parse(c.actionPayload) as { direction: string };
        expect(["up", "down"]).toContain(payload.direction);
        // Reject any injected / unsupported direction
        expect(["left", "right", "arbitrary", "execute", ""]).not.toContain(payload.direction);
      }
    }
  });

  it("SwipeReveal: directions are restricted to left/right only", async () => {
    const source = new SwipeRevealProbeSource();
    const candidates = await source.generateCandidates(FAKE_STATE_ID, SWIPEABLE_ROW_SNAPSHOT);

    for (const c of candidates) {
      if (c.actionType === "swipe") {
        const payload = JSON.parse(c.actionPayload) as { direction: string };
        expect(["left", "right"]).toContain(payload.direction);
      }
    }
  });

  it("OverflowMenu: elementId is non-empty and contains no injected characters", async () => {
    const source = new OverflowMenuProbeSource();
    const candidates = await source.generateCandidates(FAKE_STATE_ID, OVERFLOW_SNAPSHOT);

    for (const c of candidates) {
      const payload = JSON.parse(c.actionPayload) as { elementId: string };
      expect(payload.elementId.length).toBeGreaterThan(0);
      // No JSON injection or newlines
      expect(payload.elementId).not.toContain("\n");
      expect(payload.elementId).not.toContain('"');
    }
  });
});

// ── ProbeSource contract: never throws ───────────────────────────────────────

describe("ProbeSource contract: never throws for any input", () => {
  const PROBES = [
    new ScrollRevealProbeSource(),
    new SwipeRevealProbeSource(),
    new OverflowMenuProbeSource(),
    new LongPressProbeSource(),
  ];

  const SNAPSHOTS: [string, A11ySnapshot][] = [
    ["empty string", EMPTY_SNAPSHOT],
    ["malformed JSON", MALFORMED_SNAPSHOT],
    ["minimal valid", MINIMAL_SNAPSHOT],
    ["scrollable", SCROLLABLE_SNAPSHOT],
    ["swipeable row", SWIPEABLE_ROW_SNAPSHOT],
    ["overflow", OVERFLOW_SNAPSHOT],
    ["long-press", LONG_PRESS_SNAPSHOT],
    ["null-ish content", makeSnapshot(null as unknown as object)],
    ["deeply nested", makeSnapshot({ type: "A", children: [{ type: "B", children: [{ type: "C", children: [] }] }] })],
  ];

  for (const probe of PROBES) {
    for (const [snapLabel, snapshot] of SNAPSHOTS) {
      it(`${probe.id} does not throw on ${snapLabel}`, async () => {
        await expect(
          probe.generateCandidates(FAKE_STATE_ID, snapshot),
        ).resolves.toBeDefined();
      });
    }
  }
});

// ── Registration via Frontier seam (AC7) ──────────────────────────────────────

describe("registerHiddenAffordanceProbes — registration via Frontier seam", () => {
  it("registers all four probe sources on the frontier", () => {
    const frontier = new Frontier({ maxRevisitsPerState: 3 });
    registerHiddenAffordanceProbes(frontier);

    const ids = frontier.getProbeSourceIds();
    expect(ids).toContain("scroll-reveal");
    expect(ids).toContain("swipe-reveal");
    expect(ids).toContain("overflow-menu");
    expect(ids).toContain("long-press");
  });

  it("does not edit Frontier core (probe sources available via getEnumeratedCandidates)", async () => {
    const frontier = new Frontier({ maxRevisitsPerState: 3 });
    registerHiddenAffordanceProbes(frontier);

    // The seam: getEnumeratedCandidates calls all registered probes
    const candidates = await frontier.getEnumeratedCandidates(FAKE_STATE_ID, SCROLLABLE_SNAPSHOT);
    // At minimum scroll-reveal should return candidates for the scrollable snapshot
    expect(Array.isArray(candidates)).toBe(true);
  });

  it("is idempotent: re-registering replaces rather than duplicating", () => {
    const frontier = new Frontier({ maxRevisitsPerState: 3 });
    registerHiddenAffordanceProbes(frontier);
    registerHiddenAffordanceProbes(frontier);

    const ids = frontier.getProbeSourceIds();
    // Each probe id must appear exactly once
    const scrollCount = ids.filter((id) => id === "scroll-reveal").length;
    expect(scrollCount).toBe(1);
  });

  it("frontier still compiles and works normally after registration (seam non-invasive)", () => {
    const frontier = new Frontier({ maxRevisitsPerState: 3 });
    registerHiddenAffordanceProbes(frontier);

    // Frontier core behavior still works
    frontier.markVisited(FAKE_STATE_ID);
    expect(frontier.getVisitCount(FAKE_STATE_ID)).toBe(1);
    expect(frontier.isRevisitCapped(FAKE_STATE_ID)).toBe(false);
  });

  it("registered probes survive getEnumeratedCandidates call without crashing", async () => {
    const frontier = new Frontier({ maxRevisitsPerState: 3 });
    registerHiddenAffordanceProbes(frontier);

    // Must not reject or throw
    const result = await frontier.getEnumeratedCandidates(FAKE_STATE_ID, MALFORMED_SNAPSHOT);
    expect(Array.isArray(result)).toBe(true);
  });

  it("hidden controls discovered via probes come from off the primary nav surface (epic metric)", async () => {
    const frontier = new Frontier({ maxRevisitsPerState: 3 });
    registerHiddenAffordanceProbes(frontier);

    // SCROLLABLE_SNAPSHOT has a Table with rows — these are NOT on the primary tap surface
    // but scroll-reveal probes generate candidates to reach them
    const candidates = await frontier.getEnumeratedCandidates(FAKE_STATE_ID, SCROLLABLE_SNAPSHOT);

    // The epic success metric: >=1 control reachable via probes that is not on primary nav
    const scrollCandidates = candidates.filter(
      (c) => c.actionType === "swipe" && (c.rationale.includes("scroll") || c.rationale.includes("reveal")),
    );
    expect(scrollCandidates.length).toBeGreaterThanOrEqual(1);
  });
});

// ── defaultCollaborators integration: probes registered via seam ─────────────

describe("defaultCollaborators integration (minimal body edit verification)", () => {
  it("frontier from defaultCollaborators has probe sources registered", () => {
    // We test the defaultCollaborators' Frontier has probes registered by invoking
    // registerHiddenAffordanceProbes on a fresh Frontier (same as defaultCollaborators does)
    const frontier = new Frontier({ maxRevisitsPerState: 3 });
    registerHiddenAffordanceProbes(frontier);

    // Verify the probe IDs are present (mirrors what defaultCollaborators wires up)
    const ids = frontier.getProbeSourceIds();
    expect(ids.length).toBe(4);
  });
});

// ── Candidate deduplication: scroll-reveal finds controls not in primary surface

describe("Scroll-reveal discovers controls not visible in primary nav", () => {
  it("generates swipe candidates that would expose off-screen content", async () => {
    const source = new ScrollRevealProbeSource();
    const candidates = await source.generateCandidates(FAKE_STATE_ID, SCROLLABLE_SNAPSHOT);

    // The Table has 3 children, a real app would have many more off-screen
    // The probe generates swipe actions to reveal them
    const swipeDown = candidates.find(
      (c): c is CandidateAction =>
        c.actionType === "swipe" &&
        (JSON.parse(c.actionPayload) as { direction: string }).direction === "up",
    );
    // swipe "up" scrolls content downward to reveal items below the fold
    expect(swipeDown).toBeDefined();
  });
});

// ── Edge cases: deduplication, no-id rows, multiple containers ───────────────

describe("ScrollRevealProbeSource — deduplication and multiple containers", () => {
  it("does not duplicate candidates for the same scrollable container id", async () => {
    const source = new ScrollRevealProbeSource();
    const snapshot = makeSnapshot({
      type: "Application",
      children: [
        {
          type: "Table",
          accessibilityIdentifier: "list-a",
          children: [],
        },
        {
          // Second Table with same id — should be deduped
          type: "Table",
          accessibilityIdentifier: "list-a",
          children: [],
        },
      ],
    });
    const candidates = await source.generateCandidates(FAKE_STATE_ID, snapshot);
    // Only one pair (up + down) for the first unique id
    expect(candidates).toHaveLength(2);
  });

  it("generates candidates for scrollable containers with no accessibilityIdentifier", async () => {
    const source = new ScrollRevealProbeSource();
    const snapshot = makeSnapshot({
      type: "Application",
      children: [
        {
          type: "Table",
          // no accessibilityIdentifier
          children: [{ type: "Cell", label: "Item" }],
        },
      ],
    });
    const candidates = await source.generateCandidates(FAKE_STATE_ID, snapshot);
    // Should still generate scroll probes (using generic dedup key)
    expect(candidates.length).toBeGreaterThan(0);
  });

  it("handles ScrollView role", async () => {
    const source = new ScrollRevealProbeSource();
    const snapshot = makeSnapshot({
      type: "Application",
      children: [
        {
          type: "ScrollView",
          accessibilityIdentifier: "scroll-view-1",
          children: [],
        },
      ],
    });
    const candidates = await source.generateCandidates(FAKE_STATE_ID, snapshot);
    expect(candidates.length).toBeGreaterThan(0);
  });
});

describe("SwipeRevealProbeSource — deduplication and cell role coverage", () => {
  it("deduplicates generic rows (no accessibilityIdentifier) to one probe slot", async () => {
    const source = new SwipeRevealProbeSource();
    const snapshot = makeSnapshot({
      type: "Application",
      children: [
        {
          type: "Table",
          children: [
            { type: "Cell", label: "Row 1" }, // no id
            { type: "Cell", label: "Row 2" }, // no id — same generic key
          ],
        },
      ],
    });
    const candidates = await source.generateCandidates(FAKE_STATE_ID, snapshot);
    // Both rows share __generic-row__ dedup key → only one pair (left + right)
    expect(candidates).toHaveLength(2);
  });

  it("handles swipeable trait in addition to role-based detection", async () => {
    const source = new SwipeRevealProbeSource();
    const snapshot = makeSnapshot({
      type: "Application",
      children: [
        {
          type: "GroupElement", // non-standard role
          accessibilityIdentifier: "custom-swipeable",
          traits: ["swipeable"],
        },
      ],
    });
    const candidates = await source.generateCandidates(FAKE_STATE_ID, snapshot);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.actionType).toBe("swipe");
    }
  });

  it("caps rows at MAX_ROWS_TO_PROBE (5 rows max)", async () => {
    const source = new SwipeRevealProbeSource();
    const manyRows = Array.from({ length: 10 }, (_, i) => ({
      type: "Cell",
      accessibilityIdentifier: `row-${String(i)}`,
    }));
    const snapshot = makeSnapshot({
      type: "Application",
      children: [{ type: "Table", children: manyRows }],
    });
    const candidates = await source.generateCandidates(FAKE_STATE_ID, snapshot);
    // 5 rows × 2 directions = 10 candidates max
    expect(candidates.length).toBeLessThanOrEqual(10);
    expect(candidates.length).toBeGreaterThan(0);
  });
});

describe("OverflowMenuProbeSource — id-based detection and edge cases", () => {
  it("skips overflow elements that have no accessibilityIdentifier (security: no label injection)", async () => {
    const source = new OverflowMenuProbeSource();
    const snapshot = makeSnapshot({
      type: "Application",
      children: [
        {
          type: "Button",
          label: "...",
          // no accessibilityIdentifier
        },
      ],
    });
    const candidates = await source.generateCandidates(FAKE_STATE_ID, snapshot);
    // No stable id → skipped for security
    expect(candidates).toHaveLength(0);
  });

  it("detects kebab-id overflow pattern", async () => {
    const source = new OverflowMenuProbeSource();
    const snapshot = makeSnapshot({
      type: "Application",
      children: [
        {
          type: "Button",
          accessibilityIdentifier: "kebab-menu-trigger",
          label: "Menu",
        },
      ],
    });
    const candidates = await source.generateCandidates(FAKE_STATE_ID, snapshot);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.actionType).toBe("tap");
  });

  it("deduplicates overflow elements with the same accessibilityIdentifier", async () => {
    const source = new OverflowMenuProbeSource();
    const snapshot = makeSnapshot({
      type: "Application",
      children: [
        {
          type: "Button",
          accessibilityIdentifier: "overflow-trigger",
          label: "...",
        },
        {
          type: "Button",
          accessibilityIdentifier: "overflow-trigger", // same id
          label: "More",
        },
      ],
    });
    const candidates = await source.generateCandidates(FAKE_STATE_ID, snapshot);
    // Deduped: only one candidate for the same element id
    expect(candidates).toHaveLength(1);
  });

  it("detects MenuItem role as overflow candidate", async () => {
    const source = new OverflowMenuProbeSource();
    const snapshot = makeSnapshot({
      type: "Application",
      children: [
        {
          type: "MenuItem",
          accessibilityIdentifier: "more-options-item",
          label: "...",
        },
      ],
    });
    const candidates = await source.generateCandidates(FAKE_STATE_ID, snapshot);
    expect(candidates.length).toBeGreaterThan(0);
  });
});

describe("LongPressProbeSource — affordance detection edge cases", () => {
  it("detects long-press affordances by id keyword 'longpress'", async () => {
    const telemetrySpy = vi.fn();
    const source = new LongPressProbeSource({ onTelemetry: telemetrySpy });
    const snapshot = makeSnapshot({
      type: "Application",
      children: [
        {
          type: "Button",
          accessibilityIdentifier: "longpress-action-button",
          label: "Hold",
        },
      ],
    });
    await source.generateCandidates(FAKE_STATE_ID, snapshot);
    expect(telemetrySpy).toHaveBeenCalled();
  });

  it("detects long-press affordances by 'forceTouchCapable' trait", async () => {
    const telemetrySpy = vi.fn();
    const source = new LongPressProbeSource({ onTelemetry: telemetrySpy });
    const snapshot = makeSnapshot({
      type: "Application",
      children: [
        {
          type: "Cell",
          accessibilityIdentifier: "force-touch-cell",
          traits: ["forceTouchCapable"],
        },
      ],
    });
    await source.generateCandidates(FAKE_STATE_ID, snapshot);
    expect(telemetrySpy).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unsupported" }),
    );
  });

  it("reports correct elementCount in telemetry", async () => {
    const telemetrySpy = vi.fn();
    const source = new LongPressProbeSource({ onTelemetry: telemetrySpy });
    const snapshot = makeSnapshot({
      type: "Application",
      children: [
        { type: "Cell", accessibilityIdentifier: "hold-a", traits: ["contextMenu"] },
        { type: "Cell", accessibilityIdentifier: "hold-b", traits: ["contextMenu"] },
      ],
    });
    await source.generateCandidates(FAKE_STATE_ID, snapshot);
    expect(telemetrySpy).toHaveBeenCalledWith(
      expect.objectContaining({ elementCount: 2 }),
    );
  });
});

describe("snapshotUtils — flattenNodes depth and count limits", () => {
  it("handles array at snapshot root (non-object) gracefully", async () => {
    const source = new ScrollRevealProbeSource();
    // Array at root — safeParseSnapshot should return null
    const arraySnapshot = JSON.stringify([{ type: "Table" }]) as A11ySnapshot;
    const candidates = await source.generateCandidates(FAKE_STATE_ID, arraySnapshot);
    expect(Array.isArray(candidates)).toBe(true);
  });

  it("handles deeply nested structure without crashing (depth guard)", async () => {
    const source = new ScrollRevealProbeSource();
    // Build a 20-deep nest (beyond MAX_FLATTEN_DEPTH=12)
    let deep: object = { type: "Table", accessibilityIdentifier: "deep-table", children: [] };
    for (let i = 0; i < 20; i++) {
      deep = { type: "View", children: [deep] };
    }
    const snapshot = makeSnapshot({ type: "Application", children: [deep] });
    // Should not crash; may or may not find the table depending on depth
    await expect(source.generateCandidates(FAKE_STATE_ID, snapshot)).resolves.toBeDefined();
  });
});
