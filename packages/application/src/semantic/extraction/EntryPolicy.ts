/**
 * EntryPolicy — entry-node identification strategy (#54 / E3.1).
 *
 * Strategy pattern (Open/Closed): the rule-based default is injected into the
 * extractor; #56 (or a future LLM pass) supplies a different policy at the
 * composition root, never by editing the traversal core.
 */
import type { StateGraph, StateIdentity } from "@flowscout/domain";
import type { GraphAdjacency } from "./GraphAdjacency.js";

/** Identifies the entry (start) nodes of a finalized StateGraph. */
export interface EntryPolicy {
  /**
   * Returns the entry node ids in STABLE iteration order. Determinism (AC2) requires
   * the result order not depend on Map/Set iteration order.
   */
  entries(graph: StateGraph, adjacency: GraphAdjacency): readonly StateIdentity[];
}

/**
 * Rule-based entries = graph sources (in-degree 0) union the launch/root state
 * (min `firstSeenAt`, tie-broken by id). The launch node is always included so a
 * fully-cyclic graph (no in-degree-0 node) still has a defined entry.
 * Sorted by (firstSeenAt, id) for stable order.
 */
export const ruleBasedEntryPolicy: EntryPolicy = {
  entries(graph, adjacency) {
    const entrySet = new Set<StateIdentity>();

    for (const nodeId of adjacency.allNodeIds()) {
      if (adjacency.inDegreeOf(nodeId) === 0) {
        entrySet.add(nodeId);
      }
    }

    const launch = launchNodeId(graph);
    if (launch !== null) {
      entrySet.add(launch);
    }

    return [...entrySet].sort((a, b) => compareByFirstSeenThenId(graph, a, b));
  },
};

/** The node first observed (min `firstSeenAt`, tie-broken by id), or null if no nodes. */
export function launchNodeId(graph: StateGraph): StateIdentity | null {
  let best: StateIdentity | null = null;
  let bestSeen: string | null = null;
  for (const node of graph.nodes.values()) {
    if (
      bestSeen === null ||
      node.firstSeenAt < bestSeen ||
      (node.firstSeenAt === bestSeen && best !== null && node.id < best)
    ) {
      best = node.id;
      bestSeen = node.firstSeenAt;
    }
  }
  return best;
}

/** Stable order: by the node's firstSeenAt, then by id. Missing nodes sort last by id. */
function compareByFirstSeenThenId(graph: StateGraph, a: StateIdentity, b: StateIdentity): number {
  const keyA = sortKey(graph, a);
  const keyB = sortKey(graph, b);
  if (keyA < keyB) return -1;
  if (keyA > keyB) return 1;
  return 0;
}

/**
 * Build a single comparable sort key. A leading declared-flag (`0` for declared nodes,
 * `1` for nodes referenced only by an edge) sorts declared-first; then `firstSeenAt`
 * (so earlier nodes come first); then the id as a stable tie-break. Collapsing to one
 * ASCII string key keeps the comparator low-complexity and the output deterministic.
 */
function sortKey(graph: StateGraph, nodeId: StateIdentity): string {
  const seen = graph.nodes.get(nodeId)?.firstSeenAt;
  const declaredFlag = seen === undefined ? "1" : "0";
  return `${declaredFlag}\t${seen ?? ""}\t${String(nodeId)}`;
}
