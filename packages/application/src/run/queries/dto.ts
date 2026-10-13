/**
 * Read-side DTOs for the E7.3 run-history queries (#85, ADR-0008 §4 /
 * e7-plan §#85). Shared with the E5 dashboard (API-first: the HTTP layer
 * serializes these shapes verbatim).
 */
import type { Report, Run, RunStatus, StateGraph } from "@flowscout/domain";

/**
 * One page of run history, newest-first by (startedAt, id) — FR6.
 * `nextCursor` is an OPAQUE token minted by the repository; pass it back
 * verbatim to fetch the next page. `null` ⇒ last page.
 */
export interface RunHistoryPage {
  readonly runs: readonly Run[];
  readonly nextCursor: string | null;
  /** Total number of runs in the store (across all pages). */
  readonly total: number;
}

/**
 * Composed detail for a single run: metadata + StateGraph + Report together
 * (FR7). `graph`/`report` are `null` when the run never produced them (e.g.
 * a crawl that errored before the first graph save).
 *
 * AUTHORITATIVE STATUS (#98 arch-review ruling — coherence window): `status`
 * is ALWAYS the RUN ROW's status (`run.status`). `report.metadata.runStatus`
 * is a generation-time snapshot; if the post-report-save run-update failed,
 * the two can disagree — consumers (E4 render, E5 dashboard) MUST read
 * `status`/`run.status`, never the report snapshot.
 */
export interface RunDetail {
  readonly run: Run;
  /** Authoritative run status — sourced from the run row, never the report. */
  readonly status: RunStatus;
  readonly graph: StateGraph | null;
  readonly report: Report | null;
}
