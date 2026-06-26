/**
 * WorkflowStepBuilder — ordered-step assembly for one workflow (#54 / E3.1).
 *
 * Builder pattern: owns `stepIndex` monotonicity and the terminal `edge = null`
 * invariant, so the traversal core stays focused on path enumeration. Descriptions
 * are RULE-derived from the edge action + node label — never LLM, never overloaded
 * with purpose/group data (AC6 / OQ3 guard).
 *
 * Pure: no I/O.
 */
import type { StateEdge, StateGraph, StateIdentity, WorkflowStep } from "@flowscout/domain";

/** Human-readable label for a node, falling back to its id when no node record exists. */
function nodeLabel(graph: StateGraph, nodeId: StateIdentity): string {
  return graph.nodes.get(nodeId)?.label ?? String(nodeId);
}

/** Rule-derived per-step description: the action taken to leave this state, or arrival. */
function stepDescription(
  graph: StateGraph,
  nodeId: StateIdentity,
  outgoing: StateEdge | null,
): string {
  const here = nodeLabel(graph, nodeId);
  if (outgoing === null) {
    return `Arrive at "${here}"`;
  }
  const target = nodeLabel(graph, outgoing.toId);
  return `${outgoing.actionType} on "${here}" → "${target}"`;
}

/**
 * Assemble an ordered, validated `WorkflowStep[]` from a path of states + the edges
 * taken between them. `pathStates.length === pathEdges.length + 1`; the terminal
 * step always carries `edge = null`.
 */
export function buildSteps(
  graph: StateGraph,
  pathStates: readonly StateIdentity[],
  pathEdges: readonly StateEdge[],
): readonly WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  for (const [i, stateId] of pathStates.entries()) {
    const isTerminal = i === pathStates.length - 1;
    // eslint-disable-next-line security/detect-object-injection -- i is the loop index of an internal array, not user input
    const outgoing = isTerminal ? null : (pathEdges[i] ?? null);
    steps.push({
      stepIndex: i,
      stateId,
      edge: outgoing,
      description: stepDescription(graph, stateId, outgoing),
    });
  }
  return steps;
}
