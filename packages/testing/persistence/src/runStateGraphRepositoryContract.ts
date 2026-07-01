/**
 * StateGraphRepository port-conformance section (ADR-0008 §7).
 *
 * Shared behavior runs for every implementation; the `reopen`-gated durability
 * assertions (NFR1) run only for durable implementations.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { StateGraph, StateGraphRepository } from "@flowscout/domain";
import { makeStateIdentity } from "@flowscout/domain";
import type { GraphFixtures } from "./fixtures.js";
import { SQLI_PROBE_ID, REDACTED_MARKER, HOSTILE_MARKUP } from "./fixtures.js";

export interface StateGraphRepositoryContractOptions {
  /** Returns a FRESH, EMPTY repository. */
  createRepository: () => StateGraphRepository;
  /** Durable impls only: returns a NEW instance over the SAME underlying storage (NFR1). */
  reopen?: (repository: StateGraphRepository) => StateGraphRepository;
  fixtures: GraphFixtures;
}

/** "Hundreds of nodes" per NFR5. */
const LARGE_GRAPH_NODE_COUNT = 300;

export function runStateGraphRepositoryContract(
  options: StateGraphRepositoryContractOptions,
): void {
  const { createRepository, reopen, fixtures } = options;

  describe("StateGraphRepository contract", () => {
    let repository: StateGraphRepository;

    beforeEach(() => {
      repository = createRepository();
    });

    describe("roundtrip (FR2)", () => {
      it("returns a deep-equal graph (nodes Map, ordered edges, duplicate-path Set)", async () => {
        const graph = fixtures.makeGraph();
        await repository.saveGraph(graph);
        await expect(repository.findByRunId(graph.runId)).resolves.toEqual(graph);
      });

      it("round-trips an empty graph (zero nodes/edges) without error", async () => {
        const graph = fixtures.makeGraph({
          nodes: new Map(),
          edges: [],
          duplicatePathNodeIds: new Set(),
        });
        await repository.saveGraph(graph);
        await expect(repository.findByRunId(graph.runId)).resolves.toEqual(graph);
      });

      it("persists strings RAW and inert — byte-equal round-trip of markup + redaction marker (M83.5/M83.8)", async () => {
        const graph = fixtures.makeGraph();
        await repository.saveGraph(graph);
        const reloaded = await repository.findByRunId(graph.runId);
        expect(reloaded).not.toBeNull();
        for (const [id, node] of graph.nodes) {
          const reloadedNode = reloaded?.nodes.get(id);
          // Strict equality = byte-equal: no escaping/transform was applied on write.
          expect(reloadedNode?.label).toBe(node.label);
          expect(reloadedNode?.a11ySnapshot).toBe(node.a11ySnapshot);
        }
        expect(graph.nodes.get(makeStateIdentity("state-a"))?.label).toContain(HOSTILE_MARKUP);
        expect(graph.nodes.get(makeStateIdentity("state-a"))?.label).toContain(REDACTED_MARKER);
      });

      it("round-trips a large graph — hundreds of nodes with multi-KB a11y blobs (NFR5)", async () => {
        const graph = fixtures.makeLargeGraph("run-large", LARGE_GRAPH_NODE_COUNT);
        await repository.saveGraph(graph);
        const reloaded = await repository.findByRunId("run-large");
        expect(reloaded?.nodes.size).toBe(LARGE_GRAPH_NODE_COUNT);
        expect(reloaded?.edges).toHaveLength(LARGE_GRAPH_NODE_COUNT - 1);
        expect(reloaded).toEqual(graph);
      });
    });

    describe("idempotent upsert (FR2)", () => {
      it("re-saving the same runId replaces the graph — latest wins", async () => {
        const graph = fixtures.makeGraph();
        await repository.saveGraph(graph);
        const smaller: StateGraph = {
          ...graph,
          edges: graph.edges.slice(0, 1),
        };
        await repository.saveGraph(smaller);
        await expect(repository.findByRunId(graph.runId)).resolves.toEqual(smaller);
      });
    });

    describe("incremental updates", () => {
      it("upsertNode adds a new node to an existing graph", async () => {
        const graph = fixtures.makeGraph();
        await repository.saveGraph(graph);
        const extra = fixtures.makeNode({ id: makeStateIdentity("state-extra") });
        await repository.upsertNode(graph.runId, extra);
        const reloaded = await repository.findByRunId(graph.runId);
        expect(reloaded?.nodes.get(extra.id)).toEqual(extra);
        expect(reloaded?.nodes.size).toBe(graph.nodes.size + 1);
      });

      it("upsertNode replaces an existing node with the same identity", async () => {
        const graph = fixtures.makeGraph();
        await repository.saveGraph(graph);
        const nodeId = makeStateIdentity("state-a");
        const replacement = fixtures.makeNode({ id: nodeId, label: "Relabelled" });
        await repository.upsertNode(graph.runId, replacement);
        const reloaded = await repository.findByRunId(graph.runId);
        expect(reloaded?.nodes.get(nodeId)).toEqual(replacement);
        expect(reloaded?.nodes.size).toBe(graph.nodes.size);
      });

      it("upsertNode / appendEdge are no-ops (no throw) when the graph does not exist yet", async () => {
        await expect(
          repository.upsertNode("no-such-run", fixtures.makeNode()),
        ).resolves.toBeUndefined();
        await expect(
          repository.appendEdge("no-such-run", fixtures.makeEdge()),
        ).resolves.toBeUndefined();
        await expect(repository.findByRunId("no-such-run")).resolves.toBeNull();
      });

      it("appendEdge appends while preserving edge order", async () => {
        const graph = fixtures.makeGraph();
        await repository.saveGraph(graph);
        const extra = fixtures.makeEdge({ id: "edge-appended" });
        await repository.appendEdge(graph.runId, extra);
        const reloaded = await repository.findByRunId(graph.runId);
        expect(reloaded?.edges.map((e) => e.id)).toEqual([
          ...graph.edges.map((e) => e.id),
          "edge-appended",
        ]);
      });
    });

    describe("not-found (FR7)", () => {
      it("returns null for an unknown runId, never an error", async () => {
        await expect(repository.findByRunId("no-such-run")).resolves.toBeNull();
      });

      it("treats a SQL-injection-shaped runId as a plain value (T3)", async () => {
        const graph = fixtures.makeGraph();
        await repository.saveGraph(graph);
        await expect(repository.findByRunId(SQLI_PROBE_ID)).resolves.toBeNull();
        await expect(repository.findByRunId(graph.runId)).resolves.toEqual(graph);
      });
    });

    describe("findStatesByApp (deferred diffing on-ramp)", () => {
      it("returns an empty map (cross-run diffing is an explicit E7 non-goal)", async () => {
        const graph = fixtures.makeGraph();
        await repository.saveGraph(graph);
        const states = await repository.findStatesByApp(graph.appId);
        expect(states.size).toBe(0);
      });
    });

    if (reopen) {
      describe("durability across a fresh store instance (NFR1)", () => {
        it("returns the saved graph, deep-equal, from a reopened repository", async () => {
          const graph = fixtures.makeGraph();
          await repository.saveGraph(graph);
          const reopened = reopen(repository);
          await expect(reopened.findByRunId(graph.runId)).resolves.toEqual(graph);
        });
      });
    }
  });
}
