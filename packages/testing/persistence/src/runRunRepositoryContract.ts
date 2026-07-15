/**
 * RunRepository port-conformance section (ADR-0008 §7).
 *
 * Runs against EVERY implementation (durable SQLite + in-memory reference).
 * The `reopen`-gated durability assertions (NFR1: data survives a fresh store
 * instance) run only when the caller supplies `reopen` (durable impls).
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Run, RunRepository } from "@flowscout/domain";
import type { RunFixtures } from "./fixtures.js";
import { SQLI_PROBE_ID } from "./fixtures.js";

export interface RunRepositoryContractOptions {
  /** Returns a FRESH, EMPTY repository. */
  createRepository: () => RunRepository;
  /** Durable impls only: returns a NEW instance over the SAME underlying storage (NFR1). */
  reopen?: (repository: RunRepository) => RunRepository;
  fixtures: RunFixtures;
}

const PAGE_LIMIT = 2;

/** Seeds five runs across two apps with strictly ordered startedAt timestamps. */
function seedRuns(fixtures: RunFixtures): readonly Run[] {
  return [
    fixtures.makeRun({ id: "run-1", appId: "app.one", startedAt: "2026-07-02T10:01:00.000Z" }),
    fixtures.makeRun({ id: "run-2", appId: "app.two", startedAt: "2026-07-02T10:02:00.000Z" }),
    fixtures.makeRun({ id: "run-3", appId: "app.one", startedAt: "2026-07-02T10:03:00.000Z" }),
    fixtures.makeRun({ id: "run-4", appId: "app.two", startedAt: "2026-07-02T10:04:00.000Z" }),
    fixtures.makeRun({ id: "run-5", appId: "app.one", startedAt: "2026-07-02T10:05:00.000Z" }),
  ];
}

