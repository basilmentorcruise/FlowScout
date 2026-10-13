/**
 * ListRunHistory — read use-case unit tests (#85 / E7.3, e7-plan §#85).
 *
 * Driven against the in-memory RunRepository reference implementation (#83) —
 * the SQLite adapter passes the SAME `listRuns` conformance section, so parity
 * is already proven at the port level; here we assert the use-case mapping.
 *
 * ACs covered (issue #85):
 *   1. Runs listed newest-first ordered by start time.
 *   2. Page size respected + nextCursor/total discoverable; next page fetchable.
 *   5. Zero runs ⇒ empty page, no error.
 *   6. Beyond-last page ⇒ empty page with no next cursor.
 *
 * Security MUSTs: M85.2 (T4 — malformed/oversized cursor ⇒ graceful first page,
 * never a throw). M85.1 (T3 — bound params) is enforced at the SQLite repo and
 * covered by the shared conformance suite; the use-case passes the cursor
 * through OPAQUELY (no decode, no interpolation).
 */
import { describe, it, expect } from "vitest";
import type { Run, RunRepository } from "@flowscout/domain";
import { defaultRunFixtures } from "@flowscout/testing-persistence";
import { InMemoryRunRepository } from "../../../crawl/persistence/InMemoryRunRepository.js";
import { ListRunHistory } from "../ListRunHistory.js";

const PAGE_LIMIT = 2;

/** Five runs across two apps with strictly increasing startedAt, saved OUT of order. */
function seedRuns(): readonly Run[] {
  const { makeRun } = defaultRunFixtures;
  return [
    makeRun({ id: "run-3", appId: "app.one", startedAt: "2026-07-02T10:03:00.000Z" }),
    makeRun({ id: "run-1", appId: "app.one", startedAt: "2026-07-02T10:01:00.000Z" }),
    makeRun({ id: "run-5", appId: "app.two", startedAt: "2026-07-02T10:05:00.000Z" }),
    makeRun({ id: "run-2", appId: "app.two", startedAt: "2026-07-02T10:02:00.000Z" }),
    makeRun({ id: "run-4", appId: "app.one", startedAt: "2026-07-02T10:04:00.000Z" }),
  ];
}

async function seededQuery(): Promise<ListRunHistory> {
  const repository = new InMemoryRunRepository();
  for (const run of seedRuns()) {
    await repository.save(run);
  }
  return new ListRunHistory(repository);
}

describe("ListRunHistory (#85)", () => {
  it("lists runs newest-first by start time (AC1)", async () => {
    const query = await seededQuery();
    const page = await query.execute({ limit: 10 });
    expect(page.runs.map((r) => r.id)).toEqual(["run-5", "run-4", "run-3", "run-2", "run-1"]);
  });

  it("returns one page with a discoverable nextCursor + total, and the cursor fetches the next page (AC2)", async () => {
    const query = await seededQuery();

    const pageOne = await query.execute({ limit: PAGE_LIMIT });
    expect(pageOne.runs.map((r) => r.id)).toEqual(["run-5", "run-4"]);
    expect(pageOne.total).toBe(5);
    expect(pageOne.nextCursor).not.toBeNull();

    const pageTwo = await query.execute({ limit: PAGE_LIMIT, cursor: pageOne.nextCursor });
    expect(pageTwo.runs.map((r) => r.id)).toEqual(["run-3", "run-2"]);
    expect(pageTwo.total).toBe(5);

    const pageThree = await query.execute({ limit: PAGE_LIMIT, cursor: pageTwo.nextCursor });
    expect(pageThree.runs.map((r) => r.id)).toEqual(["run-1"]);
    expect(pageThree.nextCursor).toBeNull();
  });

  it("returns an empty page (no error) when zero runs exist (AC5)", async () => {
    const query = new ListRunHistory(new InMemoryRunRepository());
    await expect(query.execute({ limit: PAGE_LIMIT })).resolves.toEqual({
      runs: [],
      nextCursor: null,
      total: 0,
    });
  });

  it("returns an empty page with no next cursor beyond the last page (AC6)", async () => {
    const query = await seededQuery();
    // Walk to the true end of the history, then ask again with the final position's cursor.
    const all = await query.execute({ limit: 4 });
    const lastPage = await query.execute({ limit: 4, cursor: all.nextCursor });
    expect(lastPage.runs.map((r) => r.id)).toEqual(["run-1"]);
    expect(lastPage.nextCursor).toBeNull();
  });

  it("treats a malformed/oversized cursor as the first page — never a throw (M85.2/T4)", async () => {
    const query = await seededQuery();
    const malformed = ["%%%not-a-cursor%%%", "AAAA", "x".repeat(10_000)];
    for (const cursor of malformed) {
      const page = await query.execute({ limit: PAGE_LIMIT, cursor });
      expect(page.runs.map((r) => r.id)).toEqual(["run-5", "run-4"]);
      expect(page.total).toBe(5);
    }
  });

  it("passes the cursor through opaquely — the repository receives it verbatim (M85.1)", async () => {
    const seen: Array<string | null | undefined> = [];
    const repository = new InMemoryRunRepository();
    const recordingRepository: RunRepository = {
      save: (run) => repository.save(run),
      findById: (id) => repository.findById(id),
      findByAppId: (appId, limit) => repository.findByAppId(appId, limit),
      update: (id, patch) => repository.update(id, patch),
      listRuns: (options) => {
        seen.push(options.cursor);
        return repository.listRuns(options);
      },
    };
    const query = new ListRunHistory(recordingRepository);
    await query.execute({ limit: PAGE_LIMIT, cursor: "opaque-token" });
    expect(seen).toEqual(["opaque-token"]);
  });
});
