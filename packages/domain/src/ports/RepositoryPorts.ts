/**
 * Repository ports — persistence abstractions for the three core aggregates.
 * Implemented in adapters/persistence (durable store per ADR-0008 — embedded SQLite for MVP;
 * Postgres remains the documented scale-out target behind the same ports).
 */
import type { Run } from "../models/run.js";
import type { StateGraph, StateIdentity, StateNode, StateEdge } from "../models/state-graph.js";
import type { Report } from "../models/report.js";

/**
 * Options for cross-app paginated run listing (ADR-0008 §4).
 * `cursor` is an opaque token from a previous page's `nextCursor`;
 * null/undefined ⇒ first page. Implementations MUST treat a malformed
 * cursor as the first page (defensive decode — never a throw).
 */
export interface ListRunsOptions {
  readonly limit: number;
  readonly cursor?: string | null;
}

/** One page of runs, newest-first (ADR-0008 §4). */
export interface RunPage {
  readonly runs: readonly Run[];
  /** Opaque cursor for the next page, or null when this is the last page. */
  readonly nextCursor: string | null;
  /** Total number of runs in the store (across all pages). */
  readonly total: number;
}

/** RunRepository — manages crawl run lifecycle records. */
export interface RunRepository {
  save(run: Run): Promise<void>;
  findById(id: string): Promise<Run | null>;
  /**
   * One app's runs, NEWEST-FIRST by (startedAt, id) descending (#85 —
   * pinned ordering; the conformance suite asserts it on every impl).
   */
  findByAppId(appId: string, limit?: number): Promise<readonly Run[]>;
  update(id: string, patch: Partial<Pick<Run, "status" | "finishedAt">>): Promise<void>;
  /** Cross-app run history: newest-first by (startedAt, id), cursor-paginated (FR6). */
  listRuns(options: ListRunsOptions): Promise<RunPage>;
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
  /**
   * One app's reports, NEWEST-FIRST by (generatedAt, reportId) descending
   * (#85 — pinned ordering; the conformance suite asserts it on every impl).
   */
  findByAppId(appId: string, limit?: number): Promise<readonly Report[]>;
}
