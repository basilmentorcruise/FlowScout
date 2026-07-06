/**
 * SQLite connection module for the durable run store (E7.1 / #83, ADR-0008 §1).
 *
 * Zero-setup (NFR2): `openDatabase` creates the data directory + DB file on first
 * construction and runs `CREATE TABLE IF NOT EXISTS` — no server, no daemon, no docker.
 *
 * Security (e7 threat model):
 *   - T2/M83.2: the store path is CONFIG-OWNED (`FLOWSCOUT_DB_PATH`, single file) —
 *     no `appId`/`runId` is ever spliced into a filesystem path. Directories this
 *     module creates are 0700 and the DB file is created 0600 BEFORE SQLite opens it;
 *     SQLite copies the DB file's permission bits onto the `-wal`/`-shm` sidecars.
 *     Pre-existing directories are left untouched (never chmod the user's cwd).
 *   - T9/M83.7: `PRAGMA journal_mode=WAL` is set at init so a crash cannot leave a
 *     half-written row; every repository `save*` runs in one transaction.
 */
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import BetterSqlite3 from "better-sqlite3";

/** Concrete handle type — shared by the three Sqlite* repositories (DI). */
export type SqliteDatabase = BetterSqlite3.Database;

/** Env var naming the SQLite file (config-owned data location — T2). */
export const FLOWSCOUT_DB_PATH_ENV = "FLOWSCOUT_DB_PATH";

/** Default store location when `FLOWSCOUT_DB_PATH` is unset (ADR-0008 §1). */
export const DEFAULT_DB_PATH = "./.flowscout/flowscout.db";

/** In-memory SQLite pseudo-path (tests) — skips all filesystem preparation. */
const MEMORY_PATH = ":memory:";

/** Owner-only permissions for anything this module creates (T2/M83.2). */
const OWNER_ONLY_DIR_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;

/**
 * Resolve the DB path from config/env. The path NEVER derives from `appId`/`runId`
 * or any other request data — single file, config-owned (T2, by construction).
 */
export function resolveDatabasePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = env[FLOWSCOUT_DB_PATH_ENV];
  if (configured !== undefined && configured.trim().length > 0) {
    return configured;
  }
  return DEFAULT_DB_PATH;
}

/**
 * Create the parent directory (0700, only if missing) and the DB file (0600, only
 * if missing) so at-rest permissions are restrictive from the very first byte.
 * Pre-existing directories keep their modes — we never chmod paths we did not create.
 */
function prepareSecureStoreLocation(path: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
  // "a" creates the file iff missing; mode applies only at creation time.
  closeSync(openSync(path, "a", OWNER_ONLY_FILE_MODE));
}

/** DDL for the hybrid schema — indexed scalar columns + one JSON payload per aggregate (ADR-0008 §1.3). */
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  app_id         TEXT NOT NULL,
  app_version    TEXT NOT NULL,
  platform       TEXT NOT NULL,
  status         TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  driver_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  payload        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_app_id ON runs (app_id);
CREATE INDEX IF NOT EXISTS idx_runs_history ON runs (started_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS graphs (
  run_id      TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL,
  app_version TEXT NOT NULL,
  payload     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graphs_app_id ON graphs (app_id);

CREATE TABLE IF NOT EXISTS reports (
  report_id    TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL UNIQUE,
  app_id       TEXT NOT NULL,
  run_status   TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  payload      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_app_id ON reports (app_id);
`;

/**
 * Open (and, on first run, initialize) the FlowScout run store.
 *
 * Injectable factory (DI): the composition root opens ONE handle per process and
 * injects it into the three repositories; tests pass `:memory:` or a temp file
 * (the temp-file variant powers the reopen/durability conformance section — NFR1).
 */
export function openDatabase(path: string = resolveDatabasePath()): SqliteDatabase {
  if (path !== MEMORY_PATH) {
    prepareSecureStoreLocation(path);
  }
  const db = new BetterSqlite3(path);
  // T9/M83.7 — WAL at init: crash-safe, all-or-nothing single-row writes.
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_DDL);
  return db;
}
