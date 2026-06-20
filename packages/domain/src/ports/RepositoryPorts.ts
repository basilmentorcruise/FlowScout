/**
 * Repository ports — persistence abstractions for the three core aggregates.
 * Implemented in adapters/persistence (PostgreSQL + Prisma for MVP).
 */
import type { Run } from "../models/run.js";
import type { StateGraph, StateIdentity, StateNode, StateEdge } from "../models/state-graph.js";
import type { Report } from "../models/report.js";

/** RunRepository — manages crawl run lifecycle records. */
export interface RunRepository {
  save(run: Run): Promise<void>;
  findById(id: string): Promise<Run | null>;
  findByAppId(appId: string, limit?: number): Promise<readonly Run[]>;
  update(id: string, patch: Partial<Pick<Run, "status" | "finishedAt">>): Promise<void>;
}

/** StateGraphRepository — persists and retrieves the per-run state-graph. */
export interface StateGraphRepository {
  /** Upsert the full graph (idempotent on runId). */
  saveGraph(graph: StateGraph): Promise<void>;
  /** Append a single node (incremental updates during the crawl). */
  upsertNode(runId: string, node: StateNode): Promise<void>;
  /** Append a single edge. */
  appendEdge(runId: string, edge: StateEdge): Promise<void>;
  findByRunId(runId: string): Promise<StateGraph | null>;
  /** Returns all state identities seen for an app (cross-run, for diffing). */
  findStatesByApp(appId: string): Promise<ReadonlyMap<StateIdentity, readonly string[]>>;
}

/** ReportRepository — manages generated report metadata. */
export interface ReportRepository {
  save(report: Report): Promise<void>;
  findById(reportId: string): Promise<Report | null>;
  findByRunId(runId: string): Promise<Report | null>;
  findByAppId(appId: string, limit?: number): Promise<readonly Report[]>;
}
