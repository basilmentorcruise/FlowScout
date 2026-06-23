/**
 * ScrollRevealProbeSource — E2.5 (#35).
 *
 * Generates swipe-up / swipe-down candidate actions for states whose a11y snapshot
 * contains scrollable containers (Table, ScrollView, CollectionView, List, etc.).
 * Swiping up/down causes the driver to scroll the content and re-snapshot, potentially
 * revealing controls that were below or above the visible fold.
 *
 * Driver primitive used: `MobileDriverPort.swipe(udid, "up"|"down")` — SUPPORTED (E1).
 *
 * Security (T2/TB-E1):
 * - Directions are hard-coded to the "up"/"down" literal values from the `SwipeDirection`
 *   union — never derived from untrusted snapshot content.
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

// ── Allowlisted directions (security T2) ─────────────────────────────────────

/** Allowlisted scroll directions for this probe. Never derived from snapshot content. */
const SCROLL_DIRECTIONS = ["up", "down"] as const;
type ScrollDirection = (typeof SCROLL_DIRECTIONS)[number];

// ── Scrollable container heuristics ──────────────────────────────────────────

/**
 * Role/type values that indicate a scrollable container (iOS XCUITest + W3C conventions).
 * These are the primary trigger for scroll-reveal probing.
 */
const SCROLLABLE_ROLES = new Set([
  "Table",
  "ScrollView",
  "CollectionView",
  "List",
  "ScrollArea",
  "OutlineView",
  "Browser",
]);

/** Returns true if the node represents a scrollable container. */
function isScrollableContainer(node: A11yNode): boolean {
  const role = node.type ?? node.role ?? "";
  return SCROLLABLE_ROLES.has(role);
}

// ── Candidate builder ─────────────────────────────────────────────────────────

/**
 * Build a swipe candidate action with a hard-coded, allowlisted direction.
 * Payload is a minimal JSON object consumed by `StartCrawlRun.executeSwipe`.
 */
function makeScrollCandidate(
  direction: ScrollDirection,
  elementId: string | undefined,
): CandidateAction {
  const payload: Record<string, unknown> = { direction };
  // Include elementId as a hint when available — the driver can use it for targeted scrolls.
  // We only include it if it is a non-empty string (validation guard).
  if (typeof elementId === "string" && elementId.length > 0) {
    payload.elementId = elementId;
  }
  return {
    actionType: "swipe",
    actionPayload: JSON.stringify(payload),
    rationale: `scroll-reveal: swipe ${direction} to reveal off-screen controls`,
  };
}

// ── ScrollRevealProbeSource ───────────────────────────────────────────────────

/**
 * ScrollRevealProbeSource — pluggable ProbeSource for scroll-to-reveal hidden affordances.
 *
 * For each scrollable container found in the snapshot, generates one swipe-up and one
 * swipe-down candidate. The crawl engine drives these swipes, re-snapshots, and discovers
 * any newly visible controls as normal `CandidateAction` values.
 */
export class ScrollRevealProbeSource implements ProbeSource {
  readonly id = "scroll-reveal";

  generateCandidates(
    _stateId: string,
    snapshot: A11ySnapshot,
  ): Promise<readonly CandidateAction[]> {
    try {
      const root = safeParseSnapshot(snapshot);
      if (root === null) return Promise.resolve([]);

      const allNodes = flattenNodes(root);
      const scrollableContainers = allNodes.filter(isScrollableContainer);

      if (scrollableContainers.length === 0) return Promise.resolve([]);

      // Deduplicate: one pair (up+down) per unique elementId, or a single pair if none have ids.
      const seenIds = new Set<string>();
      const candidates: CandidateAction[] = [];

      for (const container of scrollableContainers) {
        // elementId is the stable identifier; fall back to undefined (produces generic swipe).
        const elementId =
          typeof container.accessibilityIdentifier === "string"
            ? container.accessibilityIdentifier
            : undefined;

        const dedupKey = elementId ?? "__generic__";
        if (seenIds.has(dedupKey)) continue;
        seenIds.add(dedupKey);

        for (const direction of SCROLL_DIRECTIONS) {
          candidates.push(makeScrollCandidate(direction, elementId));
        }
      }

      return Promise.resolve(candidates);
    } catch {
      // ProbeSource contract: never throw (ADR-0004 §6 degradation rule).
      return Promise.resolve([]);
    }
  }
}
