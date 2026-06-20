/**
 * In-memory fake implementations of the repository ports.
 * Used for unit tests of use-cases without a database.
 */
import type {
  RunRepository,
  StateGraphRepository,
  ReportRepository,
  Run,
  StateGraph,
  StateNode,
  StateEdge,
  StateIdentity,
  Report,
} from "@flowscout/domain";
export declare class FakeRunRepository implements RunRepository {
  private store;
  save(run: Run): Promise<void>;
  findById(id: string): Promise<Run | null>;
  findByAppId(appId: string, limit?: number): Promise<readonly Run[]>;
  update(id: string, patch: Partial<Pick<Run, "status" | "finishedAt">>): Promise<void>;
  /** Test helper: get all stored runs. */
  all(): readonly Run[];
}
export declare class FakeStateGraphRepository implements StateGraphRepository {
  private store;
  saveGraph(graph: StateGraph): Promise<void>;
  upsertNode(runId: string, node: StateNode): Promise<void>;
  appendEdge(runId: string, edge: StateEdge): Promise<void>;
  findByRunId(runId: string): Promise<StateGraph | null>;
  findStatesByApp(_appId: string): Promise<ReadonlyMap<StateIdentity, readonly string[]>>;
}
export declare class FakeReportRepository implements ReportRepository {
  private store;
  save(report: Report): Promise<void>;
  findById(reportId: string): Promise<Report | null>;
  findByRunId(runId: string): Promise<Report | null>;
  findByAppId(appId: string, limit?: number): Promise<readonly Report[]>;
}
//# sourceMappingURL=FakeRepositories.d.ts.map
