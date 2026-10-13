/**
 * InMemoryReportRepository — first-class (non-test-only) in-memory implementation
 * of the ReportRepository port (E7.1 / #83, ADR-0008 §7).
 *
 * Home: packages/application/src/crawl/persistence/ (mirrors InMemoryStateGraphRepository).
 * Reference implementation for the shared port-conformance suite.
 *
 * Upsert contract (ADR-0008 §3): `save` is an upsert keyed by runId — E4 later
 * re-saves the same run's report with `artifactUri` populated via this same method.
 */
import type { Report, ReportRepository } from "@flowscout/domain";

/** Newest-first comparator: (generatedAt, reportId) descending — pinned port ordering (#85). */
function byNewestFirst(a: Report, b: Report): number {
  return a.metadata.generatedAt === b.metadata.generatedAt
    ? b.metadata.reportId.localeCompare(a.metadata.reportId)
    : b.metadata.generatedAt.localeCompare(a.metadata.generatedAt);
}

export class InMemoryReportRepository implements ReportRepository {
  /** Keyed by runId — one report per run, latest save wins (upsert-by-runId). */
  private readonly store = new Map<string, Report>();

  save(report: Report): Promise<void> {
    this.store.set(report.metadata.runId, report);
    return Promise.resolve();
  }

  findById(reportId: string): Promise<Report | null> {
    const match = [...this.store.values()].find((r) => r.metadata.reportId === reportId) ?? null;
    return Promise.resolve(match);
  }

  findByRunId(runId: string): Promise<Report | null> {
    return Promise.resolve(this.store.get(runId) ?? null);
  }

  findByAppId(appId: string, limit?: number): Promise<readonly Report[]> {
    const results = [...this.store.values()]
      .filter((r) => r.metadata.appId === appId)
      .sort(byNewestFirst);
    return Promise.resolve(limit !== undefined ? results.slice(0, limit) : results);
  }
}
