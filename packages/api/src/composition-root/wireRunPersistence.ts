/**
 * wireRunPersistence — composition-root assembly of the E7.2 write-path
 * orchestrator (#84, ADR-0008 §6 / e7-plan §#84).
 *
 * A dedicated wiring seam (mirrors `wireBuildWorkflowMap`): `buildAppContext`
 * constructs the concrete repos / use-cases and injects them HERE, so this
 * factory — and the `RunAndPersist` it builds — is typed against domain ports
 * and application seams only (NFR3 port purity; dependency-cruiser enforces the
 * layer boundary). Exported so the wiring test can drive it with fakes.
 *
 * Keeping this in its own file leaves exactly ONE added construction line in
 * `wire.ts` (the #84/#85 contention point — e7-plan §Parallelization).
 */
import { RunAndPersist } from "@flowscout/application";
import type { AppContext, CrawlExecutor, WorkflowMapBuilder } from "@flowscout/application";
import type {
  CrawlEventStream,
  ReportRepository,
  RunRepository,
  StateGraphRepository,
} from "@flowscout/domain";

/**
 * Resolved dependencies for `RunAndPersist` — ALL port-/seam-typed. The caller
 * (`buildAppContext`) owns every concrete construction (SQLite repos, the real
 * `StartCrawlRun` + `BuildWorkflowMap`); nothing here names an adapter.
 */
export interface RunPersistenceDeps {
  readonly runRepository: RunRepository;
  readonly stateGraphRepository: StateGraphRepository;
  readonly reportRepository: ReportRepository;
  readonly crawlEventStream: CrawlEventStream;
  readonly startCrawlRun: CrawlExecutor;
  readonly buildWorkflowMap: WorkflowMapBuilder;
}

/** Assemble the write-path orchestrator from resolved dependencies. */
export function wireRunPersistence(deps: RunPersistenceDeps): RunAndPersist {
  return new RunAndPersist(
    deps.runRepository,
    deps.stateGraphRepository,
    deps.reportRepository,
    deps.crawlEventStream,
    deps.startCrawlRun,
    deps.buildWorkflowMap,
  );
}

/**
 * Extended AppContext that exposes the wired RunAndPersist orchestrator (#84).
 * Mirrors the additive `AppContextWithCrawl` / `AppContextWithWorkflowMap` pattern.
 */
export interface AppContextWithRunPersistence extends AppContext {
  runAndPersist: RunAndPersist;
}
