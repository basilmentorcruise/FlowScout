/**
 * SqliteStateGraphRepository — durable StateGraphRepository over an injected
 * SQLite handle (E7.1 / #83, ADR-0008 §1.3). The graph payload is the source of
 * truth; states/edges are deliberately NOT normalized into tables for MVP.
 *
 * Security (e7 threat model):
 *   - M83.1/T3: prepared statements + bound params only; static SQL literals.
 *   - M83.5/T1: `assertNoUnredactedSecureField` runs before every graph write
 *     (defense-in-depth; the transaction never commits on a hit).
 *   - M83.7/T9: every write runs in ONE better-sqlite3 transaction.
 *
 * `findStatesByApp` stays empty — cross-run diffing is an explicit E7 non-goal.
 */
import type {
  StateEdge,
  StateGraph,
  StateGraphRepository,
  StateIdentity,
  StateNode,
} from "@flowscout/domain";
import type { SqliteDatabase } from "./Database.js";
import { decodeGraph, encodeGraph } from "./codec/GraphCodec.js";
import { assertNoUnredactedSecureField } from "./redactionGuard.js";

interface PayloadRow {
  readonly payload: string;
}

interface GraphUpsertParams {
  readonly runId: string;
  readonly appId: string;
  readonly appVersion: string;
  readonly payload: string;
}

const UPSERT_SQL = `
INSERT INTO graphs (run_id, app_id, app_version, payload)
VALUES (@runId, @appId, @appVersion, @payload)
ON CONFLICT (run_id) DO UPDATE SET
  app_id = excluded.app_id,
  app_version = excluded.app_version,
  payload = excluded.payload
`;

export class SqliteStateGraphRepository implements StateGraphRepository {
  private readonly upsert;
  private readonly selectByRunId;
  private readonly saveInTransaction;
  private readonly upsertNodeInTransaction;
  private readonly appendEdgeInTransaction;

  constructor(db: SqliteDatabase) {
    this.upsert = db.prepare<GraphUpsertParams>(UPSERT_SQL);
    this.selectByRunId = db.prepare<[string], PayloadRow>(
      "SELECT payload FROM graphs WHERE run_id = ?",
    );
    // ONE transaction per save (M83.7/T9 — all-or-nothing).
    this.saveInTransaction = db.transaction((graph: StateGraph) => {
      this.writeGraph(graph);
    });
    this.upsertNodeInTransaction = db.transaction((runId: string, node: StateNode) => {
      const existing = this.readGraph(runId);
      if (existing === null) return; // no graph yet ⇒ no-op (contract)
      const nodes = new Map(existing.nodes);
      nodes.set(node.id, node);
      this.writeGraph({ ...existing, nodes });
    });
    this.appendEdgeInTransaction = db.transaction((runId: string, edge: StateEdge) => {
      const existing = this.readGraph(runId);
      if (existing === null) return; // no graph yet ⇒ no-op (contract)
      this.writeGraph({ ...existing, edges: [...existing.edges, edge] });
    });
  }

  saveGraph(graph: StateGraph): Promise<void> {
    this.saveInTransaction(graph);
    return Promise.resolve();
  }

  upsertNode(runId: string, node: StateNode): Promise<void> {
    this.upsertNodeInTransaction(runId, node);
    return Promise.resolve();
  }

  appendEdge(runId: string, edge: StateEdge): Promise<void> {
    this.appendEdgeInTransaction(runId, edge);
    return Promise.resolve();
  }

  findByRunId(runId: string): Promise<StateGraph | null> {
    return Promise.resolve(this.readGraph(runId));
  }

  /** Cross-run diffing is an explicit E7 non-goal — always empty (ADR-0008 R-C). */
  findStatesByApp(_appId: string): Promise<ReadonlyMap<StateIdentity, readonly string[]>> {
    return Promise.resolve(new Map<StateIdentity, readonly string[]>());
  }

  private readGraph(runId: string): StateGraph | null {
    const row = this.selectByRunId.get(runId);
    return row === undefined ? null : decodeGraph(row.payload);
  }

  private writeGraph(graph: StateGraph): void {
    // Defense-in-depth save-time scan (M83.5/T1) — throws before any write.
    assertNoUnredactedSecureField(graph.nodes.values());
    this.upsert.run({
      runId: graph.runId,
      appId: graph.appId,
      appVersion: graph.appVersion,
      payload: encodeGraph(graph),
    });
  }
}
