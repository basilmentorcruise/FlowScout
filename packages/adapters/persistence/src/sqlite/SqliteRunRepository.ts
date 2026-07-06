/**
 * SqliteRunRepository — durable RunRepository over an injected SQLite handle
 * (E7.1 / #83, ADR-0008 §1/§4). Repository pattern; the handle is opened ONCE
 * at the composition root and shared by all three repositories (DI).
 *
 * Security (e7 threat model):
 *   - M83.1/T3: every statement below is a PREPARED statement with bound `?`/named
 *     params; table/column names are static literals — no concatenated SQL.
 *   - M83.4/T4: the pagination cursor is decoded defensively (`decodeRunPageCursor`);
 *     malformed ⇒ first page; decoded scalars enter the WHERE clause as bound params.
 *   - M83.7/T9: every write runs in ONE better-sqlite3 transaction (all-or-nothing).
 *
 * The `payload` column is the source of truth for reload; scalar columns are
 * derived duplicates used only for filtering/ordering (ADR-0008 §1.3).
 */
import type { ListRunsOptions, Run, RunPage, RunRepository } from "@flowscout/domain";
import type { SqliteDatabase } from "./Database.js";
import { decodeRun, encodeRun } from "./codec/RunCodec.js";
import { decodeRunPageCursor, encodeRunPageCursor } from "./cursor.js";
import { resolveAfter } from "./promiseBridge.js";

/** Fallback page size when the caller supplies a non-positive/non-integer limit. */
const DEFAULT_PAGE_SIZE = 50;

/** `LIMIT -1` = no limit in SQLite — used when `findByAppId` gets no limit. */
const NO_LIMIT = -1;

interface PayloadRow {
  readonly payload: string;
}

interface RunUpsertParams {
  readonly id: string;
  readonly appId: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly driverVersion: string;
  readonly policyVersion: string;
  readonly schemaVersion: string;
  readonly payload: string;
}

const UPSERT_SQL = `
INSERT INTO runs (id, app_id, app_version, platform, status, started_at, finished_at,
                  driver_version, policy_version, schema_version, payload)
VALUES (@id, @appId, @appVersion, @platform, @status, @startedAt, @finishedAt,
        @driverVersion, @policyVersion, @schemaVersion, @payload)
ON CONFLICT (id) DO UPDATE SET
  app_id = excluded.app_id,
  app_version = excluded.app_version,
  platform = excluded.platform,
  status = excluded.status,
  started_at = excluded.started_at,
  finished_at = excluded.finished_at,
  driver_version = excluded.driver_version,
  policy_version = excluded.policy_version,
  schema_version = excluded.schema_version,
  payload = excluded.payload
`;

const PAGE_FIRST_SQL = `
SELECT payload FROM runs
ORDER BY started_at DESC, id DESC
LIMIT ?
`;

const PAGE_AFTER_CURSOR_SQL = `
SELECT payload FROM runs
WHERE started_at < @startedAt OR (started_at = @startedAt AND id < @id)
ORDER BY started_at DESC, id DESC
LIMIT @limit
`;

export class SqliteRunRepository implements RunRepository {
  private readonly upsert;
  private readonly selectById;
  private readonly selectByAppId;
  private readonly updateById;
  private readonly countAll;
  private readonly pageFirst;
  private readonly pageAfterCursor;
  private readonly saveInTransaction;
  private readonly updateInTransaction;

  constructor(db: SqliteDatabase) {
    this.upsert = db.prepare<RunUpsertParams>(UPSERT_SQL);
    this.selectById = db.prepare<[string], PayloadRow>("SELECT payload FROM runs WHERE id = ?");
    this.selectByAppId = db.prepare<[string, number], PayloadRow>(
      "SELECT payload FROM runs WHERE app_id = ? ORDER BY started_at DESC, id DESC LIMIT ?",
    );
    this.updateById = db.prepare<[string, string | null, string, string]>(
      "UPDATE runs SET status = ?, finished_at = ?, payload = ? WHERE id = ?",
    );
    this.countAll = db.prepare<[], { total: number }>("SELECT COUNT(*) AS total FROM runs");
    this.pageFirst = db.prepare<[number], PayloadRow>(PAGE_FIRST_SQL);
    this.pageAfterCursor = db.prepare<{ startedAt: string; id: string; limit: number }, PayloadRow>(
      PAGE_AFTER_CURSOR_SQL,
    );
    // ONE transaction per save/update (M83.7/T9 — all-or-nothing).
    this.saveInTransaction = db.transaction((run: Run) => {
      this.upsert.run(toUpsertParams(run));
    });
    this.updateInTransaction = db.transaction(
      (id: string, patch: Partial<Pick<Run, "status" | "finishedAt">>) => {
        const row = this.selectById.get(id);
        if (row === undefined) return; // unknown id ⇒ no-op (contract)
        const merged: Run = { ...decodeRun(row.payload), ...patch };
        this.updateById.run(merged.status, merged.finishedAt, encodeRun(merged), id);
      },
    );
  }

  save(run: Run): Promise<void> {
    return resolveAfter(() => {
      this.saveInTransaction(run);
    });
  }

  findById(id: string): Promise<Run | null> {
    const row = this.selectById.get(id);
    return Promise.resolve(row === undefined ? null : decodeRun(row.payload));
  }

  findByAppId(appId: string, limit?: number): Promise<readonly Run[]> {
    const rows = this.selectByAppId.all(appId, limit ?? NO_LIMIT);
    return Promise.resolve(rows.map((row) => decodeRun(row.payload)));
  }

  update(id: string, patch: Partial<Pick<Run, "status" | "finishedAt">>): Promise<void> {
    return resolveAfter(() => {
      this.updateInTransaction(id, patch);
    });
  }

  listRuns(options: ListRunsOptions): Promise<RunPage> {
    const limit =
      Number.isInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_PAGE_SIZE;
    const cursor = decodeRunPageCursor(options.cursor);
    // Fetch limit+1 rows to learn whether a next page exists without a second query.
    const probeLimit = limit + 1;
    const rows = cursor
      ? this.pageAfterCursor.all({ startedAt: cursor.startedAt, id: cursor.id, limit: probeLimit })
      : this.pageFirst.all(probeLimit);
    const hasMore = rows.length > limit;
    const runs = rows.slice(0, limit).map((row) => decodeRun(row.payload));
    const lastOnPage = runs[runs.length - 1];
    return Promise.resolve({
      runs,
      nextCursor:
        hasMore && lastOnPage !== undefined
          ? encodeRunPageCursor({ startedAt: lastOnPage.startedAt, id: lastOnPage.id })
          : null,
      total: this.countAll.get()?.total ?? 0,
    });
  }
}

function toUpsertParams(run: Run): RunUpsertParams {
  return {
    id: run.id,
    appId: run.appId,
    appVersion: run.appVersion,
    platform: run.platform,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    driverVersion: run.driverVersion,
    policyVersion: run.policyVersion,
    schemaVersion: run.schemaVersion,
    payload: encodeRun(run),
  };
}
