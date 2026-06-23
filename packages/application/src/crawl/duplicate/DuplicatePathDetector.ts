/**
 * DuplicatePathDetector — structural duplicate-path detection (#37 / E2.7).
 *
 * Identifies nodes in the final StateGraph that were reached via MULTIPLE DISTINCT
 * incoming edge paths (in-degree > 1 from distinct fromIds). These are structurally
 * "convergent" nodes — canonical duplicate/hidden-path detection.
 *
 * This is STRUCTURAL only: two distinct paths arriving at the same node.
 * SEMANTIC grouping (two different node identities that "mean the same thing")
 * is E3 — explicitly out of scope for E2.
 *
 * Port-only: no adapter/SDK imports (T10/NFR1). Pure function — no I/O.
 */
import type { StateGraph, StateIdentity } from "@flowscout/domain";

// ── DuplicatePathDetector ─────────────────────────────────────────────────────

/**
 * DuplicatePathDetector — detects nodes reachable via multiple distinct edge paths.
 *
 * Injected via CrawlCollaborators; called once after the crawl loop finishes,
 * before buildFinishedEvent. The result populates StateGraph.duplicatePathNodeIds.
 *
 * Algorithm (O(E) over edges):
 *   For each edge, record the set of distinct fromIds that point to each toId.
 *   Any toId with more than one distinct fromId is a duplicate-path node.
 */
export class DuplicatePathDetector {
  /**
   * Detects nodes with in-degree > 1 from distinct edge sources.
   *
   * @param graph  The final StateGraph after the crawl loop.
   * @returns      A ReadonlySet of StateIdentity values for duplicate-path nodes.
   */
  detect(graph: StateGraph): ReadonlySet<StateIdentity> {
    // Map: toId -> Set of distinct fromIds
    const incomingFromIds = new Map<StateIdentity, Set<StateIdentity>>();

    for (const edge of graph.edges) {
      let froms = incomingFromIds.get(edge.toId);
      if (froms === undefined) {
        froms = new Set<StateIdentity>();
        incomingFromIds.set(edge.toId, froms);
      }
      froms.add(edge.fromId);
    }

    // Collect nodes with in-degree > 1 from distinct sources
    const duplicates = new Set<StateIdentity>();
    for (const [toId, froms] of incomingFromIds) {
      if (froms.size > 1) {
        duplicates.add(toId);
      }
    }

    return duplicates;
  }
}
