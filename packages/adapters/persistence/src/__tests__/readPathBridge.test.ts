/**
 * Read-path promise bridge (#85 — #91 arch-review nit 2, port good citizenship).
 *
 * The SQLite repositories decode the JSON payload synchronously; before #85 a
 * corrupt payload made `find*` / `listRuns` THROW synchronously from a
 * Promise-typed port method — an LSP asymmetry with the in-memory reference
 * impls (whose async methods always reject). These tests corrupt a stored row
 * out-of-band and assert every read path (a) never throws synchronously and
 * (b) rejects through the returned promise.
 *
 * Unreachable for codec-written data — this is defensive parity, exercised via
 * a raw UPDATE against the same handle.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  defaultGraphFixtures,
  defaultReportFixtures,
  defaultRunFixtures,
} from "@flowscout/testing-persistence";
import { openDatabase } from "../sqlite/Database.js";
import type { SqliteDatabase } from "../sqlite/Database.js";
import { resolveAfter } from "../sqlite/promiseBridge.js";
import { SqliteRunRepository } from "../sqlite/SqliteRunRepository.js";
import { SqliteStateGraphRepository } from "../sqlite/SqliteStateGraphRepository.js";
import { SqliteReportRepository } from "../sqlite/SqliteReportRepository.js";

const CORRUPT_PAYLOAD = "not-json{";

/**
 * Asserts the port-citizenship contract: the call itself never throws
 * synchronously, and the returned promise rejects.
 */
async function expectAsyncRejection(call: () => Promise<unknown>): Promise<void> {
  let promise: Promise<unknown> | undefined;
  expect(() => {
    promise = call();
    // Attach a handler immediately so the expected rejection is never "unhandled".
    promise.catch(() => undefined);
  }).not.toThrow();
  await expect(promise).rejects.toThrow();
}

describe("SQLite read paths bridge corrupt-payload decode into a rejected promise (#85)", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    if (db.open) db.close();
  });

  it("RunRepository: findById / findByAppId / listRuns reject (never throw sync) on a corrupt row", async () => {
    const repository = new SqliteRunRepository(db);
    const run = defaultRunFixtures.makeRun();
    await repository.save(run);
    db.prepare("UPDATE runs SET payload = ? WHERE id = ?").run(CORRUPT_PAYLOAD, run.id);

    await expectAsyncRejection(() => repository.findById(run.id));
    await expectAsyncRejection(() => repository.findByAppId(run.appId));
    await expectAsyncRejection(() => repository.listRuns({ limit: 10 }));
  });

  it("StateGraphRepository: findByRunId rejects (never throws sync) on a corrupt row", async () => {
    const repository = new SqliteStateGraphRepository(db);
    const graph = defaultGraphFixtures.makeGraph();
    await repository.saveGraph(graph);
    db.prepare("UPDATE graphs SET payload = ? WHERE run_id = ?").run(CORRUPT_PAYLOAD, graph.runId);

    await expectAsyncRejection(() => repository.findByRunId(graph.runId));
  });

  it("ReportRepository: findById / findByRunId / findByAppId reject (never throw sync) on a corrupt row", async () => {
    const repository = new SqliteReportRepository(db);
    const report = defaultReportFixtures.makeReport();
    await repository.save(report);
    db.prepare("UPDATE reports SET payload = ? WHERE run_id = ?").run(
      CORRUPT_PAYLOAD,
      report.metadata.runId,
    );

    await expectAsyncRejection(() => repository.findById(report.metadata.reportId));
    await expectAsyncRejection(() => repository.findByRunId(report.metadata.runId));
    await expectAsyncRejection(() => repository.findByAppId(report.metadata.appId));
  });

  it("resolveAfter coerces a thrown non-Error value into an Error rejection", async () => {
    await expect(
      resolveAfter(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercises the coercion branch
        throw "raw-string-failure";
      }),
    ).rejects.toThrow("raw-string-failure");
  });

  it("intact rows still resolve normally through the bridge (no behavior change on the happy path)", async () => {
    const repository = new SqliteRunRepository(db);
    const run = defaultRunFixtures.makeRun();
    await repository.save(run);

    await expect(repository.findById(run.id)).resolves.toEqual(run);
    await expect(repository.findById("no-such-run")).resolves.toBeNull();
    const page = await repository.listRuns({ limit: 10 });
    expect(page.runs).toEqual([run]);
  });
});
