/**
 * RunAndPersist — orchestrator unit tests (#84 / E7.2, ADR-0008 §6) with in-memory
 * repos (#83 reference impls) + port-typed fakes. No adapter, no I/O.
 *
 * ACs covered (issue #84):
 *   1. Run record persisted `running`/`finishedAt:null`, discoverable BEFORE finish (FR4).
 *   2. Completed crawl ⇒ terminal status + finishedAt + graph + report retrievable,
 *      matching runId/appId/appVersion; report counts + "" artifactUri.
 *   3. Crash/error mid-run ⇒ run discoverable in a non-completed state — never lost.
 *   4. Graph and report retrieved by run id correspond to the same run.
 *   5. NFR4: persistence adds no new secret sink (no de-redaction, no payload logging).
 *
 * Security MUSTs: M84.2 (T6 — save failure ⇒ status "error" + finishedAt, run never
 * silently lost) and the no-payload-logging half of M84.1 (T1).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type {
  CrawlEvent,
  CrawlEventStream,
  Report,
  ReportRepository,
  Run,
  RunRepository,
  StateGraph,
  StateIdentity,
  StateNode,
  WorkflowMap,
} from "@flowscout/domain";
import { defaultCrawlBudget, makeStateIdentity } from "@flowscout/domain";
import { InMemoryRunRepository } from "../../crawl/persistence/InMemoryRunRepository.js";
import { InMemoryStateGraphRepository } from "../../crawl/persistence/InMemoryStateGraphRepository.js";
import { InMemoryReportRepository } from "../../crawl/persistence/InMemoryReportRepository.js";
import { RunAndPersist } from "../RunAndPersist.js";
import type { CrawlExecutor, RunAndPersistInput, WorkflowMapBuilder } from "../RunAndPersist.js";
import type { StartCrawlRunInput } from "../../crawl/StartCrawlRun.js";
import { REPORT_UNRENDERED_URI } from "../assembleReport.js";
import { defaultRunVersions } from "../versions.js";

// ── Test doubles ──────────────────────────────────────────────────────────────

/** Minimal in-process event stream tracking live subscriptions (unsubscribe evidence). */
class TestEventStream implements CrawlEventStream {
  private readonly handlers = new Map<string, Array<(event: CrawlEvent) => void>>();
  activeSubscriptions = 0;

  publish(event: CrawlEvent): Promise<void> {
    for (const handler of this.handlers.get(event.runId) ?? []) {
      handler(event);
    }
    return Promise.resolve();
  }

  subscribe(runId: string, handler: (event: CrawlEvent) => void): () => void {
    const existing = this.handlers.get(runId) ?? [];
    this.handlers.set(runId, [...existing, handler]);
    this.activeSubscriptions++;
    return () => {
      this.handlers.set(
        runId,
        (this.handlers.get(runId) ?? []).filter((h) => h !== handler),
      );
      this.activeSubscriptions--;
    };
  }
}

/** WorkflowMapBuilder fake — records calls, returns a canned map. */
class FakeWorkflowMapBuilder implements WorkflowMapBuilder {
  calls: string[] = [];
  constructor(private readonly map: WorkflowMap) {}
  execute(runId: string): Promise<WorkflowMap> {
    this.calls.push(runId);
    return Promise.resolve(this.map);
  }
}

/** ReportRepository whose save always fails (M84.2 / T6 evidence). */
class FailingReportRepository implements ReportRepository {
  save(_report: Report): Promise<void> {
    return Promise.reject(new Error("disk full: report save failed"));
  }
  findById(_reportId: string): Promise<Report | null> {
    return Promise.resolve(null);
  }
  findByRunId(_runId: string): Promise<Report | null> {
    return Promise.resolve(null);
  }
  findByAppId(_appId: string, _limit?: number): Promise<readonly Report[]> {
    return Promise.resolve([]);
  }
}

/** RunRepository whose update always fails (fallback-path evidence). */
class UpdateFailingRunRepository extends InMemoryRunRepository {
  override update(_id: string, _patch: Partial<Pick<Run, "status" | "finishedAt">>): Promise<void> {
    return Promise.reject(new Error("update failed"));
  }
}

