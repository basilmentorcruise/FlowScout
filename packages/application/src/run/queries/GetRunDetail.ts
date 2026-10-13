/**
 * GetRunDetail — E7.3 read use-case (#85, e7-plan §#85): compose one run's
 * metadata + StateGraph + Report (WorkflowMap) by run id (FR7).
 *
 * CQRS-lite: reads through the three repository ports only. Unknown run id ⇒
 * explicit `null` — never a throw (FR7 / M85.2). A missing graph/report does
 * NOT null the whole detail: an early-errored run still surfaces its row.
 *
 * AUTHORITATIVE STATUS (#98 arch-review ruling): `RunDetail.status` is the
 * RUN ROW's status. When the report's `runStatus` snapshot disagrees (the
 * post-report-save coherence window), the run row wins — see `RunDetail`.
 */
import type { ReportRepository, RunRepository, StateGraphRepository } from "@flowscout/domain";
import type { RunDetail } from "./dto.js";

export class GetRunDetail {
  constructor(
    private readonly runRepository: RunRepository,
    private readonly stateGraphRepository: StateGraphRepository,
    private readonly reportRepository: ReportRepository,
  ) {}

  /** Retrieve `{run, status, graph, report}` for `runId`, or `null` if unknown. */
  async execute(runId: string): Promise<RunDetail | null> {
    const run = await this.runRepository.findById(runId);
    if (run === null) {
      return null;
    }
    const [graph, report] = await Promise.all([
      this.stateGraphRepository.findByRunId(runId),
      this.reportRepository.findByRunId(runId),
    ]);
    return { run, status: run.status, graph, report };
  }
}
