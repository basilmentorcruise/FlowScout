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
  ListRunsOptions,
  RunPage,
} from "@flowscout/domain";

export class FakeRunRepository implements RunRepository {
  private store = new Map<string, Run>();

  async save(run: Run): Promise<void> {
    this.store.set(run.id, run);
  }

  async findById(id: string): Promise<Run | null> {
    return this.store.get(id) ?? null;
  }

  async findByAppId(appId: string, limit?: number): Promise<readonly Run[]> {
    const results = [...this.store.values()].filter((r) => r.appId === appId);
    return limit !== undefined ? results.slice(0, limit) : results;
  }

  async update(id: string, patch: Partial<Pick<Run, "status" | "finishedAt">>): Promise<void> {
    const existing = this.store.get(id);
    if (existing) {
      this.store.set(id, { ...existing, ...patch });
    }
  }

  /** Newest-first cross-app listing; cursor = last run id of the previous page (fake-simple). */
  async listRuns(options: ListRunsOptions): Promise<RunPage> {
    const sorted = [...this.store.values()].sort((a, b) =>
      a.startedAt === b.startedAt
        ? b.id.localeCompare(a.id)
        : b.startedAt.localeCompare(a.startedAt),
    );
    // Malformed/unknown cursor ⇒ findIndex -1 ⇒ start at 0 (first page — defensive per port doc).
    const start = options.cursor != null ? sorted.findIndex((r) => r.id === options.cursor) + 1 : 0;
    const page = sorted.slice(start, start + options.limit);
    const hasMore = start + options.limit < sorted.length;
    const lastOnPage = page[page.length - 1];
    return {
      runs: page,
      nextCursor: hasMore && lastOnPage !== undefined ? lastOnPage.id : null,
      total: sorted.length,
    };
  }

  /** Test helper: get all stored runs. */
  all(): readonly Run[] {
    return [...this.store.values()];
  }
}

export class FakeStateGraphRepository implements StateGraphRepository {
  private store = new Map<string, StateGraph>();

  async saveGraph(graph: StateGraph): Promise<void> {
    this.store.set(graph.runId, graph);
  }

  async upsertNode(runId: string, node: StateNode): Promise<void> {
    const graph = this.store.get(runId);
    if (graph) {
      const newNodes = new Map(graph.nodes);
      newNodes.set(node.id, node);
      this.store.set(runId, { ...graph, nodes: newNodes });
    }
  }

  async appendEdge(runId: string, edge: StateEdge): Promise<void> {
    const graph = this.store.get(runId);
    if (graph) {
      this.store.set(runId, { ...graph, edges: [...graph.edges, edge] });
    }
  }

  async findByRunId(runId: string): Promise<StateGraph | null> {
    return this.store.get(runId) ?? null;
  }

  async findStatesByApp(_appId: string): Promise<ReadonlyMap<StateIdentity, readonly string[]>> {
    return new Map();
  }
}

export class FakeReportRepository implements ReportRepository {
  private store = new Map<string, Report>();

  async save(report: Report): Promise<void> {
    this.store.set(report.metadata.reportId, report);
  }

  async findById(reportId: string): Promise<Report | null> {
    return this.store.get(reportId) ?? null;
  }

  async findByRunId(runId: string): Promise<Report | null> {
    return [...this.store.values()].find((r) => r.metadata.runId === runId) ?? null;
  }

  async findByAppId(appId: string, limit?: number): Promise<readonly Report[]> {
    const results = [...this.store.values()].filter((r) => r.metadata.appId === appId);
    return limit !== undefined ? results.slice(0, limit) : results;
  }
}
