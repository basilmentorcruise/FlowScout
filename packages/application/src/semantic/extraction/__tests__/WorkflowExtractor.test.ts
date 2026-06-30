/**
 * WorkflowExtractor unit suite (#54 / E3.1).
 *
 * Test-first: one named case per architect-plan §6 fixture / acceptance criterion.
 * All fixtures are deterministic synthetic StateGraphs — no I/O, LLM, or driver.
 */
import { describe, expect, it } from "vitest";
import type { StateGraph, StateIdentity, OutcomePolicy } from "../../../index.js";
import {
  WorkflowExtractor,
  defaultWorkflowExtractor,
  ruleBasedEntryPolicy,
  defaultExtractionConfig,
} from "../../../index.js";
import {
  binaryTreeGraph,
  branchingGraph,
  convergentGraph,
  cyclicGraph,
  disconnectedGraph,
  edge,
  emptyGraph,
  id,
  linearGraph,
  makeGraph,
  node,
  orphanGraph,
  shuffle,
  singleNodeGraph,
} from "./fixtures.js";

function reshuffleEdges(graph: StateGraph, seed: number): StateGraph {
  return { ...graph, edges: shuffle(graph.edges, seed) };
}

describe("WorkflowExtractor — linear graph (AC1)", () => {
  const result = defaultWorkflowExtractor().extract(linearGraph());

  it("emits exactly one workflow for A→B→C", () => {
    expect(result.workflows).toHaveLength(1);
  });

  it("the workflow has 3 ordered steps with a terminal edge=null", () => {
    const [wf] = result.workflows;
    expect(wf.steps.map((s) => s.stepIndex)).toEqual([0, 1, 2]);
    expect(wf.steps.map((s) => s.stateId)).toEqual([id("A"), id("B"), id("C")]);
    expect(wf.steps[0].edge?.id).toBe("e1");
    expect(wf.steps[1].edge?.id).toBe("e2");
    expect(wf.steps[2].edge).toBeNull();
  });

  it("each step carries a rule-derived, non-empty description", () => {
    const [wf] = result.workflows;
    for (const step of wf.steps) {
      expect(step.description.length).toBeGreaterThan(0);
    }
  });

  it("rule-only workflows set inferenceConfidence=null and isHiddenPath=false (AC6)", () => {
    const [wf] = result.workflows;
    expect(wf.inferenceConfidence).toBeNull();
    expect(wf.isHiddenPath).toBe(false);
  });

  it("name and description do not smuggle semantic purpose/group data (AC6 / OQ3 guard)", () => {
    const [wf] = result.workflows;
    // Provisional rule placeholders only: derived from entry/outcome labels, not free prose.
    expect(wf.name).toContain("Label-A");
    expect(wf.name).toContain("Label-C");
    expect(wf.description).toContain("Label-A");
  });

  it("surfaces no orphans for a fully-connected linear graph", () => {
    expect(result.orphanStateIds).toEqual([]);
  });
});

describe("WorkflowExtractor — branching graph (AC1)", () => {
  it("emits two workflows (A→B and A→C) in stable order regardless of edge insertion order", () => {
    const a = defaultWorkflowExtractor().extract(branchingGraph());
    const b = defaultWorkflowExtractor().extract(reshuffleEdges(branchingGraph(), 99));
    expect(a.workflows).toHaveLength(2);
    expect(a.workflows.map((w) => w.id)).toEqual(b.workflows.map((w) => w.id));
    const tails = a.workflows.map((w) => w.steps[w.steps.length - 1].stateId);
    expect(tails).toEqual([id("B"), id("C")]);
  });
});

