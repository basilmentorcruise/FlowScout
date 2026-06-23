/**
 * InMemoryStateGraphRepository — first-class (non-test-only) in-memory implementation
 * of the StateGraphRepository port.
 *
 * Home: packages/application/src/crawl/persistence/ per ADR-0004 §5.
 *
 * This is the development/CI stand-in used until E7 ships the Prisma/Postgres
 * implementation in packages/adapters/persistence. The composition root swaps it
 * with a single-line change (Open/Closed principle).
 *
 * Security: no PII/secrets written here — callers are responsible for redaction
 * before passing node/edge data (T7 boundary is enforced upstream in the loop).
 */
import type {
  StateGraphRepository,
  StateGraph,
  StateNode,
  StateEdge,
  StateIdentity,
} from "@flowscout/domain";

/** Internal mutable representation stored in the map. */
interface MutableStateGraph {
  runId: string;
  appId: string;
  appVersion: string;
  platform: "ios" | "android";
  nodes: Map<StateIdentity, StateNode>;
  edges: StateEdge[];
  duplicatePathNodeIds: Set<StateIdentity>;
}

export class InMemoryStateGraphRepository implements StateGraphRepository {
  private readonly store = new Map<string, MutableStateGraph>();

  saveGraph(graph: StateGraph): Promise<void> {
    // Clone to avoid aliasing the caller's maps
    this.store.set(graph.runId, {
      runId: graph.runId,
      appId: graph.appId,
      appVersion: graph.appVersion,
      platform: graph.platform,
      nodes: new Map(graph.nodes),
      edges: [...graph.edges],
      duplicatePathNodeIds: new Set(graph.duplicatePathNodeIds),
    });
    return Promise.resolve();
  }

  upsertNode(runId: string, node: StateNode): Promise<void> {
    const graph = this.store.get(runId);
    if (graph) {
      graph.nodes.set(node.id, node);
    }
    // No-op if graph doesn't exist yet (initialise graph before adding nodes).
    return Promise.resolve();
  }

  appendEdge(runId: string, edge: StateEdge): Promise<void> {
    const graph = this.store.get(runId);
    if (graph) {
      graph.edges.push(edge);
    }
    // No-op if graph doesn't exist yet.
    return Promise.resolve();
  }

  findByRunId(runId: string): Promise<StateGraph | null> {
    const graph = this.store.get(runId);
    if (!graph) {
      return Promise.resolve(null);
    }
    // Return a snapshot (immutable-shaped) to avoid aliasing internals
    const snapshot: StateGraph = {
      runId: graph.runId,
      appId: graph.appId,
      appVersion: graph.appVersion,
      platform: graph.platform,
      nodes: new Map(graph.nodes),
      edges: [...graph.edges],
      duplicatePathNodeIds: new Set(graph.duplicatePathNodeIds),
    };
    return Promise.resolve(snapshot);
  }

  /**
   * Cross-run state lookup — deferred to E7 (durable Postgres impl).
   * Returns an empty map to satisfy the port contract without DB access.
   */
  findStatesByApp(_appId: string): Promise<ReadonlyMap<StateIdentity, readonly string[]>> {
    return Promise.resolve(new Map<StateIdentity, readonly string[]>());
  }
}
