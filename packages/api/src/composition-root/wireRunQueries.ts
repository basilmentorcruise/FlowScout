/**
 * wireRunQueries — composition-root assembly of the E7.3 read-side query
 * use-cases (#85, e7-plan §#85).
 *
 * A dedicated wiring seam (mirrors `wireRunPersistence`): `buildAppContext`
 * constructs the concrete repositories and injects them HERE, so this factory
 * — and the queries it builds — is typed against domain ports only (NFR3 port
 * purity; dependency-cruiser enforces the layer boundary). Exported so the
 * wiring test can drive it with fakes.
 *
 * Keeping this in its own file leaves exactly ONE added construction line in
 * `wire.ts` (the shared-edit contention point — e7-plan §Parallelization).
 */
import { GetRunDetail, ListRunHistory } from "@flowscout/application";
import type { AppContext } from "@flowscout/application";
import type { ReportRepository, RunRepository, StateGraphRepository } from "@flowscout/domain";

/**
 * Resolved dependencies for the run queries — ALL port-typed. The caller
 * (`buildAppContext`) owns every concrete construction (SQLite repos);
 * nothing here names an adapter.
 */
export interface RunQueriesDeps {
  readonly runRepository: RunRepository;
  readonly stateGraphRepository: StateGraphRepository;
  readonly reportRepository: ReportRepository;
}

/** The two CQRS-lite read use-cases the E5 dashboard consumes (FR6/FR7). */
export interface RunQueries {
  readonly listRunHistory: ListRunHistory;
  readonly getRunDetail: GetRunDetail;
}

/** Assemble both read use-cases from resolved repository ports. */
export function wireRunQueries(deps: RunQueriesDeps): RunQueries {
  return {
    listRunHistory: new ListRunHistory(deps.runRepository),
    getRunDetail: new GetRunDetail(
      deps.runRepository,
      deps.stateGraphRepository,
      deps.reportRepository,
    ),
  };
}

/**
 * Extended AppContext that exposes the wired run queries (#85).
 * Mirrors the additive `AppContextWithCrawl` / `AppContextWithRunPersistence`
 * pattern.
 */
export interface AppContextWithRunQueries extends AppContext {
  runQueries: RunQueries;
}
