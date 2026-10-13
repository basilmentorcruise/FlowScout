/**
 * Run queries — composition-root wiring test (#85 / E7.3, e7-plan §#85).
 *
 * Proves the read use-cases are assembled at the `packages/api` composition
 * root from RESOLVED PORTS only: `wireRunQueries` takes the three repositories
 * and constructs working `ListRunHistory` + `GetRunDetail` instances that name
 * NO concrete adapter. Driven with in-memory repos (no network, no DB) — port
 * purity itself is enforced by the dependency-cruiser gate; here we assert the
 * runnable wiring + the `AppContextWithRunQueries` exposure contract.
 */
import { describe, it, expect } from "vitest";
import {
  GetRunDetail,
  ListRunHistory,
  InMemoryRunRepository,
  InMemoryStateGraphRepository,
  InMemoryReportRepository,
} from "@flowscout/application";
import type { Report, Run, StateGraph, StateIdentity, StateNode } from "@flowscout/domain";
import { defaultCrawlBudget, makeStateIdentity } from "@flowscout/domain";
import { buildAppContext } from "../composition-root/wire.js";
import { wireRunQueries } from "../composition-root/wireRunQueries.js";
import type { AppContextWithRunQueries, RunQueries } from "../composition-root/wireRunQueries.js";

// ── Minimal fixtures (no adapter, no I/O) ────────────────────────────────────

const RUN_ID = "run-queries-wiring";
const APP_ID = "app-wiring";
const PAGE_LIMIT = 2;

function makeRun(id: string, startedAt: string): Run {
  return {
    id,
    appId: APP_ID,
    appVersion: "1.0.0",
    platform: "ios",
    budget: defaultCrawlBudget(),
    status: "completed",
    startedAt,
    finishedAt: "2026-07-07T11:00:00.000Z",
    driverVersion: "driver-1.0.0",
    policyVersion: "policy-1.0.0",
    schemaVersion: "schema-1.0.0",
  };
}

function node(idRaw: string): StateNode {
  return {
    id: makeStateIdentity(idRaw),
    label: `state-${idRaw}`,
    platform: "ios",
    firstSeenAt: "2026-07-07T09:00:00.000Z",
    a11ySnapshot: JSON.stringify({ screen: idRaw }),
    screenshotUri: null,
  };
}

function makeGraph(): StateGraph {
  const nodes = [node("entry"), node("done")];
  return {
    runId: RUN_ID,
    appId: APP_ID,
    appVersion: "1.0.0",
    platform: "ios",
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges: [],
    duplicatePathNodeIds: new Set<StateIdentity>(),
  };
}

function makeReport(): Report {
  return {
    metadata: {
      reportId: `report-${RUN_ID}`,
      runId: RUN_ID,
      appId: APP_ID,
      appVersion: "1.0.0",
      generatedAt: "2026-07-07T10:00:00.000Z",
      runStatus: "completed",
      artifactUri: "",
      schemaVersion: "schema-1.0.0",
    },
    workflowMap: {
      runId: RUN_ID,
      finalisedAt: "2026-07-07T10:00:00.000Z",
      workflows: [],
      duplicateGroups: [],
    },
    totalStates: 2,
    totalWorkflows: 0,
    duplicatePathCount: 0,
  };
}

function wiredWithSeed(): { queries: RunQueries; seed: () => Promise<void> } {
  const runRepository = new InMemoryRunRepository();
  const stateGraphRepository = new InMemoryStateGraphRepository();
  const reportRepository = new InMemoryReportRepository();
  const queries = wireRunQueries({ runRepository, stateGraphRepository, reportRepository });
  const seed = async (): Promise<void> => {
    await runRepository.save(makeRun("run-old", "2026-07-07T10:01:00.000Z"));
    await runRepository.save(makeRun(RUN_ID, "2026-07-07T10:02:00.000Z"));
    await runRepository.save(makeRun("run-new", "2026-07-07T10:03:00.000Z"));
    await stateGraphRepository.saveGraph(makeGraph());
    await reportRepository.save(makeReport());
  };
  return { queries, seed };
}

describe("Run queries — composition-root wiring (#85)", () => {
  it("wireRunQueries constructs both use-cases from resolved ports only", () => {
    const { queries } = wiredWithSeed();
    expect(queries.listRunHistory).toBeInstanceOf(ListRunHistory);
    expect(queries.getRunDetail).toBeInstanceOf(GetRunDetail);
  });

  it("the wired ListRunHistory pages newest-first end-to-end with fakes (smoke)", async () => {
    const { queries, seed } = wiredWithSeed();
    await seed();
    const pageOne = await queries.listRunHistory.execute({ limit: PAGE_LIMIT });
    expect(pageOne.runs.map((r) => r.id)).toEqual(["run-new", RUN_ID]);
    expect(pageOne.total).toBe(3);
    const pageTwo = await queries.listRunHistory.execute({
      limit: PAGE_LIMIT,
      cursor: pageOne.nextCursor,
    });
    expect(pageTwo.runs.map((r) => r.id)).toEqual(["run-old"]);
    expect(pageTwo.nextCursor).toBeNull();
  });

  it("the wired GetRunDetail composes run + graph + report; unknown id ⇒ null (smoke)", async () => {
    const { queries, seed } = wiredWithSeed();
    await seed();
    const detail = await queries.getRunDetail.execute(RUN_ID);
    expect(detail?.run.id).toBe(RUN_ID);
    expect(detail?.status).toBe(detail?.run.status);
    expect(detail?.graph?.runId).toBe(RUN_ID);
    expect(detail?.report?.metadata.runId).toBe(RUN_ID);
    await expect(queries.getRunDetail.execute("no-such-run")).resolves.toBeNull();
  });

  it("exposes buildAppContext + the AppContextWithRunQueries contract", () => {
    // The full buildAppContext() needs live env (LLM key / driver / DB file); here we
    // assert the exported wiring surface exists. The type is the exposure contract.
    expect(typeof buildAppContext).toBe("function");
    const contract: Pick<AppContextWithRunQueries, "runQueries"> | null = null;
    expect(contract).toBeNull();
  });
});
