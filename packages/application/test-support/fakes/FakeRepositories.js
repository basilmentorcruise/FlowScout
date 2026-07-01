export class FakeRunRepository {
  store = new Map();
  async save(run) {
    this.store.set(run.id, run);
  }
  async findById(id) {
    return this.store.get(id) ?? null;
  }
  async findByAppId(appId, limit) {
    const results = [...this.store.values()].filter((r) => r.appId === appId);
    return limit !== undefined ? results.slice(0, limit) : results;
  }
  async update(id, patch) {
    const existing = this.store.get(id);
    if (existing) {
      this.store.set(id, { ...existing, ...patch });
    }
  }
  /** Newest-first cross-app listing; cursor = last run id of the previous page (fake-simple). */
  async listRuns(options) {
    const sorted = [...this.store.values()].sort((a, b) =>
      a.startedAt === b.startedAt
        ? b.id.localeCompare(a.id)
        : b.startedAt.localeCompare(a.startedAt),
    );
    // Malformed/unknown cursor ⇒ findIndex -1 ⇒ start at 0 (first page — defensive per port doc).
    const start =
      options.cursor != null ? sorted.findIndex((r) => r.id === options.cursor) + 1 : 0;
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
  all() {
    return [...this.store.values()];
  }
}
export class FakeStateGraphRepository {
  store = new Map();
  async saveGraph(graph) {
    this.store.set(graph.runId, graph);
  }
  async upsertNode(runId, node) {
    const graph = this.store.get(runId);
    if (graph) {
      const newNodes = new Map(graph.nodes);
      newNodes.set(node.id, node);
      this.store.set(runId, { ...graph, nodes: newNodes });
    }
  }
  async appendEdge(runId, edge) {
    const graph = this.store.get(runId);
    if (graph) {
      this.store.set(runId, { ...graph, edges: [...graph.edges, edge] });
    }
  }
  async findByRunId(runId) {
    return this.store.get(runId) ?? null;
  }
  async findStatesByApp(_appId) {
    return new Map();
  }
}
export class FakeReportRepository {
  store = new Map();
  async save(report) {
    this.store.set(report.metadata.reportId, report);
  }
  async findById(reportId) {
    return this.store.get(reportId) ?? null;
  }
  async findByRunId(runId) {
    return [...this.store.values()].find((r) => r.metadata.runId === runId) ?? null;
  }
  async findByAppId(appId, limit) {
    const results = [...this.store.values()].filter((r) => r.metadata.appId === appId);
    return limit !== undefined ? results.slice(0, limit) : results;
  }
}
//# sourceMappingURL=FakeRepositories.js.map
