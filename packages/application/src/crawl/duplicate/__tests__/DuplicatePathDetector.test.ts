/**
 * DuplicatePathDetector unit tests — covers duplicate-path detection AC.
 */
import { describe, it, expect } from "vitest";
import { DuplicatePathDetector } from "../DuplicatePathDetector.js";
import type { StateGraph, StateIdentity, StateEdge } from "@flowscout/domain";

const detector = new DuplicatePathDetector();

function makeId(s: string): StateIdentity {
  return s as StateIdentity;
}

function makeGraph(edges: StateEdge[]): StateGraph {
  return {
    runId: "test-run",
    appId: "com.test",
    appVersion: "1.0",
    platform: "ios",
    nodes: new Map(),
    edges,
    duplicatePathNodeIds: new Set(),
  };
}

function makeEdge(fromId: string, toId: string, idx: number): StateEdge {
  return {
    id: `edge-${String(idx)}`,
    fromId: makeId(fromId),
    toId: makeId(toId),
    actionType: "tap",
    actionPayload: "{}",
    observedAt: new Date().toISOString(),
  };
}

describe("DuplicatePathDetector — no duplicates", () => {
  it("returns empty set for a graph with no edges", () => {
    const graph = makeGraph([]);
    const result = detector.detect(graph);
    expect(result.size).toBe(0);
  });

  it("returns empty set for a linear path (A→B→C)", () => {
    const graph = makeGraph([makeEdge("A", "B", 1), makeEdge("B", "C", 2)]);
    const result = detector.detect(graph);
    expect(result.size).toBe(0);
  });

  it("returns empty set when the same fromId→toId appears multiple times", () => {
    // Multiple edges from same from to same to = in-degree 1 from distinct froms
    const graph = makeGraph([
      makeEdge("A", "B", 1),
      makeEdge("A", "B", 2), // same fromId, just multiple taps
    ]);
    const result = detector.detect(graph);
    expect(result.size).toBe(0);
  });
});

describe("DuplicatePathDetector — with duplicate paths", () => {
  it("detects a node reached via two distinct paths (A→C and B→C)", () => {
    const graph = makeGraph([makeEdge("A", "C", 1), makeEdge("B", "C", 2)]);
    const result = detector.detect(graph);
    expect(result.size).toBe(1);
    expect(result.has(makeId("C"))).toBe(true);
  });

  it("detects multiple duplicate-path nodes", () => {
    const graph = makeGraph([
      makeEdge("A", "C", 1),
      makeEdge("B", "C", 2),
      makeEdge("X", "Y", 3),
      makeEdge("Z", "Y", 4),
    ]);
    const result = detector.detect(graph);
    expect(result.size).toBe(2);
    expect(result.has(makeId("C"))).toBe(true);
    expect(result.has(makeId("Y"))).toBe(true);
  });

  it("handles three or more distinct froms for the same toId", () => {
    const graph = makeGraph([makeEdge("A", "D", 1), makeEdge("B", "D", 2), makeEdge("C", "D", 3)]);
    const result = detector.detect(graph);
    expect(result.size).toBe(1);
    expect(result.has(makeId("D"))).toBe(true);
  });
});

describe("DuplicatePathDetector — does not include start node", () => {
  it("the root node (no incoming edges) is not flagged as duplicate", () => {
    const graph = makeGraph([
      makeEdge("ROOT", "A", 1),
      makeEdge("ROOT", "B", 2),
      makeEdge("A", "C", 3),
      makeEdge("B", "C", 4), // C is duplicate
    ]);
    const result = detector.detect(graph);
    expect(result.has(makeId("ROOT"))).toBe(false);
    expect(result.has(makeId("C"))).toBe(true);
  });
});