describe("WorkflowExtractor — convergent / duplicate-path graph (AC1)", () => {
  const result = defaultWorkflowExtractor().extract(convergentGraph());

  it("treats a duplicatePathNodeId (C) as an outcome from both entries", () => {
    // A→C and B→C both stop at C (an outcome), even though C has an outgoing edge.
    const toC = result.workflows.filter((w) => w.steps[w.steps.length - 1].stateId === id("C"));
    expect(toC).toHaveLength(2);
  });

  it("does NOT set any semantic hidden-path flag (that is #58)", () => {
    expect(result.workflows.every((w) => !w.isHiddenPath)).toBe(true);
  });

  it("surfaces D as an orphan when its only parent C is a duplicate-outcome (#73 lock)", () => {
    // C is a duplicatePathNodeId ⇒ treated as an outcome, so traversal terminates at C
    // and never descends the C→D edge. D is therefore unreached on any emitted path and
    // MUST be reported as an orphan — pin this so the convergent fixture can't regress.
    expect(result.orphanStateIds).toEqual([id("D")]);
  });
});

describe("WorkflowExtractor — cyclic graph (AC3)", () => {
  it("terminates, stays bounded, and closes back-edges instead of recursing", () => {
    const result = defaultWorkflowExtractor().extract(cyclicGraph());
    expect(result.workflows.length).toBeGreaterThan(0);
    // No path may exceed maxPathLength; no node may appear twice within one path.
    for (const wf of result.workflows) {
      expect(wf.steps.length).toBeLessThanOrEqual(defaultExtractionConfig.maxPathLength);
      const ids = wf.steps.map((s) => s.stateId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("respects a tight maxPathLength cap without throwing", () => {
    const extractor = new WorkflowExtractor(undefined, undefined, {
      maxPathLength: 2,
      maxWorkflows: 500,
    });
    const result = extractor.extract(cyclicGraph());
    for (const wf of result.workflows) {
      expect(wf.steps.length).toBeLessThanOrEqual(2);
    }
  });
});

describe("WorkflowExtractor — orphan accounting under path-length cap (#73)", () => {
  // A→B→C→D, a simple chain, capped at maxPathLength=2.
  const chain = (): StateGraph =>
    makeGraph({
      nodes: [node("A", 0), node("B", 1), node("C", 2), node("D", 3)],
      edges: [edge("e1", "A", "B"), edge("e2", "B", "C"), edge("e3", "C", "D")],
    });

  it("reports BOTH nodes past a maxPathLength cut as orphans, not just the far one", () => {
    // Cap = 2 ⇒ the only emitted workflow is the truncated A→B. C (one hop past the cut)
    // and D (two hops) are BOTH unreached. Pre-fix, C was pre-marked visited (the .add ran
    // before the cap check) and silently omitted while only D was reported — an accounting
    // asymmetry. Post-fix, "visited" means "appended to an emitted path", so the truncated
    // edge target falls through to orphan collection, symmetric with nodes further out.
    const extractor = new WorkflowExtractor(undefined, undefined, {
      maxPathLength: 2,
      maxWorkflows: 500,
    });
    const result = extractor.extract(chain());

    expect(result.workflows.map((w) => w.steps.map((s) => s.stateId))).toEqual([
      [id("A"), id("B")],
    ]);
    // orphanStateIds is sorted ascending: C before D.
    expect(result.orphanStateIds).toEqual([id("C"), id("D")]);
  });

  it("stays benign uncapped: the same chain surfaces no orphans (no behavior change)", () => {
    const result = defaultWorkflowExtractor().extract(chain());
    expect(result.workflows.map((w) => w.steps.map((s) => s.stateId))).toEqual([
      [id("A"), id("B"), id("C"), id("D")],
    ]);
    expect(result.orphanStateIds).toEqual([]);
  });
});

describe("WorkflowExtractor — cap saturation (AC3)", () => {
  it("returns exactly maxWorkflows deterministically, partial, no throw", () => {
    // Depth-5 binary tree => 32 leaf workflows; cap at 10.
    const graph = binaryTreeGraph(5);
    const extractor = new WorkflowExtractor(undefined, undefined, {
      maxPathLength: 40,
      maxWorkflows: 10,
    });
    const result = extractor.extract(graph);
    expect(result.workflows).toHaveLength(10);

    // Deterministic: re-running (and on shuffled edges) yields the same capped set.
    const again = extractor.extract(reshuffleEdges(graph, 7));
    expect(again.workflows.map((w) => w.id)).toEqual(result.workflows.map((w) => w.id));
  });
});

describe("WorkflowExtractor — empty graph (AC4)", () => {
  it("returns an empty result, never throws", () => {
    const result = defaultWorkflowExtractor().extract(emptyGraph());
    expect(result.workflows).toEqual([]);
    expect(result.orphanStateIds).toEqual([]);
  });
});

describe("WorkflowExtractor — single node (AC4)", () => {
  it("a lone node is an outcome => one 1-step workflow with edge=null", () => {
    const result = defaultWorkflowExtractor().extract(singleNodeGraph());
    expect(result.workflows).toHaveLength(1);
    const [wf] = result.workflows;
    expect(wf.steps).toHaveLength(1);
    expect(wf.steps[0].stateId).toBe(id("A"));
    expect(wf.steps[0].edge).toBeNull();
    expect(result.orphanStateIds).toEqual([]);
  });
});

describe("WorkflowExtractor — disconnected components (AC5)", () => {
  it("extracts every component's reachable workflow; nothing dropped", () => {
    const result = defaultWorkflowExtractor().extract(disconnectedGraph());
    const tails = result.workflows.map((w) => w.steps[w.steps.length - 1].stateId).sort();
    expect(result.workflows).toHaveLength(2);
    expect(tails).toEqual([id("B"), id("Y")].sort());
    expect(result.orphanStateIds).toEqual([]);
  });
});

describe("WorkflowExtractor — orphan node (AC5)", () => {
  it("surfaces a fully-isolated non-launch node on orphanStateIds", () => {
    const result = defaultWorkflowExtractor().extract(orphanGraph());
    // O has no in/out edges and is not the launch node (A is earlier).
    // It is reachable only as a lone entry==outcome, so it IS emitted as a 1-step
    // workflow AND must not be reported as a dropped orphan — pin the chosen behavior.
    const visited = new Set<StateIdentity>(
      result.workflows.flatMap((w) => w.steps.map((s) => s.stateId)),
    );
    expect(visited.has(id("O"))).toBe(true);
    expect(result.orphanStateIds).toEqual([]);
  });

  it("surfaces a node present in nodes[] but unreachable by any edge or entry policy", () => {
    // A graph where node Z exists only as an edge target with no node + a phantom:
    // here we add Z to nodes but it has an incoming edge from a node that is itself
    // unreachable AND not an entry — exercise the orphan-collection branch.
    const graph = makeGraph({
      nodes: [node("A", 0), node("B", 1), node("G", 2), node("Z", 3)],
      // G→Z, but G has an incoming back-edge from Z making neither an in-degree-0 source;
      // and G is not the min-firstSeenAt launch node (A is). So the G/Z cycle component
      // has no entry → its nodes are surfaced as orphans, not silently dropped.
      edges: [edge("e1", "A", "B"), edge("e2", "G", "Z"), edge("e3", "Z", "G")],
    });
    const result = defaultWorkflowExtractor().extract(graph);
    expect(result.orphanStateIds.slice().sort()).toEqual([id("G"), id("Z")].sort());
  });
});

describe("WorkflowExtractor — determinism property (AC2)", () => {
  const fixtures: ReadonlyArray<readonly [string, () => StateGraph]> = [
    ["linear", linearGraph],
    ["branching", branchingGraph],
    ["convergent", convergentGraph],
    ["cyclic", cyclicGraph],
    ["disconnected", disconnectedGraph],
    ["binaryTree-4", () => binaryTreeGraph(4)],
  ];

  for (const [name, make] of fixtures) {
    it(`shuffling edges[] yields deep-equal output incl. ids — ${name}`, () => {
      const baseline = defaultWorkflowExtractor().extract(make());
      for (const seed of [1, 42, 1337, 2026]) {
        const shuffled = defaultWorkflowExtractor().extract(reshuffleEdges(make(), seed));
        expect(shuffled).toEqual(baseline);
      }
    });
  }
});

describe("WorkflowExtractor — policy substitution (Open/Closed + DI)", () => {
  it("an injected OutcomePolicy changes which nodes terminate a path", () => {
    // Custom policy: ONLY node B is an outcome. On a linear A→B→C graph this means
    // the path stops at B (not C), proving the traversal core honours the injected
    // strategy without being edited.
    const onlyB: OutcomePolicy = {
      isOutcome: (nodeId) => nodeId === id("B"),
    };
    const extractor = new WorkflowExtractor(ruleBasedEntryPolicy, onlyB, defaultExtractionConfig);
    const result = extractor.extract(linearGraph());
    expect(result.workflows).toHaveLength(1);
    const [wf] = result.workflows;
    expect(wf.steps.map((s) => s.stateId)).toEqual([id("A"), id("B")]);
    expect(wf.steps[wf.steps.length - 1].edge).toBeNull();
  });

  it("a NEVER-outcome policy still emits a path at a true sink (no child recursed)", () => {
    // Custom policy never marks an outcome. On linear A→B→C, C is a sink with no
    // outgoing edges, so the path is still emitted (the !recursed fallback), and the
    // whole A→B→C path is the single workflow.
    const neverOutcome: OutcomePolicy = { isOutcome: () => false };
    const extractor = new WorkflowExtractor(ruleBasedEntryPolicy, neverOutcome);
    const result = extractor.extract(linearGraph());
    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0].steps.map((s) => s.stateId)).toEqual([id("A"), id("B"), id("C")]);
  });
});

describe("WorkflowExtractor — edges referencing undeclared nodes (robustness)", () => {
  it("handles an edge whose toId/fromId is not in graph.nodes without throwing", () => {
    // Node A is declared; PHANTOM is only referenced by an edge target. The builder
    // falls back to the id as the label; the extractor still produces a valid result.
    const graph = makeGraph({
      nodes: [node("A", 0)],
      edges: [edge("e1", "A", "PHANTOM")],
    });
    const result = defaultWorkflowExtractor().extract(graph);
    expect(result.workflows).toHaveLength(1);
    const [wf] = result.workflows;
    expect(wf.steps.map((s) => s.stateId)).toEqual([id("A"), id("PHANTOM")]);
    // PHANTOM is a sink (no outgoing) ⇒ outcome ⇒ terminal step edge=null.
    expect(wf.steps[1].edge).toBeNull();
    // PHANTOM is not a declared node but is reachable, so it is not an orphan.
    expect(result.orphanStateIds).toEqual([]);
    // Label fallback: provisional name uses the id when no node label exists.
    expect(wf.name).toContain("PHANTOM");
  });

  it("an undeclared source node (only a fromId) is treated as an in-degree-0 entry", () => {
    const graph = makeGraph({
      nodes: [node("B", 1)],
      edges: [edge("e1", "SRC", "B")],
    });
    const result = defaultWorkflowExtractor().extract(graph);
    // Two entries: the in-degree-0 source SRC (undeclared, found via edges) and the
    // launch node B (min-firstSeenAt among declared nodes). SRC→B is the real path;
    // B-as-launch is a lone 1-step workflow.
    const tails = result.workflows.map((w) => w.steps.map((s) => s.stateId));
    expect(tails).toContainEqual([id("SRC"), id("B")]);
    expect(tails).toContainEqual([id("B")]);
  });
});

describe("launchNodeId tie-break", () => {
  it("breaks firstSeenAt ties by lexicographic id", () => {
    // Two nodes share the same firstSeenAt (seq 0). The launch node is the smaller id.
    const graph = makeGraph({
      nodes: [node("Z", 0), node("A", 0)],
      edges: [],
    });
    // Both are sinks/sources; both are entries+outcomes ⇒ two 1-step workflows.
    const result = defaultWorkflowExtractor().extract(graph);
    expect(result.workflows).toHaveLength(2);
    // Stable entry order is (firstSeenAt, id) ⇒ A before Z.
    expect(result.workflows.map((w) => w.steps[0].stateId)).toEqual([id("A"), id("Z")]);
  });
});
