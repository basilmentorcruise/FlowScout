/**
 * InMemoryRunRepository — first-class (non-test-only) in-memory implementation
 * of the RunRepository port (E7.1 / #83, ADR-0008 §7).
 *
 * Home: packages/application/src/crawl/persistence/ (mirrors InMemoryStateGraphRepository).
 * Reference implementation for the shared port-conformance suite
 * (@flowscout/testing-persistence): the durable SQLite adapter and this class
 * pass the SAME behavioral sections, proving in-memory ⇄ SQLite parity.
 *
 * Pagination cursor: an OPAQUE base64url token over (startedAt, id) — the same
 * keyset shape as the SQLite adapter (ADR-0008 §4). Decoded DEFENSIVELY: any
 * malformed/oversized cursor is treated as the first page, never a throw (T4).
 */
import type { Run, RunRepository, ListRunsOptions, RunPage } from "@flowscout/domain";

/** Fallback page size when the caller supplies a non-positive/non-integer limit. */
const DEFAULT_PAGE_SIZE = 50;
/** Defensive upper bound on accepted cursor tokens (T4 — reject oversized input early). */
const MAX_CURSOR_LENGTH = 512;

interface DecodedCursor {
  readonly startedAt: string;
  readonly id: string;
}

function encodeCursor(startedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ s: startedAt, i: id }), "utf8").toString("base64url");
}

/** Defensive decode: shape/type validated after parse; malformed ⇒ null (first page). */
function decodeCursor(raw: string | null | undefined): DecodedCursor | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) {
    return null;
  }
  try {
    const text = Buffer.from(raw, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const startedAt = record["s"];
    const id = record["i"];
    if (typeof startedAt !== "string" || typeof id !== "string") {
      return null;
    }
    return { startedAt, id };
  } catch {
    return null;
  }
}

/** Newest-first comparator: (startedAt, id) descending — ADR-0008 §4. */
function byNewestFirst(a: Run, b: Run): number {
  return a.startedAt === b.startedAt
    ? b.id.localeCompare(a.id)
    : b.startedAt.localeCompare(a.startedAt);
}

/** True when `run` sorts strictly AFTER the cursor position in newest-first order. */
function isAfterCursor(run: Run, cursor: DecodedCursor): boolean {
  return (
    run.startedAt < cursor.startedAt || (run.startedAt === cursor.startedAt && run.id < cursor.id)
  );
}

export class InMemoryRunRepository implements RunRepository {
  private readonly store = new Map<string, Run>();

  save(run: Run): Promise<void> {
    this.store.set(run.id, run);
    return Promise.resolve();
  }

  findById(id: string): Promise<Run | null> {
    return Promise.resolve(this.store.get(id) ?? null);
  }

  findByAppId(appId: string, limit?: number): Promise<readonly Run[]> {
    const results = [...this.store.values()].filter((r) => r.appId === appId).sort(byNewestFirst);
    return Promise.resolve(limit !== undefined ? results.slice(0, limit) : results);
  }

  update(id: string, patch: Partial<Pick<Run, "status" | "finishedAt">>): Promise<void> {
    const existing = this.store.get(id);
    if (existing) {
      this.store.set(id, { ...existing, ...patch });
    }
    return Promise.resolve();
  }

  listRuns(options: ListRunsOptions): Promise<RunPage> {
    const limit =
      Number.isInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_PAGE_SIZE;
    const cursor = decodeCursor(options.cursor);
    const sorted = [...this.store.values()].sort(byNewestFirst);
    const remaining = cursor ? sorted.filter((run) => isAfterCursor(run, cursor)) : sorted;
    const page = remaining.slice(0, limit);
    const hasMore = remaining.length > limit;
    const lastOnPage = page[page.length - 1];
    return Promise.resolve({
      runs: page,
      nextCursor:
        hasMore && lastOnPage !== undefined
          ? encodeCursor(lastOnPage.startedAt, lastOnPage.id)
          : null,
      total: this.store.size,
    });
  }
}
