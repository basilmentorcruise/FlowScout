/**
 * Store-level security/integrity evidence (E7.1 / #83, e7 threat model).
 *
 *   - T9/M83.7: reopen-durability — write all three aggregates, CLOSE the handle,
 *     reopen the same file: rows intact and non-torn; WAL persists across reopen.
 *   - T1/M83.5 (SHOULD): the save-time redaction guard fails a graph save carrying
 *     an un-redacted secure-field value with a typed error, commits NOTHING (no
 *     torn row), and never echoes the secret value.
 *   - T3/M83.1 (grep-adjacent): hostile ids already covered by the conformance
 *     suite; here we assert the guard error path leaves the store serviceable.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultRunFixtures,
  defaultGraphFixtures,
  defaultReportFixtures,
} from "@flowscout/testing-persistence";
import { openDatabase } from "../sqlite/Database.js";
import type { SqliteDatabase } from "../sqlite/Database.js";
import { SqliteRunRepository } from "../sqlite/SqliteRunRepository.js";
import { SqliteStateGraphRepository } from "../sqlite/SqliteStateGraphRepository.js";
import { SqliteReportRepository } from "../sqlite/SqliteReportRepository.js";
import { assertNoUnredactedSecureField, UnredactedSecretError } from "../sqlite/redactionGuard.js";

/** E3 seeded-secret markers (threat model T1) — must NEVER survive into the store. */
const SEEDED_SECRET = "hunter2-SECRET";

const cleanups: Array<() => void> = [];
const openHandles: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of openHandles.splice(0)) {
    if (db.open) db.close();
  }
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeDbPath(): string {
  const root = mkdtempSync(join(tmpdir(), "flowscout-durability-"));
  cleanups.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return join(root, "flowscout.db");
}

function open(path: string): SqliteDatabase {
  const db = openDatabase(path);
  openHandles.push(db);
  return db;
}

describe("reopen durability — write → close → reopen → intact (T9/M83.7, NFR1)", () => {
  it("returns all three aggregates deep-equal from a fresh handle over the same file", async () => {
    const path = makeDbPath();
    const run = defaultRunFixtures.makeRun({
      status: "completed",
      finishedAt: "2026-07-02T11:00:00.000Z",
    });
    const graph = defaultGraphFixtures.makeGraph({ runId: run.id });
    const report = defaultReportFixtures.makeReport();

    const db = open(path);
    await new SqliteRunRepository(db).save(run);
    await new SqliteStateGraphRepository(db).saveGraph(graph);
    await new SqliteReportRepository(db).save(report);
    db.close(); // full process-restart simulation — nothing cached survives

    const reopened = open(path);
    expect(reopened.pragma("journal_mode", { simple: true })).toBe("wal");
    await expect(new SqliteRunRepository(reopened).findById(run.id)).resolves.toEqual(run);
    await expect(new SqliteStateGraphRepository(reopened).findByRunId(run.id)).resolves.toEqual(
      graph,
    );
    await expect(
      new SqliteReportRepository(reopened).findByRunId(report.metadata.runId),
    ).resolves.toEqual(report);
  });

  it("keeps an in-flight 'running' row discoverable after close+reopen (FR4 crash shape)", async () => {
    const path = makeDbPath();
    const running = defaultRunFixtures.makeRun({ status: "running", finishedAt: null });
    const db = open(path);
    await new SqliteRunRepository(db).save(running);
    db.close();
    const reloaded = await new SqliteRunRepository(open(path)).findById(running.id);
    expect(reloaded?.status).toBe("running");
    expect(reloaded?.finishedAt).toBeNull();
  });
});

describe("save-time redaction guard (T1/M83.5 defense-in-depth)", () => {
  function graphWithUnredactedSecret() {
    const node = defaultGraphFixtures.makeNode({
      a11ySnapshot: JSON.stringify({
        role: "screen",
        children: [{ role: "secureTextField", label: "Password", value: SEEDED_SECRET }],
      }),
    });
    return defaultGraphFixtures.makeGraph({
      nodes: new Map([[node.id, node]]),
      edges: [],
      duplicatePathNodeIds: new Set(),
    });
  }

  it("fails the save with a typed error and commits nothing (no torn row)", async () => {
    const db = open(makeDbPath());
    const repository = new SqliteStateGraphRepository(db);
    const hostile = graphWithUnredactedSecret();
    await expect(repository.saveGraph(hostile)).rejects.toBeInstanceOf(UnredactedSecretError);
    // Nothing was written — the transaction never committed.
    await expect(repository.findByRunId(hostile.runId)).resolves.toBeNull();
    // The store stays fully serviceable afterwards.
    const clean = defaultGraphFixtures.makeGraph();
    await repository.saveGraph(clean);
    await expect(repository.findByRunId(clean.runId)).resolves.toEqual(clean);
  });

  it("never echoes the secret value in the error (no new sink)", async () => {
    const repository = new SqliteStateGraphRepository(open(makeDbPath()));
    await expect(repository.saveGraph(graphWithUnredactedSecret())).rejects.toSatisfy(
      (error: unknown) => error instanceof Error && !error.message.includes(SEEDED_SECRET),
    );
  });

  it("accepts [REDACTED] and empty secure-field values; skips non-JSON snapshots", () => {
    const redacted = defaultGraphFixtures.makeNode(); // fixture carries value:[REDACTED]
    const empty = defaultGraphFixtures.makeNode({
      a11ySnapshot: JSON.stringify({ role: "secureTextField", value: "" }),
    });
    const nonJson = defaultGraphFixtures.makeNode({ a11ySnapshot: "not-json-at-all" });
    expect(() => {
      assertNoUnredactedSecureField([redacted, empty, nonJson]);
    }).not.toThrow();
    const leaky = defaultGraphFixtures.makeNode({
      a11ySnapshot: JSON.stringify({ role: "secureTextField", value: "482913" }),
    });
    expect(() => {
      assertNoUnredactedSecureField([leaky]);
    }).toThrow(UnredactedSecretError);
  });
});
