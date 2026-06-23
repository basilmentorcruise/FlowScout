/**
 * snapshotUtils.ts — shared parsing utilities for hidden-affordance probe sources (#35).
 *
 * Responsibilities:
 * - Safe JSON parsing of A11ySnapshot strings (never throws, returns null on failure).
 * - Depth-bounded tree flattening for element iteration.
 *
 * Security:
 * - No raw a11y body is logged anywhere in this module (T7/NFR5).
 * - All utilities are pure functions with no I/O or side effects.
 * - Port-only: no adapter/SDK imports (T10/NFR1).
 *
 * These are internal helpers shared among the probe implementations.
 * They are NOT exported from the probes/index.ts public surface.
 */
import type { A11ySnapshot } from "@flowscout/domain";

// ── A11yNode — internal representation ───────────────────────────────────────

/**
 * A parsed a11y node with the fields probe sources care about.
 * Intentionally loose (index signature) so we can handle any snapshot shape without
 * crashing on unexpected properties (T11 degradation rule).
 */
export interface A11yNode {
  type?: string;
  role?: string;
  label?: string;
  value?: string;
  accessibilityIdentifier?: string;
  testId?: string;
  traits?: string[];
  children?: A11yNode[];
  [key: string]: unknown;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum depth to traverse when flattening a snapshot tree. DoS guard (T11). */
const MAX_FLATTEN_DEPTH = 12;

/** Maximum number of nodes to collect before stopping. DoS guard (T11). */
const MAX_NODES = 1_000;

// ── Safe JSON parse ───────────────────────────────────────────────────────────

/**
 * Parse an A11ySnapshot string into a root A11yNode.
 *
 * Returns null when:
 * - The snapshot is empty / blank.
 * - The snapshot is not valid JSON.
 * - The parsed value is not an object (e.g. null, array at top level).
 *
 * Never throws (ProbeSource contract).
 */
export function safeParseSnapshot(snapshot: A11ySnapshot): A11yNode | null {
  try {
    if (!snapshot || snapshot.trim().length === 0) return null;
    const parsed: unknown = JSON.parse(snapshot);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as A11yNode;
  } catch {
    return null;
  }
}

// ── Tree flattening ───────────────────────────────────────────────────────────

/**
 * Depth-first traversal of an a11y node tree, returning a flat array of all nodes.
 *
 * Bounded by MAX_FLATTEN_DEPTH and MAX_NODES to guard against pathological trees (T11).
 * Never throws (ProbeSource contract).
 */
export function flattenNodes(root: A11yNode): readonly A11yNode[] {
  const result: A11yNode[] = [];

  function visit(node: A11yNode, depth: number): void {
    if (depth > MAX_FLATTEN_DEPTH) return;
    if (result.length >= MAX_NODES) return;

    result.push(node);

    const children = node.children;
    if (!Array.isArray(children)) return;

    for (const child of children) {
      if (result.length >= MAX_NODES) return;
      visit(child, depth + 1);
    }
  }

  try {
    visit(root, 0);
  } catch {
    // Never throw (T11 degradation rule); return whatever was collected.
  }

  return result;
}
