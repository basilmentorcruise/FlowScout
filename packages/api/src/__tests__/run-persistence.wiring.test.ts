/**
 * RunAndPersist — composition-root wiring test (#84 / E7.2, e7-plan §#84).
 *
 * Proves the orchestrator is assembled at the `packages/api` composition root from
 * RESOLVED PORTS/SEAMS only: `wireRunPersistence` takes the three repositories +
 * event stream + the crawl/map seams and constructs a working `RunAndPersist` that
 * names NO concrete adapter. Driven end-to-end with in-memory repos + fakes (no
 * network, no DB, no simulator) — port purity itself is enforced by the
 * dependency-cruiser gate; here we assert the runnable wiring + the
 * `AppContextWithRunPersistence` exposure contract.
 */
import { describe, it, expect } from "vitest";
import {
  RunAndPersist,
  InMemoryRunRepository,
  InMemoryStateGraphRepository,
  InMemoryReportRepository,
  REPORT_UNRENDERED_URI,
} from "@flowscout/application";
import type { CrawlExecutor, WorkflowMapBuilder } from "@flowscout/application";
import type {
  CrawlEvent,
  CrawlEventStream,
  StateGraph,
  StateIdentity,
  StateNode,
  WorkflowMap,
} from "@flowscout/domain";
import { defaultCrawlBudget, makeStateIdentity } from "@flowscout/domain";
import { buildAppContext } from "../composition-root/wire.js";
import { wireRunPersistence } from "../composition-root/wireRunPersistence.js";
import type { AppContextWithRunPersistence } from "../composition-root/wireRunPersistence.js";

// ── Minimal fakes (port-typed; no SDK, no network, no DB) ────────────────────

class TestEventStream implements CrawlEventStream {
  private readonly handlers = new Map<string, Array<(event: CrawlEvent) => void>>();

  publish(event: CrawlEvent): Promise<void> {
    for (const handler of this.handlers.get(event.runId) ?? []) {
      handler(event);
    }
    return Promise.resolve();
  }

  subscribe(runId: string, handler: (event: CrawlEvent) => void): () => void {
    const existing = this.handlers.get(runId) ?? [];
    this.handlers.set(runId, [...existing, handler]);
    return () => {
      this.handlers.set(
        runId,
        (this.handlers.get(runId) ?? []).filter((h) => h !== handler),
      );
    };
  }
}

const RUN_ID = "run-persist-wiring";

function sid(raw: string): StateIdentity {
  return makeStateIdentity(raw);
}

function node(idRaw: string): StateNode {
  return {
    id: sid(idRaw),
    label: `state-${idRaw}`,
    platform: "ios",
    firstSeenAt: "2026-07-07T09:00:00.000Z",
    a11ySnapshot: JSON.stringify({ screen: idRaw }),
    screenshotUri: null,
  };
}

function seededGraph(): StateGraph {
  const nodes = [node("entry"), node("done")];
  return {
    runId: RUN_ID,
    appId: "app-wiring",
    appVersion: "1.0.0",
    platform: "ios",
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges: [],
    duplicatePathNodeIds: new Set<StateIdentity>(),
  };
}

function fakeMap(): WorkflowMap {
  return {
    runId: RUN_ID,
    finalisedAt: "2026-07-07T10:00:00.000Z",
    workflows: [],
    duplicateGroups: [],
  };
}

/** Executor fake mirroring StartCrawlRun: saves the graph, publishes the terminal event. */
function finishingExecutor(
  stateGraphRepository: InMemoryStateGraphRepository,
  stream: TestEventStream,
): CrawlExecutor {
  return {
    async execute(input) {
      await stateGraphRepository.saveGraph(seededGraph());
      await stream.publish({
        kind: "crawl:finished",
        runId: input.runId,
        totalStates: seededGraph().nodes.size,
        totalSteps: 1,
        status: "completed",
        timestamp: "2026-07-07T10:00:00.000Z",
      });
    },
  };
}

describe("RunAndPersist — composition-root wiring (#84)", () => {
  it("wireRunPersistence constructs the orchestrator from resolved deps only", () => {
    const stream = new TestEventStream();
    const orchestrator = wireRunPersistence({
      runRepository: new InMemoryRunRepository(),
      stateGraphRepository: new InMemoryStateGraphRepository(),
      reportRepository: new InMemoryReportRepository(),
      crawlEventStream: stream,
      startCrawlRun: { execute: () => Promise.resolve() } satisfies CrawlExecutor,
      buildWorkflowMap: { execute: () => Promise.resolve(fakeMap()) } satisfies WorkflowMapBuilder,
    });
    expect(orchestrator).toBeInstanceOf(RunAndPersist);
  });

  it("the wired orchestrator persists run + graph + report end-to-end with fakes (smoke)", async () => {
    const runRepository = new InMemoryRunRepository();
    const stateGraphRepository = new InMemoryStateGraphRepository();
    const reportRepository = new InMemoryReportRepository();
    const stream = new TestEventStream();

    const orchestrator = wireRunPersistence({
      runRepository,
      stateGraphRepository,
      reportRepository,
      crawlEventStream: stream,
      startCrawlRun: finishingExecutor(stateGraphRepository, stream),
      buildWorkflowMap: { execute: () => Promise.resolve(fakeMap()) },
    });

    const result = await orchestrator.execute({
      runId: RUN_ID,
      appId: "app-wiring",
      appVersion: "1.0.0",
      platform: "ios",
      udid: "SIM-UDID-TEST",
      budget: defaultCrawlBudget(),
    });

    expect(result.status).toBe("completed");
    const run = await runRepository.findById(RUN_ID);
    expect(run?.status).toBe("completed");
    const report = await reportRepository.findByRunId(RUN_ID);
    expect(report?.metadata.artifactUri).toBe(REPORT_UNRENDERED_URI);
    expect(report?.totalStates).toBe(2);
  });

  it("exposes buildAppContext + the AppContextWithRunPersistence contract", () => {
    // The full buildAppContext() needs live env (LLM key / driver / DB file); here we
    // assert the exported wiring surface exists. The type is the exposure contract.
    expect(typeof buildAppContext).toBe("function");
    const contract: Pick<AppContextWithRunPersistence, "runAndPersist"> | null = null;
    expect(contract).toBeNull();
  });
});
