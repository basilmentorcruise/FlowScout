/**
 * SwipeRevealProbeSource — E2.5 (#35).
 *
 * Generates swipe-left / swipe-right candidate actions for states whose a11y snapshot
 * contains list rows, cells, or drawers that expose hidden actions when swiped horizontally
 * (e.g. "Delete", "Archive", "Mark as Read" row actions in iOS Mail / Reminders).
 *
 * Driver primitive used: `MobileDriverPort.swipe(udid, "left"|"right")` — SUPPORTED (E1).
 *
 * Security (T2/TB-E1):
 * - Directions are hard-coded to the "left"/"right" literals — never derived from untrusted
 *   snapshot content.
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

/** Allowlisted swipe-reveal directions. Never derived from snapshot content. */
const SWIPE_REVEAL_DIRECTIONS = ["left", "right"] as const;
type SwipeRevealDirection = (typeof SWIPE_REVEAL_DIRECTIONS)[number];

// ── Swipeable row heuristics ──────────────────────────────────────────────────

/**
 * Role/type values whose instances are candidates for horizontal swipe-reveal.
 * In iOS XCUITest: Cells within Tables/CollectionViews commonly expose row actions.
 */
const SWIPEABLE_CELL_ROLES = new Set(["Cell", "TableCell", "CollectionViewCell", "Row"]);

/**
 * Returns true if a node is a likely swipe-reveal target:
 * 1. It has a cell/row role, OR
 * 2. It explicitly declares a "swipeable" trait (custom accessibility attribute).
 */
function isSwipeableRow(node: A11yNode): boolean {
  const role = node.type ?? node.role ?? "";
  if (SWIPEABLE_CELL_ROLES.has(role)) return true;
  const traits = node.traits;
  if (Array.isArray(traits) && traits.includes("swipeable")) return true;
  return false;
}

// ── Candidate builder ─────────────────────────────────────────────────────────

function makeSwipeRevealCandidate(
  direction: SwipeRevealDirection,
  elementId: string | undefined,
): CandidateAction {
  const payload: Record<string, unknown> = { direction };
  if (typeof elementId === "string" && elementId.length > 0) {
    payload.elementId = elementId;
  }
  return {
    actionType: "swipe",
    actionPayload: JSON.stringify(payload),
    rationale: `swipe-reveal: swipe ${direction} on row to reveal hidden actions`,
  };
}

// ── SwipeRevealProbeSource ────────────────────────────────────────────────────

/**
 * SwipeRevealProbeSource — pluggable ProbeSource for horizontal swipe-reveal affordances.
 *
 * For each swipeable row/cell found in the snapshot, generates one swipe-left and one
 * swipe-right candidate. The crawl engine drives these and re-snapshots to discover newly
 * revealed controls (Delete, Archive, etc.) as normal `CandidateAction` values.
 *
 * To avoid combinatorial explosion on large lists, the number of probed rows is capped
 * at MAX_ROWS_TO_PROBE (per element id deduplication).
 */
export class SwipeRevealProbeSource implements ProbeSource {
  readonly id = "swipe-reveal";

  /** Maximum distinct row element IDs to probe per state (cost/budget guard). */
  private static readonly MAX_ROWS_TO_PROBE = 5;

  generateCandidates(
    _stateId: string,
    snapshot: A11ySnapshot,
  ): Promise<readonly CandidateAction[]> {
    try {
      const root = safeParseSnapshot(snapshot);
      if (root === null) return Promise.resolve([]);

      const allNodes = flattenNodes(root);
      const swipeableRows = allNodes.filter(isSwipeableRow);

      if (swipeableRows.length === 0) return Promise.resolve([]);

      const seenIds = new Set<string>();
      const candidates: CandidateAction[] = [];

      for (const row of swipeableRows) {
        if (seenIds.size >= SwipeRevealProbeSource.MAX_ROWS_TO_PROBE) break;

        const elementId =
          typeof row.accessibilityIdentifier === "string" ? row.accessibilityIdentifier : undefined;

        // Generic rows without an identifier share one probe slot (first encounter only).
        const dedupKey = elementId ?? "__generic-row__";
        if (seenIds.has(dedupKey)) continue;
        seenIds.add(dedupKey);

        for (const direction of SWIPE_REVEAL_DIRECTIONS) {
          candidates.push(makeSwipeRevealCandidate(direction, elementId));
        }
      }

      return Promise.resolve(candidates);
    } catch {
      // ProbeSource contract: never throw (ADR-0004 §6 degradation rule).
      return Promise.resolve([]);
    }
  }
}
