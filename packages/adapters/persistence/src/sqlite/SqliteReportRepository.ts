/**
 * SqliteReportRepository — durable ReportRepository over an injected SQLite handle
 * (E7.1 / #83, ADR-0008 §1.3/§3).
 *
 * `save` is an idempotent upsert keyed by runId (one report per run): E4 later
 * re-saves the same Report with a populated `artifactUri` through this exact
 * method — a partial update, not a create (the E7↔E4 boundary, ADR-0008 §3).
 * Because `reports` carries TWO unique keys (report_id PK, run_id UNIQUE), the
 * upsert is implemented as delete-then-insert inside ONE transaction (a single
 * ON CONFLICT target cannot cover both keys); all-or-nothing per M83.7/T9.
 *
 * M83.1/T3: prepared statements + bound params only; static SQL literals.
 */
import type { Report, ReportRepository } from "@flowscout/domain";
import type { SqliteDatabase } from "./Database.js";
import { decodeReport, encodeReport } from "./codec/ReportCodec.js";
import { resolveAfter } from "./promiseBridge.js";

/** `LIMIT -1` = no limit in SQLite — used when `findByAppId` gets no limit. */
const NO_LIMIT = -1;

interface PayloadRow {
  readonly payload: string;
}

interface ReportInsertParams {
  readonly reportId: string;
  readonly runId: string;
  readonly appId: string;
  readonly runStatus: string;
  readonly generatedAt: string;
  readonly payload: string;
}

const INSERT_SQL = `
INSERT INTO reports (report_id, run_id, app_id, run_status, generated_at, payload)
VALUES (@reportId, @runId, @appId, @runStatus, @generatedAt, @payload)
`;

export class SqliteReportRepository implements ReportRepository {
  private readonly insert;
  private readonly deleteConflicting;
  private readonly selectById;
  private readonly selectByRunId;
  private readonly selectByAppId;
  private readonly saveInTransaction;

  constructor(db: SqliteDatabase) {
    this.insert = db.prepare<ReportInsertParams>(INSERT_SQL);
    this.deleteConflicting = db.prepare<[string, string]>(
      "DELETE FROM reports WHERE run_id = ? OR report_id = ?",
    );
    this.selectById = db.prepare<[string], PayloadRow>(
      "SELECT payload FROM reports WHERE report_id = ?",
    );
    this.selectByRunId = db.prepare<[string], PayloadRow>(
      "SELECT payload FROM reports WHERE run_id = ?",
    );
    this.selectByAppId = db.prepare<[string, number], PayloadRow>(
      "SELECT payload FROM reports WHERE app_id = ? ORDER BY generated_at DESC, report_id DESC LIMIT ?",
    );
    // ONE transaction per save (M83.7/T9) — upsert across BOTH unique keys.
    this.saveInTransaction = db.transaction((report: Report) => {
      this.deleteConflicting.run(report.metadata.runId, report.metadata.reportId);
      this.insert.run({
        reportId: report.metadata.reportId,
        runId: report.metadata.runId,
        appId: report.metadata.appId,
        runStatus: report.metadata.runStatus,
        generatedAt: report.metadata.generatedAt,
        payload: encodeReport(report),
      });
    });
  }

  save(report: Report): Promise<void> {
    return resolveAfter(() => {
      this.saveInTransaction(report);
    });
  }

  findById(reportId: string): Promise<Report | null> {
    const row = this.selectById.get(reportId);
    return Promise.resolve(row === undefined ? null : decodeReport(row.payload));
  }

  findByRunId(runId: string): Promise<Report | null> {
    const row = this.selectByRunId.get(runId);
    return Promise.resolve(row === undefined ? null : decodeReport(row.payload));
  }

  findByAppId(appId: string, limit?: number): Promise<readonly Report[]> {
    const rows = this.selectByAppId.all(appId, limit ?? NO_LIMIT);
    return Promise.resolve(rows.map((row) => decodeReport(row.payload)));
  }
}
