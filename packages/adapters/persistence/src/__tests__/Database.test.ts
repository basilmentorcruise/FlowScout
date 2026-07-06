/**
 * Database connection module tests (E7.1 / #83, ADR-0008 §1).
 *
 * Covers the zero-setup AC (constructing the store with no env/service pre-run
 * initializes tables) plus the T2/M83.2 at-rest controls: config-owned data dir
 * created 0700, DB file created 0600, no appId/runId in any filesystem path
 * (the path comes from config alone), and the T9/M83.7 WAL-at-init control.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase,
  resolveDatabasePath,
  FLOWSCOUT_DB_PATH_ENV,
  DEFAULT_DB_PATH,
} from "../sqlite/Database.js";
import type { SqliteDatabase } from "../sqlite/Database.js";

const POSIX_PERMISSION_MASK = 0o777;
const OWNER_ONLY_DIR = 0o700;
const OWNER_ONLY_FILE = 0o600;

describe("resolveDatabasePath", () => {
  it("defaults to ./.flowscout/flowscout.db when the env var is unset or blank", () => {
    expect(resolveDatabasePath({})).toBe(DEFAULT_DB_PATH);
    expect(resolveDatabasePath({ [FLOWSCOUT_DB_PATH_ENV]: "   " })).toBe(DEFAULT_DB_PATH);
  });

  it("honours FLOWSCOUT_DB_PATH when set", () => {
    expect(resolveDatabasePath({ [FLOWSCOUT_DB_PATH_ENV]: "/tmp/custom/store.db" })).toBe(
      "/tmp/custom/store.db",
    );
  });
});

describe("openDatabase", () => {
  const cleanups: Array<() => void> = [];
  const openHandles: SqliteDatabase[] = [];

  afterEach(() => {
    for (const db of openHandles.splice(0)) {
      if (db.open) db.close();
    }
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  function makeTempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "flowscout-db-test-"));
    cleanups.push(() => {
      rmSync(root, { recursive: true, force: true });
    });
    return root;
  }

  function open(path: string): SqliteDatabase {
    const db = openDatabase(path);
    openHandles.push(db);
    return db;
  }

  it("zero-setup: creates the data dir + file and initializes all three tables (AC)", () => {
    const root = makeTempRoot();
    const dbPath = join(root, "data", "flowscout.db");
    const db = open(dbPath);
    expect(existsSync(dbPath)).toBe(true);
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(["runs", "graphs", "reports"]));
  });

  it("creates the data dir 0700 and the DB file 0600 (T2/M83.2)", () => {
    const root = makeTempRoot();
    const dataDir = join(root, "data");
    const dbPath = join(dataDir, "flowscout.db");
    open(dbPath);
    expect(statSync(dataDir).mode & POSIX_PERMISSION_MASK).toBe(OWNER_ONLY_DIR);
    expect(statSync(dbPath).mode & POSIX_PERMISSION_MASK).toBe(OWNER_ONLY_FILE);
  });

  it("does not tighten permissions on a pre-existing directory it did not create", () => {
    const root = makeTempRoot();
    const preExisting = join(root, "already-here");
    mkdirSync(preExisting, { mode: 0o755 });
    open(join(preExisting, "flowscout.db"));
    expect(statSync(preExisting).mode & POSIX_PERMISSION_MASK).toBe(0o755);
  });

  it("sets journal_mode=WAL at init (T9/M83.7)", () => {
    const root = makeTempRoot();
    const db = open(join(root, "flowscout.db"));
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("is idempotent: reopening an existing store keeps schema and data intact", () => {
    const root = makeTempRoot();
    const dbPath = join(root, "flowscout.db");
    const first = open(dbPath);
    first
      .prepare(
        "INSERT INTO runs (id, app_id, app_version, platform, status, started_at, driver_version, policy_version, schema_version, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("r1", "a1", "1.0", "ios", "running", "2026-07-02T10:00:00.000Z", "d", "p", "s", "{}");
    first.close();
    const second = open(dbPath);
    const row = second
      .prepare<[string], { id: string }>("SELECT id FROM runs WHERE id = ?")
      .get("r1");
    expect(row?.id).toBe("r1");
  });

  it("supports :memory: for tests without touching the filesystem", () => {
    const db = openDatabase(":memory:");
    openHandles.push(db);
    const count = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM runs").get();
    expect(count?.n).toBe(0);
  });
});
