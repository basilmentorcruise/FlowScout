/**
 * GetRunDetail — read use-case unit tests (#85 / E7.3, e7-plan §#85).
 *
 * ACs covered (issue #85):
 *   3. Known run id ⇒ metadata + StateGraph + Report (WorkflowMap) returned together.
 *   4. Unknown run id ⇒ explicit `null`, never a thrown error (FR7 / M85.2).
 *
 * Gate condition (#98 arch review — coherence window): when the run row and the
 * report's `runStatus` snapshot disagree, `RunDetail.status` is the RUN ROW's
 * status — the run row is authoritative.
 */
import { describe, it, expect } from "vitest";
import type { Report, Run, StateGraph } from "@flowscout/domain";
import {
  defaultGraphFixtures,
  defaultReportFixtures,
  defaultRunFixtures,
  SQLI_PROBE_ID,
} from "@flowscout/testing-persistence";
import { InMemoryRunRepository } from "../../../crawl/persistence/InMemoryRunRepository.js";
import { InMemoryStateGraphRepository } from "../../../crawl/persistence/InMemoryStateGraphRepository.js";
import { InMemoryReportRepository } from "../../../crawl/persistence/InMemoryReportRepository.js";
import { GetRunDetail } from "../GetRunDetail.js";

const RUN_ID = "run-fixture-1"; // shared by the run/graph/report fixture factories

interface Seeded {
  readonly query: GetRunDetail;
  readonly run: Run;
  readonly graph: StateGraph;
  readonly report: Report;
}

async function seedAll(overrides?: { run?: Partial<Run>; report?: Report }): Promise<Seeded> {
  const runRepository = new InMemoryRunRepository();
  const stateGraphRepository = new InMemoryStateGraphRepository();
  const reportRepository = new InMemoryReportRepository();

  const run = defaultRunFixtures.makeRun({
    status: "completed",
    finishedAt: "2026-07-02T11:00:00.000Z",
    ...overrides?.run,
  });
  const graph = defaultGraphFixtures.makeGraph();
  const report = overrides?.report ?? defaultReportFixtures.makeReport();

  await runRepository.save(run);
  await stateGraphRepository.saveGraph(graph);
  await reportRepository.save(report);

  return {
    query: new GetRunDetail(runRepository, stateGraphRepository, reportRepository),
    run,
    graph,
    report,
  };
}

describe("GetRunDetail (#85)", () => {
  it("returns run metadata + StateGraph + Report together for a known id (AC3)", async () => {
    const { query, run, graph, report } = await seedAll();
    const detail = await query.execute(RUN_ID);
    expect(detail).not.toBeNull();
    expect(detail?.run).toEqual(run);
    expect(detail?.graph).toEqual(graph);
    expect(detail?.report).toEqual(report);
    // All three aggregates belong to the SAME run.
    expect(detail?.graph?.runId).toBe(detail?.run.id);
    expect(detail?.report?.metadata.runId).toBe(detail?.run.id);
  });

  it("returns null (not a throw) for an unknown run id (AC4 / FR7 / M85.2)", async () => {
    const { query } = await seedAll();
    await expect(query.execute("no-such-run")).resolves.toBeNull();
  });

  it("treats a SQL-injection-shaped id as a plain unknown id ⇒ null (T3)", async () => {
    const { query } = await seedAll();
    await expect(query.execute(SQLI_PROBE_ID)).resolves.toBeNull();
  });

  it("uses the RUN ROW as the authoritative status when run and report disagree (#98 coherence-window ruling)", async () => {
    // Coherence window: report saved with runStatus "completed", then the
    // run-row finalize wrote "error" (post-report-save update path). The run
    // row wins.
    const { query } = await seedAll({ run: { status: "error" } });
    const detail = await query.execute(RUN_ID);
    expect(detail?.report?.metadata.runStatus).toBe("completed");
    expect(detail?.status).toBe("error");
    expect(detail?.status).toBe(detail?.run.status);
  });

  it("still returns the run (with null graph/report) when only the run row exists — e.g. an early-errored run", async () => {
    const runRepository = new InMemoryRunRepository();
    const run = defaultRunFixtures.makeRun({ status: "error" });
    await runRepository.save(run);
    const query = new GetRunDetail(
      runRepository,
      new InMemoryStateGraphRepository(),
      new InMemoryReportRepository(),
    );
    const detail = await query.execute(run.id);
    expect(detail?.run).toEqual(run);
    expect(detail?.status).toBe("error");
    expect(detail?.graph).toBeNull();
    expect(detail?.report).toBeNull();
  });
});