interface ExecutorOptions {
  readonly stream: TestEventStream;
  readonly graphRepo?: InMemoryStateGraphRepository;
  readonly graph?: StateGraph;
  readonly finishStatus?: "completed" | "partial" | "blocked-on-2fa";
  readonly emitErrorEvent?: boolean;
  readonly throwError?: Error;
  readonly silent?: boolean;
  readonly onExecute?: (input: StartCrawlRunInput) => Promise<void>;
}

/**
 * CrawlExecutor fake mirroring the real StartCrawlRun contract: persists the graph
 * incrementally through the (durable) graph repo and publishes the terminal event;
 * `execute()` itself returns void — the event stream is the status channel.
 */
function crawlExecutor(options: ExecutorOptions): CrawlExecutor {
  return {
    async execute(input: StartCrawlRunInput): Promise<void> {
      await options.onExecute?.(input);
      if (options.graphRepo && options.graph) {
        await options.graphRepo.saveGraph(options.graph);
      }
      if (options.throwError) {
        throw options.throwError;
      }
      if (options.silent) {
        return;
      }
      if (options.emitErrorEvent) {
        await options.stream.publish({
          kind: "crawl:error",
          runId: input.runId,
          message: "boom (redacted)",
          timestamp: "2026-07-07T10:00:00.000Z",
        });
        return;
      }
      await options.stream.publish({
        kind: "crawl:finished",
        runId: input.runId,
        totalStates: options.graph?.nodes.size ?? 0,
        totalSteps: 3,
        status: options.finishStatus ?? "completed",
        timestamp: "2026-07-07T10:00:00.000Z",
      });
    },
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const RUN_ID = "run-orchestrator-1";
const APP_ID = "com.example.demo";
const APP_VERSION = "1.2.3";

function sid(raw: string): StateIdentity {
  return makeStateIdentity(raw);
}

function node(idRaw: string): StateNode {
  return {
    id: sid(idRaw),
    label: `state-${idRaw}`,
    platform: "ios",
    firstSeenAt: "2026-07-07T09:00:01.000Z",
    a11ySnapshot: JSON.stringify({ screen: idRaw, value: "[REDACTED]" }),
    screenshotUri: null,
  };
}

function makeGraph(): StateGraph {
  const nodes = [node("a"), node("b")];
  return {
    runId: RUN_ID,
    appId: APP_ID,
    appVersion: APP_VERSION,
    platform: "ios",
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges: [],
    duplicatePathNodeIds: new Set([sid("b")]),
  };
}

function makeMap(): WorkflowMap {
  return {
    runId: RUN_ID,
    finalisedAt: "2026-07-07T09:59:00.000Z",
    workflows: [
      {
        id: "w1",
        name: "Sign in",
        description: "Signs the user in",
        steps: [],
        isHiddenPath: false,
        inferenceConfidence: null,
        featureGroup: "Authentication",
      },
    ],
    duplicateGroups: [],
  };
}

function input(): RunAndPersistInput {
  return {
    runId: RUN_ID,
    appId: APP_ID,
    appVersion: APP_VERSION,
    platform: "ios",
    udid: "SIM-UDID-TEST",
    budget: defaultCrawlBudget(),
  };
}

interface Harness {
  readonly runRepo: RunRepository;
  readonly graphRepo: InMemoryStateGraphRepository;
  readonly reportRepo: ReportRepository;
  readonly stream: TestEventStream;
  readonly builder: FakeWorkflowMapBuilder;
  build(executor: CrawlExecutor): RunAndPersist;
}

function harness(overrides?: { runRepo?: RunRepository; reportRepo?: ReportRepository }): Harness {
  const runRepo = overrides?.runRepo ?? new InMemoryRunRepository();
  const graphRepo = new InMemoryStateGraphRepository();
  const reportRepo = overrides?.reportRepo ?? new InMemoryReportRepository();
  const stream = new TestEventStream();
  const builder = new FakeWorkflowMapBuilder(makeMap());
  return {
    runRepo,
    graphRepo,
    reportRepo,
    stream,
    builder,
    build: (executor: CrawlExecutor) =>
      new RunAndPersist(runRepo, graphRepo, reportRepo, stream, executor, builder),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RunAndPersist — run created at start (FR4 / AC1)", () => {
  it('persists a "running"/finishedAt:null Run discoverable BEFORE the crawl completes', async () => {
    const h = harness();
    let midCrawlRow: Run | null = null;
    const executor = crawlExecutor({
      stream: h.stream,
      graphRepo: h.graphRepo,
      graph: makeGraph(),
      onExecute: async () => {
        midCrawlRow = await h.runRepo.findById(RUN_ID);
      },
    });

    await h.build(executor).execute(input());

    expect(midCrawlRow).not.toBeNull();
    expect(midCrawlRow?.status).toBe("running");
    expect(midCrawlRow?.finishedAt).toBeNull();
  });

  it("stamps the run with budget + driver/policy/schema version provenance", async () => {
    const h = harness();
    let midCrawlRow: Run | null = null;
    const executor = crawlExecutor({
      stream: h.stream,
      onExecute: async () => {
        midCrawlRow = await h.runRepo.findById(RUN_ID);
      },
    });

    await h.build(executor).execute(input());

    const versions = defaultRunVersions();
    expect(midCrawlRow?.budget).toEqual(defaultCrawlBudget());
    expect(midCrawlRow?.driverVersion).toBe(versions.driverVersion);
    expect(midCrawlRow?.policyVersion).toBe(versions.policyVersion);
    expect(midCrawlRow?.schemaVersion).toBe(versions.schemaVersion);
  });
});

describe("RunAndPersist — completed crawl finalizes run + graph + report (AC2/AC4)", () => {
  it("updates the run to the event's terminal status with finishedAt set", async () => {
    const h = harness();
    const executor = crawlExecutor({
      stream: h.stream,
      graphRepo: h.graphRepo,
      graph: makeGraph(),
    });

    const result = await h.build(executor).execute(input());

    expect(result).toEqual({ runId: RUN_ID, status: "completed" });
    const run = await h.runRepo.findById(RUN_ID);
    expect(run?.status).toBe("completed");
    expect(typeof run?.finishedAt).toBe("string");
  });

  it("derives the terminal status from the crawl:finished event, not by re-guessing", async () => {
    for (const status of ["partial", "blocked-on-2fa"] as const) {
      const h = harness();
      const executor = crawlExecutor({
        stream: h.stream,
        graphRepo: h.graphRepo,
        graph: makeGraph(),
        finishStatus: status,
      });
      const result = await h.build(executor).execute(input());
      expect(result.status).toBe(status);
      const run = await h.runRepo.findById(RUN_ID);
      expect(run?.status).toBe(status);
      // Non-error terminal ⇒ report still assembled + saved.
      await expect(h.reportRepo.findByRunId(RUN_ID)).resolves.not.toBeNull();
    }
  });

  it('persists a Report retrievable by run id with counts, metadata and "" artifactUri', async () => {
    const h = harness();
    const graph = makeGraph();
    const executor = crawlExecutor({ stream: h.stream, graphRepo: h.graphRepo, graph });

    await h.build(executor).execute(input());

    const report = await h.reportRepo.findByRunId(RUN_ID);
    expect(report).not.toBeNull();
    expect(report?.metadata.runId).toBe(RUN_ID);
    expect(report?.metadata.appId).toBe(APP_ID);
    expect(report?.metadata.appVersion).toBe(APP_VERSION);
    expect(report?.metadata.runStatus).toBe("completed");
    expect(report?.metadata.artifactUri).toBe(REPORT_UNRENDERED_URI);
    expect(report?.totalStates).toBe(graph.nodes.size);
    expect(report?.totalWorkflows).toBe(1);
    expect(report?.duplicatePathCount).toBe(graph.duplicatePathNodeIds.size);
    expect(h.builder.calls).toEqual([RUN_ID]);
  });

  it("graph and report retrieved by run id correspond to the same run (AC4)", async () => {
    const h = harness();
    const executor = crawlExecutor({
      stream: h.stream,
      graphRepo: h.graphRepo,
      graph: makeGraph(),
    });

    await h.build(executor).execute(input());

    const run = await h.runRepo.findById(RUN_ID);
    const graph = await h.graphRepo.findByRunId(RUN_ID);
    const report = await h.reportRepo.findByRunId(RUN_ID);
    expect(graph?.runId).toBe(run?.id);
    expect(report?.metadata.runId).toBe(run?.id);
    expect(graph?.appId).toBe(run?.appId);
    expect(report?.metadata.appId).toBe(run?.appId);
    expect(graph?.appVersion).toBe(run?.appVersion);
    expect(report?.metadata.appVersion).toBe(run?.appVersion);
  });
});

describe("RunAndPersist — failure paths keep the run discoverable (AC3, M84.2/T6)", () => {
  it('a thrown crawl is recorded as status:"error" + finishedAt and rethrown', async () => {
    const h = harness();
    const executor = crawlExecutor({ stream: h.stream, throwError: new Error("driver exploded") });

    await expect(h.build(executor).execute(input())).rejects.toThrow("driver exploded");

    const run = await h.runRepo.findById(RUN_ID);
    expect(run?.status).toBe("error");
    expect(typeof run?.finishedAt).toBe("string");
    await expect(h.reportRepo.findByRunId(RUN_ID)).resolves.toBeNull();
  });

  it('a crawl:error event finalizes the run as "error" without building a report', async () => {
    const h = harness();
    const executor = crawlExecutor({ stream: h.stream, emitErrorEvent: true });

    const result = await h.build(executor).execute(input());

    expect(result.status).toBe("error");
    const run = await h.runRepo.findById(RUN_ID);
    expect(run?.status).toBe("error");
    expect(typeof run?.finishedAt).toBe("string");
    expect(h.builder.calls).toEqual([]);
    await expect(h.reportRepo.findByRunId(RUN_ID)).resolves.toBeNull();
  });

  it('M84.2: a store save failure maps to status:"error" + finishedAt — never silently lost', async () => {
    const h = harness({ reportRepo: new FailingReportRepository() });
    const executor = crawlExecutor({
      stream: h.stream,
      graphRepo: h.graphRepo,
      graph: makeGraph(),
    });

    await expect(h.build(executor).execute(input())).rejects.toThrow("report save failed");

    const run = await h.runRepo.findById(RUN_ID);
    expect(run?.status).toBe("error");
    expect(typeof run?.finishedAt).toBe("string");
  });

  it("if even the error-update fails, the original error propagates and the running/null row remains", async () => {
    const failingRunRepo = new UpdateFailingRunRepository();
    const h = harness({ runRepo: failingRunRepo });
    const executor = crawlExecutor({ stream: h.stream, throwError: new Error("crawl crashed") });

    await expect(h.build(executor).execute(input())).rejects.toThrow("crawl crashed");

    // The step-1 row is still there, discoverable via finishedAt === null (ADR-0008 OQ2).
    const run = await failingRunRepo.findById(RUN_ID);
    expect(run?.status).toBe("running");
    expect(run?.finishedAt).toBeNull();
  });

  it('defensively finalizes as "error" when no terminal event ever arrives', async () => {
    const h = harness();
    const executor = crawlExecutor({ stream: h.stream, silent: true });

    const result = await h.build(executor).execute(input());

    expect(result.status).toBe("error");
    await expect(h.reportRepo.findByRunId(RUN_ID)).resolves.toBeNull();
  });
});

describe("RunAndPersist — hygiene (unsubscribe, no payload logging)", () => {
  it("unsubscribes from the event stream in a finally (success AND failure)", async () => {
    const ok = harness();
    await ok
      .build(crawlExecutor({ stream: ok.stream, graphRepo: ok.graphRepo, graph: makeGraph() }))
      .execute(input());
    expect(ok.stream.activeSubscriptions).toBe(0);

    const bad = harness();
    await expect(
      bad.build(crawlExecutor({ stream: bad.stream, throwError: new Error("x") })).execute(input()),
    ).rejects.toThrow();
    expect(bad.stream.activeSubscriptions).toBe(0);
  });

  it("never logs payload/graph/report content to the console (T1/M84.1 — no new sink)", async () => {
    const spies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "debug"),
    ];
    const h = harness();
    await h
      .build(crawlExecutor({ stream: h.stream, graphRepo: h.graphRepo, graph: makeGraph() }))
      .execute(input());
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
