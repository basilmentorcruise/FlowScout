/**
 * OverflowMenuProbeSource — E2.5 (#35).
 *
 * Detects overflow / "more" menu elements in the a11y snapshot and generates a normal
 * `tap` candidate for each. Overflow menus are standard tappable elements that happen to
 * be visually small / unlabeled (e.g. "...", "⋮", "More", a three-dot button in a nav bar).
 * Because they are `Button` elements the driver can tap them like any other element.
 *
 * Driver primitive used: `MobileDriverPort.tap(udid, { kind:"element", elementId })` —
 * SUPPORTED (E1). This is a normal tap; overflow detection is the probe's contribution.
 *
 * Security (T2/TB-E1):
 * - `elementId` is extracted from the accessibility tree via `accessibilityIdentifier` —
 *   a stable, system-assigned attribute — NOT from user-visible label text.
 * - elementId is validated (non-empty string) before inclusion in the payload.
 * - No raw a11y body is logged (T7).
 *
 * ProbeSource contract:
 * - Never throws; on any error returns [].
 * - Port-only: no adapter/SDK imports (T10/NFR1).
 */
import type { A11ySnapshot, CandidateAction } from "@flowscout/domain";
import type { ProbeSource } from "../ProbeSource.js";
import { safeParseSnapshot, flattenNodes } from "./snapshotUtils.js";
import type { A11yNode } from "./snapshotUtils.js";

// ── Overflow detection heuristics ─────────────────────────────────────────────

/**
 * Label strings that signal an overflow / more-menu button.
 * Intentionally short and exact — no regex to avoid injection risk (T2).
 * These are compared case-insensitively after trimming.
 */
const OVERFLOW_LABELS = new Set(["...", "more", "⋮", "•••", "options"]);

/**
 * Accessibility identifier substrings that signal an overflow element.
 * Checked with simple inclusion tests, never evaluated (T2).
 */
const OVERFLOW_ID_KEYWORDS = ["overflow", "more-options", "more_options", "ellipsis", "kebab"];

/** Returns true if a node is a Button (the only type we tap for overflow). */
function isButton(node: A11yNode): boolean {
  const role = node.type ?? node.role ?? "";
  return role === "Button" || role === "MenuItem";
}

/** Returns true if the node's label string matches a known overflow pattern. */
function hasOverflowLabel(node: A11yNode): boolean {
  const rawLabel = (node.label ?? node.value ?? "").trim().toLowerCase();
  return OVERFLOW_LABELS.has(rawLabel);
}

/** Returns true if the node's accessibilityIdentifier contains an overflow keyword. */
function hasOverflowId(node: A11yNode): boolean {
  const id = (node.accessibilityIdentifier ?? "").toLowerCase();
  if (id.length === 0) return false;
  return OVERFLOW_ID_KEYWORDS.some((kw) => id.includes(kw));
}

/**
 * Returns true if the node is an overflow / more-menu element.
 * Detection order: identifier-based (stable) before label-based (volatile).
 */
function isOverflowElement(node: A11yNode): boolean {
  if (!isButton(node)) return false;
  return hasOverflowId(node) || hasOverflowLabel(node);
}

// ── Candidate builder ─────────────────────────────────────────────────────────

/**
 * Builds a tap candidate for an overflow element.
 *
 * Security: elementId is pre-validated (non-empty string from accessibilityIdentifier
 * only) — never derived from label text that could contain injection-shaped strings.
 */
function makeOverflowTapCandidate(elementId: string): CandidateAction {
  return {
    actionType: "tap",
    actionPayload: JSON.stringify({ elementId }),
    rationale: `overflow-menu: tap overflow/more element to reveal hidden menu`,
  };
}

// ── OverflowMenuProbeSource ───────────────────────────────────────────────────

/**
 * OverflowMenuProbeSource — pluggable ProbeSource for overflow / more-menu discovery.
 *
 * Detects overflow buttons in the snapshot and emits a tap candidate for each.
 * Resulting transitions (if the tap opens a menu) become normal graph edges.
 */
export class OverflowMenuProbeSource implements ProbeSource {
  readonly id = "overflow-menu";

  generateCandidates(
    _stateId: string,
    snapshot: A11ySnapshot,
  ): Promise<readonly CandidateAction[]> {
    try {
      const root = safeParseSnapshot(snapshot);
      if (root === null) return Promise.resolve([]);

      const allNodes = flattenNodes(root);
      const overflowElements = allNodes.filter(isOverflowElement);

      if (overflowElements.length === 0) return Promise.resolve([]);

      const seenIds = new Set<string>();
      const candidates: CandidateAction[] = [];

      for (const el of overflowElements) {
        // Only emit a candidate if we have a stable, non-empty accessibility identifier.
        // Label-based identifiers are intentionally excluded from the payload (injection risk).
        const elementId =
          typeof el.accessibilityIdentifier === "string" ? el.accessibilityIdentifier.trim() : "";

        if (elementId.length === 0) continue; // no stable id → skip (security T2)
        if (seenIds.has(elementId)) continue; // dedup
        seenIds.add(elementId);

        candidates.push(makeOverflowTapCandidate(elementId));
      }

      return Promise.resolve(candidates);
    } catch {
      // ProbeSource contract: never throw (ADR-0004 §6 degradation rule).
      return Promise.resolve([]);
    }
  }
}
