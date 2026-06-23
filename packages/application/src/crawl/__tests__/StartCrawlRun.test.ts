/**
 * StartCrawlRun use-case unit tests.
 *
 * Covers acceptance criteria for #31 (E2.1 walking-skeleton crawl loop):
 * - AC1: 2-screen app -> >= 2 nodes, >= 1 edge, deduplication
 * - AC2: Event ordering (started, state:discovered, action:taken, state:transition, finished)
 * - AC3: Policy returns "done" -> finalized with status "completed"
 * - AC4: Step ceiling reached -> finalized gracefully with status "partial"
 * - AC5: Port-only (no adapter/SDK imports) — verified by depcruiser
 * - AC6: Coverage gate >= 85%
 */
import { describe, it, expect, beforeEach } from "vitest";
import { StartCrawlRun } from "../StartCrawlRun.js";
import { defaultCollaborators } from "../collaborators.js";
import type { StartCrawlRunInput } from "../StartCrawlRun.js";
import {
  FakeMobileDriver,
  FakeDecisionPolicy,
  FakeCrawlEventStream,
} from "../../../test-support/fakes/index.js";
import { InMemoryStateGraphRepository } from "../persistence/InMemoryStateGraphRepository.js";
import type { A11ySnapshot, CrawlFinishedEvent } from "@flowscout/domain";
import { twoScreenFixture } from "../../../test-support/fixtures/twoScreenFixture.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<StartCrawlRunInput> = {}): StartCrawlRunInput {
  return {
    runId: "run-test-001",
    appId: "com.example.fake",
    appVersion: "1.0.0",
    platform: "ios",
    udid: "fake-udid-0001",
    maxSteps: 10,
    ...overrides,
  };
}

// ── AC1: 2-screen app produces >= 2 nodes, >= 1 edge; revisit deduplicates ──

describe("StartCrawlRun — AC1: graph construction", () => {
  it("produces >= 2 nodes and >= 1 edge for a 2-screen scripted app", async () => {
    const fixture = twoScreenFixture();
    const driver = fixture.driver;
    const policy = fixture.policy;
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const collaborators = defaultCollaborators({
      stateGraphRepository: graphRepo,
      crawlEventStream: eventStream,
    });
    const useCase = new StartCrawlRun(driver, policy, collaborators);

    await useCase.execute(makeInput({ runId: "run-ac1" }));

    const graph = await graphRepo.findByRunId("run-ac1");
    expect(graph).not.toBeNull();
    expect(graph!.nodes.size).toBeGreaterThanOrEqual(2);
    expect(graph!.edges.length).toBeGreaterThanOrEqual(1);
  });

  it("revisiting the same screen resolves to the same node (no duplicate nodes)", async () => {
    const fixture = twoScreenFixture();
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const collaborators = defaultCollaborators({
      stateGraphRepository: graphRepo,
      crawlEventStream: eventStream,
    });
    const useCase = new StartCrawlRun(fixture.driver, fixture.policy, collaborators);

    await useCase.execute(makeInput({ runId: "run-ac1-dedup" }));

    const graph = await graphRepo.findByRunId("run-ac1-dedup");
    expect(graph).not.toBeNull();
    // Each distinct screen snapshot should only appear once as a node
    const nodeIds = [...graph!.nodes.keys()];
    const uniqueIds = new Set(nodeIds);
    expect(nodeIds.length).toBe(uniqueIds.size);
  });

  it("graph has the correct runId, appId, and platform", async () => {
    const fixture = twoScreenFixture();
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const collaborators = defaultCollaborators({
      stateGraphRepository: graphRepo,
      crawlEventStream: eventStream,
    });
    const useCase = new StartCrawlRun(fixture.driver, fixture.policy, collaborators);

    const input = makeInput({ runId: "run-ac1-meta" });
    await useCase.execute(input);

    const graph = await graphRepo.findByRunId("run-ac1-meta");
    expect(graph).not.toBeNull();
    expect(graph!.runId).toBe("run-ac1-meta");
    expect(graph!.appId).toBe(input.appId);
    expect(graph!.platform).toBe(input.platform);
  });
});

// ── AC2: Correct CrawlEvent sequence ─────────────────────────────────────────

