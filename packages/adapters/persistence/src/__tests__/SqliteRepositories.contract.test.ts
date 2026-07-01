/**
 * SQLite repositories vs the shared port-conformance suite (E7.1 / #83, ADR-0008 §7).
 *
 * Every repository is created over a FRESH temp-file store, and `reopen` is
 * supplied: the durability (NFR1) sections run here — save → close the handle →
 * open a NEW handle over the SAME file → still deep-equal. This is the durable
 * side of the in-memory ⇄ SQLite parity proof.
 */
import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runRunRepositoryContract,
  defaultRunFixtures,
} from "@flowscout/testing-persistence";
import { openDatabase } from "../sqlite/Database.js";
import type { SqliteDatabase } from "../sqlite/Database.js";
import { SqliteRunRepository } from "../sqlite/SqliteRunRepository.js";

interface Storage {
  readonly path: string;
  readonly db: SqliteDatabase;
}

const tempRoots: string[] = [];
const openHandles: SqliteDatabase[] = [];
const storageByRepository = new WeakMap<object, Storage>();

afterAll(() => {
  for (const db of openHandles.splice(0)) {
    if (db.open) db.close();
  }
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Fresh, empty durable store on a brand-new temp file. */
function createStore(): Storage {
  const root = mkdtempSync(join(tmpdir(), "flowscout-sqlite-contract-"));
  tempRoots.push(root);
  const path = join(root, "flowscout.db");
  const db = openDatabase(path);
  openHandles.push(db);
  return { path, db };
}

/** NFR1 seam: close the current handle, open a NEW one over the SAME file. */
function reopenStore<T extends object>(previous: object, construct: (db: SqliteDatabase) => T): T {
  const storage = storageByRepository.get(previous);
  if (storage === undefined) {
    throw new Error("reopen called with an unknown repository instance");
  }
  if (storage.db.open) storage.db.close();
  const db = openDatabase(storage.path);
  openHandles.push(db);
  const next = construct(db);
  storageByRepository.set(next, { path: storage.path, db });
  return next;
}

function track<T extends object>(repository: T, storage: Storage): T {
  storageByRepository.set(repository, storage);
  return repository;
}

runRunRepositoryContract({
  createRepository: () => {
    const storage = createStore();
    return track(new SqliteRunRepository(storage.db), storage);
  },
  reopen: (repository) => reopenStore(repository, (db) => new SqliteRunRepository(db)),
  fixtures: defaultRunFixtures,
});
