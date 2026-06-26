/**
 * Direct unit tests for the extraction seams: GraphAdjacency, EntryPolicy,
 * OutcomePolicy, WorkflowStepBuilder, and the content-derived id. These exercise the
 * collaborators in isolation (Strategy/Builder seams) and pin branch behaviour the
 * end-to-end WorkflowExtractor cases don't directly observe.
 */
import { describe, expect, it } from "vitest";
import {
  GraphAdjacency,
  buildSteps,
  ruleBasedEntryPolicy,
  ruleBasedOutcomePolicy,
  launchNodeId,
  workflowId,
} from "../../../index.js";
import { edge, id, makeGraph, node } from "./fixtures.js";

describe("GraphAdjacency", () => {
  it("sorts outgoing edges by (actionType, actionPayload, edge.id) — stable regardless of input order", () => {
    const graph = makeGraph({
      nodes: [node("A", 0), node("B", 1), node("C", 2)],
      edges: [
        edge("z", "A", "C", "tap", "{}"),
        edge("a", "A", "B", "swipe", "{}"),
        edge("m", "A", "B", "tap", "{a:1}"),
      ],
    });
    const adj = new GraphAdjacency(graph);
    const fromA = adj.edgesFrom(id("A"));
    // swipe < tap; within tap, payload "{a:1}" < "{}" ('a' < '}'), so m precedes z.
    expect(fromA.map((e) => e.id)).toEqual(["a", "m", "z"]);
    expect(adj.outDegree(id("A"))).toBe(3);
    expect(adj.outDegree(id("B"))).toBe(0);
  });

  it("counts in-degree and tracks nodes referenced only by edges", () => {
    const graph = makeGraph({
      nodes: [node("A", 0)],
      edges: [edge("e1", "A", "X"), edge("e2", "A", "X")],
    });
    const adj = new GraphAdjacency(graph);
    expect(adj.inDegreeOf(id("A"))).toBe(0); // source
    expect(adj.inDegreeOf(id("X"))).toBe(2); // two incoming edges
    expect(new Set(adj.allNodeIds())).toEqual(new Set([id("A"), id("X")]));
  });

  it("returns 0 in-degree for an unknown node", () => {
    const adj = new GraphAdjacency(makeGraph({ nodes: [node("A", 0)], edges: [] }));
    expect(adj.inDegreeOf(id("UNKNOWN"))).toBe(0);
    expect(adj.outDegree(id("UNKNOWN"))).toBe(0);
    expect(adj.edgesFrom(id("UNKNOWN"))).toEqual([]);
  });
});

describe("ruleBasedEntryPolicy", () => {
  it("returns in-degree-0 sources plus the launch node, ordered by (firstSeenAt, id)", () => {
    const graph = makeGraph({
      nodes: [node("A", 0), node("B", 1), node("C", 2)],
      edges: [edge("e1", "A", "B"), edge("e2", "C", "B")],
    });
    const adj = new GraphAdjacency(graph);
    // Sources: A (seq0), C (seq2). Launch: A (min firstSeenAt). Result ordered A, C.
    expect(ruleBasedEntryPolicy.entries(graph, adj)).toEqual([id("A"), id("C")]);
  });

  it("includes the launch node even when it has an incoming (cyclic) edge", () => {
    const graph = makeGraph({
      nodes: [node("A", 0), node("B", 1)],
      edges: [edge("e1", "A", "B"), edge("e2", "B", "A")],
    });
    const adj = new GraphAdjacency(graph);
    // No in-degree-0 node; launch node A is still an entry.
    expect(ruleBasedEntryPolicy.entries(graph, adj)).toEqual([id("A")]);
  });
});

describe("launchNodeId", () => {
  it("returns null for an empty graph", () => {
    expect(launchNodeId(makeGraph({ nodes: [], edges: [] }))).toBeNull();
  });

  it("returns the min-firstSeenAt node, tie-broken by id", () => {
    const graph = makeGraph({ nodes: [node("Z", 0), node("A", 0), node("M", 1)], edges: [] });
    expect(launchNodeId(graph)).toBe(id("A"));
  });
});

describe("ruleBasedOutcomePolicy", () => {
  const graph = makeGraph({
    nodes: [node("A", 0), node("B", 1), node("C", 2)],
    edges: [edge("e1", "A", "B"), edge("e2", "B", "C")],
    duplicatePathNodeIds: [id("B")],
  });
  const adj = new GraphAdjacency(graph);

  it("marks sinks as outcomes", () => {
    expect(ruleBasedOutcomePolicy.isOutcome(id("C"), graph, adj)).toBe(true);
  });

  it("marks duplicatePathNodeIds as outcomes even with outgoing edges", () => {
    expect(ruleBasedOutcomePolicy.isOutcome(id("B"), graph, adj)).toBe(true);
  });

  it("does not mark a plain interior node as an outcome", () => {
    expect(ruleBasedOutcomePolicy.isOutcome(id("A"), graph, adj)).toBe(false);
  });
});

describe("buildSteps", () => {
  const graph = makeGraph({
    nodes: [node("A", 0, "Home"), node("B", 1, "Detail")],
    edges: [edge("e1", "A", "B", "tap")],
  });

  it("indexes steps monotonically and nulls the terminal edge", () => {
    const steps = buildSteps(graph, [id("A"), id("B")], [graph.edges[0]]);
    expect(steps.map((s) => s.stepIndex)).toEqual([0, 1]);
    expect(steps[0].edge?.id).toBe("e1");
    expect(steps[1].edge).toBeNull();
  });

  it("describes a transition step with action + node labels and an arrival for the terminal", () => {
    const steps = buildSteps(graph, [id("A"), id("B")], [graph.edges[0]]);
    expect(steps[0].description).toBe('tap on "Home" → "Detail"');
    expect(steps[1].description).toBe('Arrive at "Detail"');
  });

  it("falls back to the id when a node has no label record", () => {
    const steps = buildSteps(graph, [id("GHOST")], []);
    expect(steps).toHaveLength(1);
    expect(steps[0].description).toBe('Arrive at "GHOST"');
    expect(steps[0].edge).toBeNull();
  });
});

describe("workflowId", () => {
  it("is deterministic and content-derived (same chain ⇒ same id)", () => {
    const states = [id("A"), id("B"), id("C")];
    const edges = [edge("e1", "A", "B"), edge("e2", "B", "C")];
    expect(workflowId(states, edges)).toBe(workflowId(states, edges));
  });

  it("differs when the state/edge chain differs", () => {
    const a = workflowId([id("A"), id("B")], [edge("e1", "A", "B")]);
    const b = workflowId([id("A"), id("C")], [edge("e2", "A", "C")]);
    expect(a).not.toBe(b);
  });

  it("produces a 16-char lowercase hex string", () => {
    const out = workflowId([id("A")], []);
    expect(out).toMatch(/^[0-9a-f]{16}$/);
  });
});
