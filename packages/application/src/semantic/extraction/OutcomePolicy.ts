/**
 * OutcomePolicy — outcome-node identification strategy (#54 / E3.1).
 *
 * Strategy pattern (Open/Closed): the rule-based default is injected; #58's semantic
 * sameness pass supplies a different policy without editing the traversal.
 */
import type { StateGraph, StateIdentity } from "@flowscout/domain";
import type { GraphAdjacency } from "./GraphAdjacency.js";

/** Identifies whether a node is an end-to-end outcome (terminal of a workflow). */
export interface OutcomePolicy {
  /**
   * Returns true if `nodeId` is an outcome where a workflow path should terminate.
   * Must be pure and order-independent.
   */
  isOutcome(nodeId: StateIdentity, graph: StateGraph, adjacency: GraphAdjacency): boolean;
}

/**
 * Rule-based outcomes = sinks (out-degree 0) ∪ `graph.duplicatePathNodeIds`
 * (E2 already flagged these convergence points as meaningful outcomes, even if they
 * still have outgoing edges).
 */
export const ruleBasedOutcomePolicy: OutcomePolicy = {
  isOutcome(nodeId, graph, adjacency) {
    if (adjacency.outDegree(nodeId) === 0) return true;
    return graph.duplicatePathNodeIds.has(nodeId);
  },
};