export function runRunRepositoryContract(options: RunRepositoryContractOptions): void {
  const { createRepository, reopen, fixtures } = options;

  describe("RunRepository contract", () => {
    let repository: RunRepository;

    beforeEach(() => {
      repository = createRepository();
    });

    describe("roundtrip (FR1)", () => {
      it("returns a deep-equal Run by id, including budget and null finishedAt", async () => {
        const run = fixtures.makeRun({ status: "running", finishedAt: null });
        await repository.save(run);
        await expect(repository.findById(run.id)).resolves.toEqual(run);
      });

      it("re-saving the same id is an upsert — latest wins, no duplication", async () => {
        const run = fixtures.makeRun();
        await repository.save(run);
        const updated: Run = {
          ...run,
          status: "completed",
          finishedAt: "2026-07-02T11:00:00.000Z",
        };
        await repository.save(updated);
        await expect(repository.findById(run.id)).resolves.toEqual(updated);
        await expect(repository.findByAppId(run.appId)).resolves.toHaveLength(1);
      });
    });

    describe("not-found (FR7)", () => {
      it("returns null for an unknown id, never an error", async () => {
        await expect(repository.findById("no-such-run")).resolves.toBeNull();
      });

      it("treats a SQL-injection-shaped id as a plain value: null result, store unharmed (T3)", async () => {
        const run = fixtures.makeRun();
        await repository.save(run);
        await expect(repository.findById(SQLI_PROBE_ID)).resolves.toBeNull();
        await expect(repository.findByAppId(SQLI_PROBE_ID)).resolves.toEqual([]);
        // The table still exists and serves reads/writes after the probe.
        await expect(repository.findById(run.id)).resolves.toEqual(run);
      });
    });

    describe("update (FR4 lifecycle)", () => {
      it("patches status + finishedAt and leaves every other field intact", async () => {
        const run = fixtures.makeRun({ status: "running", finishedAt: null });
        await repository.save(run);
        await repository.update(run.id, {
          status: "completed",
          finishedAt: "2026-07-02T11:00:00.000Z",
        });
        await expect(repository.findById(run.id)).resolves.toEqual({
          ...run,
          status: "completed",
          finishedAt: "2026-07-02T11:00:00.000Z",
        });
      });

      it("is a no-op (no throw) for an unknown id", async () => {
        await expect(
          repository.update("no-such-run", { status: "error" }),
        ).resolves.toBeUndefined();
      });
    });

    describe("findByAppId (FR1) — NEWEST-FIRST by (startedAt, id), #85 pinned ordering", () => {
      it("returns only that app's runs, newest-first, and respects limit", async () => {
        for (const run of seedRuns(fixtures)) {
          await repository.save(run);
        }
        const appOneRuns = await repository.findByAppId("app.one");
        expect(appOneRuns.map((r) => r.id)).toEqual(["run-5", "run-3", "run-1"]);
        const limited = await repository.findByAppId("app.one", PAGE_LIMIT);
        expect(limited.map((r) => r.id)).toEqual(["run-5", "run-3"]);
      });

      it("breaks startedAt ties by id descending (deterministic order, #85)", async () => {
        const sameTime = "2026-07-02T10:10:00.000Z";
        await repository.save(fixtures.makeRun({ id: "run-a", appId: "app.tie", startedAt: sameTime }));
        await repository.save(fixtures.makeRun({ id: "run-b", appId: "app.tie", startedAt: sameTime }));
        const runs = await repository.findByAppId("app.tie");
        expect(runs.map((r) => r.id)).toEqual(["run-b", "run-a"]);
      });
    });

    describe("listRuns (FR6)", () => {
      it("lists newest-first across apps and pages via chained cursors with a stable total", async () => {
        for (const run of seedRuns(fixtures)) {
          await repository.save(run);
        }
        const pageOne = await repository.listRuns({ limit: PAGE_LIMIT });
        expect(pageOne.runs.map((r) => r.id)).toEqual(["run-5", "run-4"]);
        expect(pageOne.total).toBe(5);
        expect(pageOne.nextCursor).not.toBeNull();

        const pageTwo = await repository.listRuns({
          limit: PAGE_LIMIT,
          cursor: pageOne.nextCursor,
        });
        expect(pageTwo.runs.map((r) => r.id)).toEqual(["run-3", "run-2"]);
        expect(pageTwo.total).toBe(5);
        expect(pageTwo.nextCursor).not.toBeNull();

        const pageThree = await repository.listRuns({
          limit: PAGE_LIMIT,
          cursor: pageTwo.nextCursor,
        });
        expect(pageThree.runs.map((r) => r.id)).toEqual(["run-1"]);
        expect(pageThree.total).toBe(5);
        expect(pageThree.nextCursor).toBeNull();
      });

      it("breaks startedAt ties by id descending (deterministic order)", async () => {
        const sameTime = "2026-07-02T10:10:00.000Z";
        await repository.save(fixtures.makeRun({ id: "run-a", startedAt: sameTime }));
        await repository.save(fixtures.makeRun({ id: "run-b", startedAt: sameTime }));
        const page = await repository.listRuns({ limit: 10 });
        expect(page.runs.map((r) => r.id)).toEqual(["run-b", "run-a"]);
      });

      it("returns an empty page with null cursor and total 0 on an empty store", async () => {
        await expect(repository.listRuns({ limit: PAGE_LIMIT })).resolves.toEqual({
          runs: [],
          nextCursor: null,
          total: 0,
        });
      });

      it("issues NO cursor when the page consumes the store exactly (no dangling beyond-last page)", async () => {
        const runs = seedRuns(fixtures);
        for (const run of runs) {
          await repository.save(run);
        }
        const page = await repository.listRuns({ limit: runs.length });
        expect(page.runs).toHaveLength(runs.length);
        expect(page.nextCursor).toBeNull();
      });

      it("treats a malformed cursor as the first page — never a throw (T4)", async () => {
        for (const run of seedRuns(fixtures)) {
          await repository.save(run);
        }
        const malformed = ["%%%not-a-cursor%%%", "AAAA", "x".repeat(10_000)];
        for (const cursor of malformed) {
          const page = await repository.listRuns({ limit: PAGE_LIMIT, cursor });
          expect(page.runs.map((r) => r.id)).toEqual(["run-5", "run-4"]);
          expect(page.total).toBe(5);
        }
      });
    });

    if (reopen) {
      describe("durability across a fresh store instance (NFR1)", () => {
        it("returns saved runs from a reopened repository", async () => {
          const run = fixtures.makeRun({
            status: "completed",
            finishedAt: "2026-07-02T11:00:00.000Z",
          });
          await repository.save(run);
          const reopened = reopen(repository);
          await expect(reopened.findById(run.id)).resolves.toEqual(run);
          const page = await reopened.listRuns({ limit: PAGE_LIMIT });
          expect(page.total).toBe(1);
          expect(page.runs).toEqual([run]);
        });
      });
    }
  });
}