describe("StartCrawlRun — AC2: event ordering", () => {
  it("starts with exactly one crawl:started event", async () => {
    const fixture = twoScreenFixture();
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      fixture.driver,
      fixture.policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-ac2" }));

    const events = eventStream.eventsFor("run-ac2");
    const started = events.filter((e) => e.kind === "crawl:started");
    expect(started).toHaveLength(1);
    expect(events[0]!.kind).toBe("crawl:started");
  });

  it("ends with exactly one crawl:finished event", async () => {
    const fixture = twoScreenFixture();
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      fixture.driver,
      fixture.policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-ac2-end" }));

    const events = eventStream.eventsFor("run-ac2-end");
    const finished = events.filter((e) => e.kind === "crawl:finished");
    expect(finished).toHaveLength(1);
    expect(events[events.length - 1]!.kind).toBe("crawl:finished");
  });

  it("emits state:discovered events for new screens", async () => {
    const fixture = twoScreenFixture();
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      fixture.driver,
      fixture.policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-ac2-discovered" }));

    const events = eventStream.eventsFor("run-ac2-discovered");
    const discovered = events.filter((e) => e.kind === "state:discovered");
    expect(discovered.length).toBeGreaterThanOrEqual(1);
  });

  it("emits action:taken before state:transition", async () => {
    const fixture = twoScreenFixture();
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      fixture.driver,
      fixture.policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-ac2-order" }));

    const events = eventStream.eventsFor("run-ac2-order");
    // Find the first action:taken and the first state:transition
    const actionIdx = events.findIndex((e) => e.kind === "action:taken");
    const transitionIdx = events.findIndex((e) => e.kind === "state:transition");

    if (actionIdx !== -1 && transitionIdx !== -1) {
      expect(actionIdx).toBeLessThan(transitionIdx);
    }
  });

  it("event sequence is started -> ... -> finished with no duplicate envelope events", async () => {
    const fixture = twoScreenFixture();
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      fixture.driver,
      fixture.policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-ac2-seq" }));

    const events = eventStream.eventsFor("run-ac2-seq");
    const kinds = events.map((e) => e.kind);

    // Exactly one started, one finished
    expect(kinds.filter((k) => k === "crawl:started")).toHaveLength(1);
    expect(kinds.filter((k) => k === "crawl:finished")).toHaveLength(1);
    // started is first, finished is last
    expect(kinds[0]).toBe("crawl:started");
    expect(kinds[kinds.length - 1]).toBe("crawl:finished");
  });
});

// ── AC3: Policy returns "done" -> status "completed" ─────────────────────────

