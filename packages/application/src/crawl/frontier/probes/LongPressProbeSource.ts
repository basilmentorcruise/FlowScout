/**
 * LongPressProbeSource — E2.5 (#35) — DEGRADED NO-OP + TELEMETRY.
 *
 * Long-press is a hidden-affordance probe type that would reveal context menus and
 * drag-reorder affordances in iOS apps. However, `MobileDriverPort` (E1) has NO
 * `longPress` / `gesture` primitive — the port exposes only `tap`, `typeText`, and `swipe`.
 *
 * Per ADR-0004 §6 (OQ5 / R-1):
 *   "The long-press probe in #35 is implemented as the degraded path against the real
 *    driver (no-op + telemetry), AND the FakeMobileDriver fixture models a long-press
 *    affordance so the probe-generation + recording logic is fully unit-tested."
 *
 * This means:
 * - `generateCandidates` returns [] (zero candidates) — nothing is emitted that the
 *   driver cannot execute (security T2/TB-E1).
 * - If long-press affordances are detected in the snapshot, the probe calls
 *   `onTelemetry` with `{ probeId, outcome:"unsupported", stateId, elementCount }`.
 * - The crawl continues without crashing or hanging (ProbeSource contract).
 *
 * When MobileDriverPort gains a `longPress` primitive (a separate E1 follow-up ticket,
 * tracked as ADR-0004 R-1), this implementation is the correct extension point:
 * replace the no-op body with actual candidate generation and remove the telemetry call.
 *
 * Security (T2/TB-E1):
 * - Zero candidates emitted — no action can reach the driver (safest outcome).
 * - No raw a11y body is logged (T7).
 *
 * ProbeSource contract:
 * - Never throws; always returns [].
 * - Port-only: no adapter/SDK imports (T10/NFR1).
 */
import type { A11ySnapshot, CandidateAction } from "@flowscout/domain";
import type { ProbeSource } from "../ProbeSource.js";
import { safeParseSnapshot, flattenNodes } from "./snapshotUtils.js";
import type { A11yNode } from "./snapshotUtils.js";

// ── Telemetry types ───────────────────────────────────────────────────────────

/** Telemetry payload emitted when a long-press affordance is detected but cannot be driven. */
export interface LongProbeTelemetry {
  /** Stable probe identifier. */
  readonly probeId: "long-press";
  /** Always "unsupported" for this probe (MobileDriverPort has no longPress primitive). */
  readonly outcome: "unsupported";
  /** The current state identity string, for correlation. */
  readonly stateId: string;
  /** Number of long-press affordance elements detected in the snapshot. */
  readonly elementCount: number;
}

/** Telemetry callback type. Implementations should forward to a structured logger or metric sink. */
export type TelemetryCallback = (telemetry: LongProbeTelemetry) => void;

/** Options for constructing a LongPressProbeSource. */
export interface LongPressProbeOptions {
  /**
   * Optional telemetry callback.
   * Called once per `generateCandidates` invocation when >=1 long-press affordance is detected.
   * Not called when no affordances are found (avoids noisy no-op calls).
   * Default: no-op.
   */
  readonly onTelemetry?: TelemetryCallback;
}

// ── Long-press affordance detection heuristics ────────────────────────────────

/**
 * Trait values that signal a long-press / context-menu affordance.
 * These are custom traits set in the app's accessibility declarations.
 */
const LONG_PRESS_TRAITS = new Set(["contextMenu", "longPress", "forceTouchCapable"]);

/**
 * Accessibility identifier substrings indicating a long-press target.
 * Checked via simple inclusion (never eval'd — T2).
 */
const LONG_PRESS_ID_KEYWORDS = ["long-press", "hold-to-reveal", "context-menu", "longpress"];

/** Returns true if the node declares a long-press / context-menu trait. */
function hasLongPressTrait(node: A11yNode): boolean {
  const traits = node.traits;
  if (!Array.isArray(traits)) return false;
  return traits.some((t) => typeof t === "string" && LONG_PRESS_TRAITS.has(t));
}

/** Returns true if the node's accessibilityIdentifier suggests a long-press target. */
function hasLongPressId(node: A11yNode): boolean {
  const id = (node.accessibilityIdentifier ?? "").toLowerCase();
  return id.length > 0 && LONG_PRESS_ID_KEYWORDS.some((kw) => id.includes(kw));
}

/** Returns true if the node is a detectable long-press affordance. */
function isLongPressAffordance(node: A11yNode): boolean {
  return hasLongPressTrait(node) || hasLongPressId(node);
}

// ── LongPressProbeSource ──────────────────────────────────────────────────────

/**
 * LongPressProbeSource — detects long-press affordances and emits telemetry only.
 *
 * This probe type is intentionally a no-op at the candidate level because
 * `MobileDriverPort` has no `longPress` primitive (ADR-0004 §6 OQ5/R-1).
 * It is registered on the Frontier so the architecture is complete and ready
 * for the E1 follow-up that adds the primitive.
 */
export class LongPressProbeSource implements ProbeSource {
  readonly id = "long-press";

  private readonly _onTelemetry: TelemetryCallback;

  constructor(options: LongPressProbeOptions = {}) {
    this._onTelemetry = options.onTelemetry ?? (() => undefined);
  }

  /**
   * Detects long-press affordances in the snapshot and emits telemetry.
   * Always returns [] — no candidates are emitted (the driver cannot execute this gesture).
   */
  generateCandidates(stateId: string, snapshot: A11ySnapshot): Promise<readonly CandidateAction[]> {
    try {
      const root = safeParseSnapshot(snapshot);
      if (root !== null) {
        const allNodes = flattenNodes(root);
        const longPressElements = allNodes.filter(isLongPressAffordance);

        if (longPressElements.length > 0) {
          // Emit telemetry: a long-press affordance exists but cannot be driven yet.
          // This is the "no-op + telemetry" pattern from ADR-0004 §6 / OQ5.
          this._onTelemetry({
            probeId: "long-press",
            outcome: "unsupported",
            stateId,
            elementCount: longPressElements.length,
          });
          // Intentional no-op: do NOT emit any CandidateAction.
          // The driver would crash or silently fail on an unsupported gesture (security T2).
        }
      }
    } catch {
      // ProbeSource contract: never throw (ADR-0004 §6 degradation rule).
    }

    // Always return [] — long-press is unsupported at the driver level.
    return Promise.resolve([]);
  }
}
