/**
 * GraphAdjacency — internal read-model built once from a StateGraph (#54 / E3.1).
 *
 * Owns the deterministic outgoing-edge index. Edges within each adjacency list are
 * sorted by a STABLE key (actionType, then actionPayload, then edge.id) so enumeration
 * order is independent of `graph.edges[]` input order (AC2). Also exposes in-degree so
 * the entry policy can find graph sources without re-scanning edges.
 *
 * Pure: no I/O. Construct once per extract() call.
 */
import type { StateEdge, StateGraph, StateIdentity } from "@flowscout/domain";

/** Stable comparison for two edges leaving the same node — never relies on Map order. */
function compareEdges(a: StateEdge, b: StateEdge): number {
  if (a.actionType !== b.actionType) return a.actionType < b.actionType ? -1 : 1;
  if (a.actionPayload !== b.actionPayload) return a.actionPayload < b.actionPayload ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export class GraphAdjacency {
  /** node -> outgoing edges, each list stably sorted. */
  private readonly outgoing = new Map<StateIdentity, StateEdge[]>();
  /** node -> count of distinct incoming edges (in-degree). */
  private readonly inDegree = new Map<StateIdentity, number>();

  constructor(graph: StateGraph) {
    // Ensure every declared node has an in-degree entry (defaults to 0).
    for (const nodeId of graph.nodes.keys()) {
      this.inDegree.set(nodeId, 0);
    }

    for (const edge of graph.edges) {
      let list = this.outgoing.get(edge.fromId);
      if (list === undefined) {
        list = [];
        this.outgoing.set(edge.fromId, list);
      }
      list.push(edge);

      this.inDegree.set(edge.toId, (this.inDegree.get(edge.toId) ?? 0) + 1);
      // A `fromId`/`toId` may reference a node not in `graph.nodes`; track it too so
      // source detection and orphan accounting see every referenced identity.
      if (!this.inDegree.has(edge.fromId)) {
        this.inDegree.set(edge.fromId, 0);
      }
    }

    for (const list of this.outgoing.values()) {
      list.sort(compareEdges);
    }
  }

  /** Outgoing edges from `nodeId`, stably sorted; empty array if none. */
  edgesFrom(nodeId: StateIdentity): readonly StateEdge[] {
    return this.outgoing.get(nodeId) ?? [];
  }

  /** Out-degree of `nodeId`. */
  outDegree(nodeId: StateIdentity): number {
    return this.outgoing.get(nodeId)?.length ?? 0;
  }

  /** In-degree of `nodeId` (distinct incoming edges counted; 0 for sources). */
  inDegreeOf(nodeId: StateIdentity): number {
    return this.inDegree.get(nodeId) ?? 0;
  }

  /** Every identity referenced by a node or an edge endpoint. */
  allNodeIds(): readonly StateIdentity[] {
    return [...this.inDegree.keys()];
  }
}
