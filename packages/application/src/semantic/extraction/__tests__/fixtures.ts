/**
 * Deterministic synthetic StateGraph fixtures for the workflow-extraction suite.
 * Pure builders — no I/O, no LLM, no driver. Each builder is parameterised enough
 * for the per-AC cases (#54) and re-usable by the determinism property test.
 */
import type {
  ActionType,
  Platform,
  StateEdge,
  StateGraph,
  StateIdentity,
  StateNode,
} from "@flowscout/domain";

export function id(raw: string): StateIdentity {
  return raw as StateIdentity;
}

/** Build a StateNode with a deterministic, ordered firstSeenAt derived from `seq`. */
export function node(
  raw: string,
  seq: number,
  label = `Label-${raw}`,
  platform: Platform = "ios",
): StateNode {
  // Monotonic ISO timestamps so min-firstSeenAt is well-defined and stable.
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  return {
    id: id(raw),
    label,
    platform,
    firstSeenAt: new Date(base + seq * 1000).toISOString(),
    a11ySnapshot: `<a11y for ${raw}>`,
    screenshotUri: null,
  };
}

export function edge(
  edgeId: string,
  from: string,
  to: string,
  actionType: ActionType = "tap",
  actionPayload = "{}",
): StateEdge {
  return {
    id: edgeId,
    fromId: id(from),
    toId: id(to),
    actionType,
    actionPayload,
    observedAt: "2026-01-01T00:00:00.000Z",
  };
}

export interface GraphSpec {
  readonly nodes: readonly StateNode[];
  readonly edges: readonly StateEdge[];
  readonly duplicatePathNodeIds?: readonly StateIdentity[];
  readonly platform?: Platform;
  readonly runId?: string;
}

export function makeGraph(spec: GraphSpec): StateGraph {
  return {
    runId: spec.runId ?? "run-1",
    appId: "com.flowscout.test",
    appVersion: "1.0.0",
    platform: spec.platform ?? "ios",
    nodes: new Map(spec.nodes.map((n) => [n.id, n] as const)),
    edges: spec.edges,
    duplicatePathNodeIds: new Set(spec.duplicatePathNodeIds ?? []),
  };
}

/** Fisher–Yates shuffle with a tiny seeded PRNG — deterministic for reproducible tests. */
export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0 || 1;
  const next = (): number => {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ── Canonical fixtures ────────────────────────────────────────────────────────

/** Linear A→B→C. */
export function linearGraph(): StateGraph {
  return makeGraph({
    nodes: [node("A", 0), node("B", 1), node("C", 2)],
    edges: [edge("e1", "A", "B"), edge("e2", "B", "C")],
  });
}

/** Branching: A→B, A→C. */
export function branchingGraph(): StateGraph {
  return makeGraph({
    nodes: [node("A", 0), node("B", 1), node("C", 2)],
    edges: [edge("e1", "A", "B"), edge("e2", "A", "C")],
  });
}

/** Convergent: A→C and B→C, with C flagged in duplicatePathNodeIds; C→D continues. */
export function convergentGraph(): StateGraph {
  return makeGraph({
    nodes: [node("A", 0), node("B", 1), node("C", 2), node("D", 3)],
    edges: [edge("e1", "A", "C"), edge("e2", "B", "C"), edge("e3", "C", "D")],
    duplicatePathNodeIds: [id("C")],
  });
}

/** Cyclic: A→B→A (plus B→C terminal so there is a real outcome too). */
export function cyclicGraph(): StateGraph {
  return makeGraph({
    nodes: [node("A", 0), node("B", 1), node("C", 2)],
    edges: [edge("e1", "A", "B"), edge("e2", "B", "A"), edge("e3", "B", "C")],
  });
}

/** Empty graph: no nodes, no edges. */
export function emptyGraph(): StateGraph {
  return makeGraph({ nodes: [], edges: [] });
}

/** Single node, no edges. */
export function singleNodeGraph(): StateGraph {
  return makeGraph({ nodes: [node("A", 0)], edges: [] });
}

/** Two disconnected components: A→B and X→Y. */
export function disconnectedGraph(): StateGraph {
  return makeGraph({
    nodes: [node("A", 0), node("B", 1), node("X", 2), node("Y", 3)],
    edges: [edge("e1", "A", "B"), edge("e2", "X", "Y")],
  });
}

/** A→B with a fully-isolated orphan node O (not the launch node, no edges). */
export function orphanGraph(): StateGraph {
  return makeGraph({
    nodes: [node("A", 0), node("B", 1), node("O", 5)],
    edges: [edge("e1", "A", "B")],
  });
}

/**
 * A graph engineered to exceed a small `maxWorkflows` cap: a binary tree of depth
 * `depth` from a single root, yielding 2^depth leaf workflows.
 */
export function binaryTreeGraph(depth: number): StateGraph {
  const nodes: StateNode[] = [];
  const edges: StateEdge[] = [];
  let seq = 0;
  nodes.push(node("n", seq++));
  const frontier: string[] = ["n"];
  for (let d = 0; d < depth; d++) {
    const nextFrontier: string[] = [];
    for (const parent of frontier) {
      for (const side of ["0", "1"]) {
        const child = `${parent}${side}`;
        nodes.push(node(child, seq++));
        edges.push(edge(`e-${parent}-${side}`, parent, child));
        nextFrontier.push(child);
      }
    }
    frontier.length = 0;
    frontier.push(...nextFrontier);
  }
  return makeGraph({ nodes, edges });
}
