/**
 * ListRunHistory — E7.3 read use-case (#85, e7-plan §#85): paginated,
 * newest-first run history for the dashboard (FR6).
 *
 * CQRS-lite: a thin query over the `RunRepository` port. Ordering and
 * pagination are OWNED by the repository (`listRuns`, ADR-0008 §4) — this
 * use-case maps the port's `RunPage` to the dashboard-facing DTO and never
 * duplicates that logic.
 *
 * Security (e7 threat model):
 *   - M85.1/T3: the cursor and options pass through OPAQUELY — no decode, no
 *     string building; the SQLite repo binds every decoded scalar as a param.
 *   - M85.2/T4: malformed/oversized cursors are handled defensively by the
 *     repository (first page, never a throw) — this query adds no throw path.
 */
import type { ListRunsOptions, RunRepository } from "@flowscout/domain";
import type { RunHistoryPage } from "./dto.js";

export class ListRunHistory {
  constructor(private readonly runRepository: RunRepository) {}

  /** List runs newest-first; `options.cursor` is the previous page's `nextCursor`. */
  async execute(options: ListRunsOptions): Promise<RunHistoryPage> {
    const page = await this.runRepository.listRuns(options);
    return { runs: page.runs, nextCursor: page.nextCursor, total: page.total };
  }
}