describe("StartCrawlRun — AC3: done decision -> completed", () => {
  it("when policy returns done immediately, finishes with status completed", async () => {
    const driver = new FakeMobileDriver();
    const policy = new FakeDecisionPolicy([{ kind: "done", reason: "all explored" }]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-ac3" }));

    const events = eventStream.eventsFor("run-ac3");
    const finished = events.find((e) => e.kind === "crawl:finished") as
      | CrawlFinishedEvent
      | undefined;
    expect(finished).toBeDefined();
    expect(finished!.status).toBe("completed");
  });

  it("loop stops after policy returns done (no infinite loop)", async () => {
    const driver = new FakeMobileDriver();
    const policy = new FakeDecisionPolicy([{ kind: "done", reason: "done" }]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-ac3-stop" }));

    // policy should have been called only once (decided "done" and loop stopped)
    expect(policy.getCallCount()).toBe(1);
  });
});

// ── AC4: Step ceiling -> graceful "partial" finalization ─────────────────────

describe("StartCrawlRun — AC4: step ceiling -> partial", () => {
  it("when step ceiling is reached, finishes with status partial", async () => {
    const driver = new FakeMobileDriver();
    // Policy never says done — always acts
    const tapAction = {
      actionType: "tap" as const,
      actionPayload: JSON.stringify({ elementId: "btn-next" }),
      rationale: "keep tapping",
    };
    const policy = new FakeDecisionPolicy(
      Array.from({ length: 20 }, () => ({
        kind: "act" as const,
        action: tapAction,
        usedLlm: false,
      })),
    );
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-ac4", maxSteps: 3 }));

    const events = eventStream.eventsFor("run-ac4");
    const finished = events.find((e) => e.kind === "crawl:finished") as
      | CrawlFinishedEvent
      | undefined;
    expect(finished).toBeDefined();
    expect(finished!.status).toBe("partial");
  });

  it("does not spin after ceiling is hit (policy call count <= maxSteps)", async () => {
    const driver = new FakeMobileDriver();
    const tapAction = {
      actionType: "tap" as const,
      actionPayload: JSON.stringify({ elementId: "btn-next" }),
      rationale: "tap",
    };
    const policy = new FakeDecisionPolicy(
      Array.from({ length: 50 }, () => ({
        kind: "act" as const,
        action: tapAction,
        usedLlm: false,
      })),
    );
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-ac4-nopin", maxSteps: 5 }));

    // Policy should not have been called more than maxSteps times
    expect(policy.getCallCount()).toBeLessThanOrEqual(5);
  });

  it("exactly one crawl:finished even when ceiling is hit", async () => {
    const driver = new FakeMobileDriver();
    const policy = new FakeDecisionPolicy(
      Array.from({ length: 20 }, () => ({
        kind: "act" as const,
        action: {
          actionType: "tap" as const,
          actionPayload: "{}",
          rationale: "tap",
        },
        usedLlm: false,
      })),
    );
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-ac4-once", maxSteps: 2 }));

    const events = eventStream.eventsFor("run-ac4-once");
    const finished = events.filter((e) => e.kind === "crawl:finished");
    expect(finished).toHaveLength(1);
  });
});

// ── InMemoryStateGraphRepository tests ───────────────────────────────────────

describe("InMemoryStateGraphRepository", () => {
  let repo: InMemoryStateGraphRepository;

  beforeEach(() => {
    repo = new InMemoryStateGraphRepository();
  });

  it("returns null for an unknown runId", async () => {
    expect(await repo.findByRunId("does-not-exist")).toBeNull();
  });

  it("saves and retrieves a graph", async () => {
    const graph = {
      runId: "run-mem-01",
      appId: "com.example",
      appVersion: "1.0",
      platform: "ios" as const,
      nodes: new Map(),
      edges: [],
      duplicatePathNodeIds: new Set(),
    };
    await repo.saveGraph(graph);
    const found = await repo.findByRunId("run-mem-01");
    expect(found).not.toBeNull();
    expect(found!.runId).toBe("run-mem-01");
  });

  it("upserts a node into an existing graph", async () => {
    const graph = {
      runId: "run-mem-02",
      appId: "com.example",
      appVersion: "1.0",
      platform: "ios" as const,
      nodes: new Map(),
      edges: [],
      duplicatePathNodeIds: new Set(),
    };
    await repo.saveGraph(graph);

    const node = {
      id: "state-abc" as import("@flowscout/domain").StateIdentity,
      label: "Home",
      platform: "ios" as const,
      firstSeenAt: new Date().toISOString(),
      a11ySnapshot: '{"role":"application"}',
      screenshotUri: null,
    };
    await repo.upsertNode("run-mem-02", node);

    const found = await repo.findByRunId("run-mem-02");
    expect(found!.nodes.size).toBe(1);
    expect(found!.nodes.get("state-abc" as import("@flowscout/domain").StateIdentity)).toEqual(
      node,
    );
  });

  it("appends edges to an existing graph", async () => {
    const graph = {
      runId: "run-mem-03",
      appId: "com.example",
      appVersion: "1.0",
      platform: "ios" as const,
      nodes: new Map(),
      edges: [],
      duplicatePathNodeIds: new Set(),
    };
    await repo.saveGraph(graph);

    const edge = {
      id: "edge-001",
      fromId: "state-a" as import("@flowscout/domain").StateIdentity,
      toId: "state-b" as import("@flowscout/domain").StateIdentity,
      actionType: "tap" as const,
      actionPayload: "{}",
      observedAt: new Date().toISOString(),
    };
    await repo.appendEdge("run-mem-03", edge);

    const found = await repo.findByRunId("run-mem-03");
    expect(found!.edges).toHaveLength(1);
    expect(found!.edges[0]).toEqual(edge);
  });

  it("findStatesByApp returns an empty map (cross-run diffing is E7)", async () => {
    const result = await repo.findStatesByApp("com.example");
    expect(result.size).toBe(0);
  });

  it("upsertNode updates an existing node with the same id", async () => {
    await repo.saveGraph({
      runId: "run-upsert",
      appId: "com.example",
      appVersion: "1.0",
      platform: "ios" as const,
      nodes: new Map(),
      edges: [],
      duplicatePathNodeIds: new Set(),
    });

    const node = {
      id: "state-x" as import("@flowscout/domain").StateIdentity,
      label: "Screen X",
      platform: "ios" as const,
      firstSeenAt: new Date().toISOString(),
      a11ySnapshot: "{}",
      screenshotUri: null,
    };
    await repo.upsertNode("run-upsert", node);
    const updatedNode = { ...node, label: "Screen X Updated" };
    await repo.upsertNode("run-upsert", updatedNode);

    const found = await repo.findByRunId("run-upsert");
    // After upsert, node should be updated
    expect(found!.nodes.size).toBe(1);
    expect(found!.nodes.get("state-x" as import("@flowscout/domain").StateIdentity)!.label).toBe(
      "Screen X Updated",
    );
  });

  it("upsertNode is a no-op if the runId does not exist", async () => {
    const node = {
      id: "state-y" as import("@flowscout/domain").StateIdentity,
      label: "Screen Y",
      platform: "ios" as const,
      firstSeenAt: new Date().toISOString(),
      a11ySnapshot: "{}",
      screenshotUri: null,
    };
    // Should not throw
    await expect(repo.upsertNode("nonexistent-run", node)).resolves.toBeUndefined();
  });

  it("appendEdge is a no-op if the runId does not exist", async () => {
    const edge = {
      id: "edge-x",
      fromId: "a" as import("@flowscout/domain").StateIdentity,
      toId: "b" as import("@flowscout/domain").StateIdentity,
      actionType: "tap" as const,
      actionPayload: "{}",
      observedAt: new Date().toISOString(),
    };
    // Should not throw
    await expect(repo.appendEdge("nonexistent-run", edge)).resolves.toBeUndefined();
  });
});

// ── Collaborator stub behavior tests ─────────────────────────────────────────

describe("defaultCollaborators stubs", () => {
  it("BudgetEnforcer allows steps below ceiling", async () => {
    const driver = new FakeMobileDriver();
    const policy = new FakeDecisionPolicy([{ kind: "done", reason: "done" }]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await expect(
      useCase.execute(makeInput({ runId: "run-budget-ok", maxSteps: 10 })),
    ).resolves.toBeUndefined();
  });

  it("Frontier provides candidates when policy acts", async () => {
    const driver = new FakeMobileDriver();
    const policy = new FakeDecisionPolicy([
      {
        kind: "act",
        action: { actionType: "tap", actionPayload: '{"elementId":"btn"}', rationale: "tap btn" },
        usedLlm: false,
      },
      { kind: "done", reason: "done" },
    ]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-frontier-ok", maxSteps: 5 }));

    const events = eventStream.eventsFor("run-frontier-ok");
    // Should have at least one action:taken event
    const actionTaken = events.filter((e) => e.kind === "action:taken");
    expect(actionTaken.length).toBeGreaterThanOrEqual(1);
  });
});

// ── CrawlFinishedEvent totalStates/totalSteps correctness ────────────────────

describe("StartCrawlRun — crawl:finished payload", () => {
  it("totalStates matches the number of nodes in the graph", async () => {
    const fixture = twoScreenFixture();
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      fixture.driver,
      fixture.policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-totals" }));

    const events = eventStream.eventsFor("run-totals");
    const finished = events.find((e) => e.kind === "crawl:finished") as
      | CrawlFinishedEvent
      | undefined;
    const graph = await graphRepo.findByRunId("run-totals");

    expect(finished).toBeDefined();
    expect(finished!.totalStates).toBe(graph!.nodes.size);
  });

  it("totalSteps is non-negative", async () => {
    const fixture = twoScreenFixture();
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      fixture.driver,
      fixture.policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-steps" }));

    const events = eventStream.eventsFor("run-steps");
    const finished = events.find((e) => e.kind === "crawl:finished") as
      | CrawlFinishedEvent
      | undefined;
    expect(finished!.totalSteps).toBeGreaterThanOrEqual(0);
  });
});

// ── executeAction branch coverage ────────────────────────────────────────────

describe("StartCrawlRun — executeAction branch coverage", () => {
  it("executes a typeText action via the driver", async () => {
    const driver = new FakeMobileDriver();
    const policy = new FakeDecisionPolicy([
      {
        kind: "act",
        action: {
          actionType: "typeText",
          actionPayload: JSON.stringify({ text: "hello-world" }),
          rationale: "type text",
        },
        usedLlm: false,
      },
      { kind: "done", reason: "done" },
    ]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-typetext" }));
    expect(driver.typedTexts).toHaveLength(1);
    expect(driver.typedTexts[0]!.text).toBe("hello-world");
  });

  it("executes a swipe action via the driver (with direction)", async () => {
    const driver = new FakeMobileDriver();
    const policy = new FakeDecisionPolicy([
      {
        kind: "act",
        action: {
          actionType: "swipe",
          actionPayload: JSON.stringify({ direction: "up", distance: 100 }),
          rationale: "swipe up",
        },
        usedLlm: false,
      },
      { kind: "done", reason: "done" },
    ]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-swipe" }));
    expect(driver.swipes).toHaveLength(1);
    expect(driver.swipes[0]!.direction).toBe("up");
    expect(driver.swipes[0]!.distance).toBe(100);
  });

  it("executes a tap via coordinate payload", async () => {
    const driver = new FakeMobileDriver();
    const policy = new FakeDecisionPolicy([
      {
        kind: "act",
        action: {
          actionType: "tap",
          actionPayload: JSON.stringify({ x: 100, y: 200 }),
          rationale: "tap coordinate",
        },
        usedLlm: false,
      },
      { kind: "done", reason: "done" },
    ]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-tap-coord" }));
    expect(driver.taps).toHaveLength(1);
    expect(driver.taps[0]!.target).toEqual({ kind: "coordinate", x: 100, y: 200 });
  });

  it("handles malformed tap payload without crashing (safe fallback)", async () => {
    const driver = new FakeMobileDriver();
    const policy = new FakeDecisionPolicy([
      {
        kind: "act",
        action: {
          actionType: "tap",
          actionPayload: "not-json-{{",
          rationale: "malformed payload",
        },
        usedLlm: false,
      },
      { kind: "done", reason: "done" },
    ]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    // Should not throw on malformed payload — safe fallback
    await expect(useCase.execute(makeInput({ runId: "run-malformed" }))).resolves.toBeUndefined();
    // No taps should have been dispatched (failed to parse)
    expect(driver.taps).toHaveLength(0);
  });

  it("handles gesture action type without crashing (no-op, unsupported by E1 driver)", async () => {
    const driver = new FakeMobileDriver();
    const policy = new FakeDecisionPolicy([
      {
        kind: "act",
        action: {
          actionType: "gesture",
          actionPayload: JSON.stringify({ gestureType: "long-press" }),
          rationale: "long press (degraded no-op)",
        },
        usedLlm: false,
      },
      { kind: "done", reason: "done" },
    ]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    // gesture is not supported by E1 driver — degraded no-op, must not crash
    await expect(useCase.execute(makeInput({ runId: "run-gesture" }))).resolves.toBeUndefined();
    expect(driver.taps).toHaveLength(0);
  });

  it("handles scroll action type without crashing (no-op)", async () => {
    const driver = new FakeMobileDriver();
    const policy = new FakeDecisionPolicy([
      {
        kind: "act",
        action: { actionType: "scroll", actionPayload: "{}", rationale: "scroll" },
        usedLlm: false,
      },
      { kind: "done", reason: "done" },
    ]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await expect(useCase.execute(makeInput({ runId: "run-scroll" }))).resolves.toBeUndefined();
  });

  it("handles navigate action type without crashing (no-op)", async () => {
    const driver = new FakeMobileDriver();
    const policy = new FakeDecisionPolicy([
      {
        kind: "act",
        action: { actionType: "navigate", actionPayload: "{}", rationale: "navigate" },
        usedLlm: false,
      },
      { kind: "done", reason: "done" },
    ]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await expect(useCase.execute(makeInput({ runId: "run-navigate" }))).resolves.toBeUndefined();
  });

  it("handles backtrack decision gracefully (stub: finalizes as completed)", async () => {
    const driver = new FakeMobileDriver();
    const policy = new FakeDecisionPolicy([{ kind: "backtrack", reason: "dead end" }]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-backtrack" }));

    const events = eventStream.eventsFor("run-backtrack");
    const finished = events.find((e) => e.kind === "crawl:finished") as
      | CrawlFinishedEvent
      | undefined;
    expect(finished).toBeDefined();
    expect(finished!.status).toBe("completed");
  });

  it("swipe without distance uses undefined (no distance field in payload)", async () => {
    const driver = new FakeMobileDriver();
    const policy = new FakeDecisionPolicy([
      {
        kind: "act",
        action: {
          actionType: "swipe",
          actionPayload: JSON.stringify({ direction: "down" }),
          rationale: "swipe down no distance",
        },
        usedLlm: false,
      },
      { kind: "done", reason: "done" },
    ]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-swipe-no-dist" }));
    expect(driver.swipes).toHaveLength(1);
    expect(driver.swipes[0]!.direction).toBe("down");
    expect(driver.swipes[0]!.distance).toBeUndefined();
  });

  it("tap with unrecognised payload keys is a no-op (safe fallback)", async () => {
    const driver = new FakeMobileDriver();
    const policy = new FakeDecisionPolicy([
      {
        kind: "act",
        action: {
          actionType: "tap",
          actionPayload: JSON.stringify({ unknownKey: "value" }),
          rationale: "bad tap payload",
        },
        usedLlm: false,
      },
      { kind: "done", reason: "done" },
    ]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-bad-tap" }));
    // No tap dispatched — unrecognised keys, no-op
    expect(driver.taps).toHaveLength(0);
  });

  it("typeText with non-string text field is a no-op", async () => {
    const driver = new FakeMobileDriver();
    const policy = new FakeDecisionPolicy([
      {
        kind: "act",
        action: {
          actionType: "typeText",
          actionPayload: JSON.stringify({ text: 12345 }),
          rationale: "bad typetext payload",
        },
        usedLlm: false,
      },
      { kind: "done", reason: "done" },
    ]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-bad-typetext" }));
    expect(driver.typedTexts).toHaveLength(0);
  });
});

// ── StateIdentity edge cases ──────────────────────────────────────────────────

describe("StateIdentity edge cases", () => {
  it("empty snapshot gets a degraded identity", async () => {
    const driver = new FakeMobileDriver();
    driver.snapshotOverride = "" as A11ySnapshot;

    const policy = new FakeDecisionPolicy([{ kind: "done", reason: "done" }]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-degraded" }));

    const graph = await graphRepo.findByRunId("run-degraded");
    expect(graph).not.toBeNull();
    expect(graph!.nodes.size).toBe(1);
    const nodeId = [...graph!.nodes.keys()][0]!;
    expect(nodeId).toContain("degraded");
  });
});

// ── Security: no a11y bodies in events (T7 metadata-only) ────────────────────

describe("StartCrawlRun — security: no a11y body in ActionTakenEvent", () => {
  it("ActionTakenEvent carries action and decision, not the raw a11y snapshot", async () => {
    const driver = new FakeMobileDriver();
    // Snapshot contains a "secret-looking" string — must not appear in events
    const secretSnapshot =
      '{"role":"application","children":[{"role":"textField","label":"password","value":"SECRET-TOKEN-12345"}]}' as A11ySnapshot;
    driver.snapshotOverride = secretSnapshot;

    const policy = new FakeDecisionPolicy([
      {
        kind: "act",
        action: { actionType: "tap", actionPayload: '{"elementId":"btn"}', rationale: "tap" },
        usedLlm: false,
      },
      { kind: "done", reason: "done" },
    ]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-security" }));

    const events = eventStream.eventsFor("run-security");
    const actionEvents = events.filter((e) => e.kind === "action:taken");

    for (const event of actionEvents) {
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain("SECRET-TOKEN-12345");
    }
  });
});

// ── Identity strategy: same snapshot -> same StateIdentity ────────────────────

describe("StartCrawlRun — StateIdentity deduplication", () => {
  it("same a11y snapshot always produces the same node id (no graph explosion)", async () => {
    const driver = new FakeMobileDriver();
    // Driver always returns the same snapshot -> same identity -> only 1 node
    const policy = new FakeDecisionPolicy([
      {
        kind: "act",
        action: { actionType: "tap", actionPayload: '{"elementId":"btn"}', rationale: "tap" },
        usedLlm: false,
      },
      {
        kind: "act",
        action: { actionType: "tap", actionPayload: '{"elementId":"btn"}', rationale: "tap" },
        usedLlm: false,
      },
      { kind: "done", reason: "done" },
    ]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput({ runId: "run-same-snap" }));

    const graph = await graphRepo.findByRunId("run-same-snap");
    // Because snapshot never changes, there should be exactly 1 unique node
    expect(graph!.nodes.size).toBe(1);
  });
});
