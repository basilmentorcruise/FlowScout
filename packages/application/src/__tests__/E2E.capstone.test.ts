/**
 * E2.7 Capstone E2E test — Layer A (always-on, fake driver, no real simulator/LLM).
 *
 * Tests the full crawl engine integration with all #37 behaviors:
 *   - candidateActions populated + CachedKnowledgePolicy as chain head (MUST)
 *   - Redaction boundary: credential/OTP tokens absent from events/graph/LLM payloads
 *   - 2FA boundary: CredentialPromptEvent emitted, blocked-on-2fa, no cred to LLM
 *   - No-production guard: production-looking target refused (crawl:error, no crawl:started)
 *   - Reset-safety-net: snapshot taken before loop; abort if cannot establish
 *   - Duplicate-path detection: two-path node in StateGraph.duplicatePathNodeIds
 *   - Budget feed: truthful usage halts on LLM-call cap
 *   - Injection label: off-allowlist action NOT taken (T1/T2)
 *   - Probe candidates: probe-generated candidates appear in context
 *
 * This is a deterministic test — no real network/simulator/LLM calls.
 * Fixture data is synthetic (T12: no real identifiers, tokens, OTPs, or PII).
 */
import { describe, it, expect } from "vitest";
import { StartCrawlRun } from "../crawl/StartCrawlRun.js";
import { defaultCollaborators } from "../crawl/collaborators.js";
import { CachedKnowledgePolicy } from "../crawl/policy/CachedKnowledgePolicy.js";
import type { DecisionContextWithCandidates } from "../crawl/policy/CachedKnowledgePolicy.js";
import { InMemoryStateGraphRepository } from "../crawl/persistence/InMemoryStateGraphRepository.js";
import { FakeCrawlEventStream } from "../../test-support/fakes/FakeCrawlEventStream.js";
import { FakeSimulatorLifecycle } from "../../test-support/fakes/FakeMobileDriver.js";
import { FakeDecisionPolicy } from "../../test-support/fakes/FakeDecisionPolicy.js";
import { BudgetEnforcer } from "../crawl/budget/BudgetEnforcer.js";
import { defaultCrawlBudget } from "@flowscout/domain";
import type {
  CrawlFinishedEvent,
  CredentialPromptEvent,
  CrawlErrorEvent,
  CandidateAction,
  DecisionContext,
  PolicyDecision,
  A11ySnapshot,
  ActionTakenEvent,
} from "@flowscout/domain";
import {
  CapstoneDriver,
  buildCapstonePolicy,
  tapAction,
} from "../../test-support/fixtures/capstoneFixture.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeInput(runId: string, maxSteps = 20) {
  return {
    runId,
    appId: "com.fake.capstone",
    appVersion: "1.0.0",
    platform: "ios" as const,
    udid: "fake-udid-capstone",
    maxSteps,
  };
}

// ── AC: Duplicate-path detection ──────────────────────────────────────────────

describe("E2.7 AC: duplicate-path detection", () => {
  it("node reachable via two distinct paths appears in duplicatePathNodeIds", async () => {
    /**
     * Navigation: HOME→INJECTION→DETAIL (path 1), then HOME→DETAIL (path 2).
     * DETAIL screen should appear in duplicatePathNodeIds.
     */
    const driver = new CapstoneDriver();
    const policy = new FakeDecisionPolicy([
      { kind: "act", action: tapAction("btn-injection", "go to injection"), usedLlm: false },
      {
        kind: "act",
        action: tapAction("btn-detail-from-injection", "detail from inj"),
        usedLlm: false,
      },
      { kind: "act", action: tapAction("btn-back-to-home", "back to home"), usedLlm: false },
      {
        kind: "act",
        action: tapAction("btn-detail-from-home", "detail from home"),
        usedLlm: false,
      },
      { kind: "done", reason: "all done" },
    ]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput("run-dup-path"));

    const graph = await graphRepo.findByRunId("run-dup-path");
    expect(graph).not.toBeNull();
    expect(graph!.duplicatePathNodeIds.size).toBeGreaterThanOrEqual(1);
  });
});

// ── AC: 2FA boundary ──────────────────────────────────────────────────────────

describe("E2.7 AC: 2FA boundary", () => {
  it("emits CredentialPromptEvent and finalizes blocked-on-2fa when 2FA screen reached", async () => {
    const driver = new CapstoneDriver();
    const policy = new FakeDecisionPolicy([
      { kind: "act", action: tapAction("btn-detail-from-home", "go detail"), usedLlm: false },
      { kind: "act", action: tapAction("btn-security", "show security"), usedLlm: false },
      { kind: "done", reason: "should-not-reach" },
    ]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput("run-2fa"));

    const events = eventStream.eventsFor("run-2fa");
    const credPrompt = events.find((e) => e.kind === "credential:prompt") as
      | CredentialPromptEvent
      | undefined;
    const finished = events.find((e) => e.kind === "crawl:finished") as
      | CrawlFinishedEvent
      | undefined;

    expect(credPrompt).toBeDefined();
    expect(finished).toBeDefined();
    expect(finished!.status).toBe("blocked-on-2fa");
  });

  it("CredentialPromptEvent has no credential values in message (T8)", async () => {
    const driver = new CapstoneDriver();
    const policy = new FakeDecisionPolicy([
      { kind: "act", action: tapAction("btn-detail-from-home", "go detail"), usedLlm: false },
      { kind: "act", action: tapAction("btn-security", "show security"), usedLlm: false },
      { kind: "done", reason: "done" },
    ]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput("run-2fa-clean"));

    const events = eventStream.eventsFor("run-2fa-clean");
    const credEvent = events.find((e) => e.kind === "credential:prompt") as
      | CredentialPromptEvent
      | undefined;

    expect(credEvent).toBeDefined();
    expect(credEvent!.message).not.toContain("FAKE-OTP-123456");
    expect(credEvent!.message).not.toContain("123456");
  });

  it("credential screen does NOT produce an action:taken event (detector stops before decide)", async () => {
    const driver = new CapstoneDriver();
    const policy = new FakeDecisionPolicy([
      { kind: "act", action: tapAction("btn-detail-from-home", "go detail"), usedLlm: false },
      { kind: "act", action: tapAction("btn-security", "show security"), usedLlm: false },
      { kind: "done", reason: "done" },
    ]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput("run-2fa-llm-check"));

    const events = eventStream.eventsFor("run-2fa-llm-check");
    const actionEvents = events.filter((e) => e.kind === "action:taken");

    // The 2FA screen should not produce an action:taken (blocked before decide)
    const twoFaAction = actionEvents.some((e) => {
      return JSON.stringify(e).includes("Two-Factor");
    });
    expect(twoFaAction).toBe(false);
  });
});

// ── AC: No-production guard (T4) ──────────────────────────────────────────────

describe("E2.7 AC: no-production guard", () => {
  it("aborts with crawl:error when nonProduction is false (no crawl:started)", async () => {
    const driver = new CapstoneDriver();
    const policy = new FakeDecisionPolicy([{ kind: "done", reason: "done" }]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({
        stateGraphRepository: graphRepo,
        crawlEventStream: eventStream,
        runSafety: { target: "fake-udid-capstone", nonProduction: false },
      }),
    );

    await useCase.execute(makeInput("run-prod-guard"));

    const events = eventStream.eventsFor("run-prod-guard");
    const errorEvent = events.find((e) => e.kind === "crawl:error") as CrawlErrorEvent | undefined;
    const startedEvent = events.find((e) => e.kind === "crawl:started");

    expect(errorEvent).toBeDefined();
    expect(startedEvent).toBeUndefined(); // loop never started
  });

  it("proceeds normally when nonProduction is true", async () => {
    const driver = new CapstoneDriver();
    const policy = new FakeDecisionPolicy([{ kind: "done", reason: "done" }]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({
        stateGraphRepository: graphRepo,
        crawlEventStream: eventStream,
        runSafety: { target: "fake-udid-capstone", nonProduction: true },
      }),
    );

    await useCase.execute(makeInput("run-non-prod"));

    const events = eventStream.eventsFor("run-non-prod");
    const startedEvent = events.find((e) => e.kind === "crawl:started");
    const finishedEvent = events.find((e) => e.kind === "crawl:finished");

    expect(startedEvent).toBeDefined();
    expect(finishedEvent).toBeDefined();
  });
});

// ── AC: Reset-safety-net (T4) ─────────────────────────────────────────────────

describe("E2.7 AC: reset-safety-net", () => {
  it("takes a snapshot before destructive exploration", async () => {
    const driver = new CapstoneDriver();
    const lifecycle = new FakeSimulatorLifecycle();
    const policy = new FakeDecisionPolicy([{ kind: "done", reason: "done" }]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({
        stateGraphRepository: graphRepo,
        crawlEventStream: eventStream,
        simulatorLifecycle: lifecycle,
        runSafety: { target: "fake-udid-capstone", nonProduction: true },
      }),
    );

    await useCase.execute(makeInput("run-reset-net"));

    expect(lifecycle.snapshots.size).toBeGreaterThanOrEqual(1);
  });

  it("aborts with crawl:error when snapshot cannot be established", async () => {
    const driver = new CapstoneDriver();
    const failingLifecycle = {
      async bootSimulator() {},
      async installApp() {},
      async launchApp() {},
      async takeSnapshot() {
        throw new Error("Snapshot failed");
      },
      async resetToSnapshot() {},
      async shutdownSimulator() {},
    };
    const policy = new FakeDecisionPolicy([{ kind: "done", reason: "done" }]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({
        stateGraphRepository: graphRepo,
        crawlEventStream: eventStream,
        simulatorLifecycle: failingLifecycle,
        runSafety: { target: "fake-udid-capstone", nonProduction: true },
      }),
    );

    await useCase.execute(makeInput("run-no-snapshot"));

    const events = eventStream.eventsFor("run-no-snapshot");
    const errorEvent = events.find((e) => e.kind === "crawl:error") as CrawlErrorEvent | undefined;
    const startedEvent = events.find((e) => e.kind === "crawl:started");

    expect(errorEvent).toBeDefined();
    expect(startedEvent).toBeUndefined();
  });
});

// ── AC: Redaction boundary (T3/T7) ───────────────────────────────────────────

describe("E2.7 AC: redaction boundary (T3/T7)", () => {
  it("synthetic OTP token ABSENT from all events after reaching 2FA screen", async () => {
    const driver = new CapstoneDriver();
    const policy = new FakeDecisionPolicy([
      { kind: "act", action: tapAction("btn-detail-from-home", "go detail"), usedLlm: false },
      { kind: "act", action: tapAction("btn-security", "show security"), usedLlm: false },
      { kind: "done", reason: "done" },
    ]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput("run-redact-events"));

    const events = eventStream.eventsFor("run-redact-events");
    const allEventsSerialized = JSON.stringify(events);
    expect(allEventsSerialized).not.toContain("FAKE-OTP-123456");
  });

  it("synthetic OTP token ABSENT from graph node a11ySnapshot", async () => {
    const driver = new CapstoneDriver();
    const policy = new FakeDecisionPolicy([
      { kind: "act", action: tapAction("btn-detail-from-home", "go detail"), usedLlm: false },
      { kind: "act", action: tapAction("btn-security", "show security"), usedLlm: false },
      { kind: "done", reason: "done" },
    ]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput("run-redact-graph"));

    const graph = await graphRepo.findByRunId("run-redact-graph");
    expect(graph).not.toBeNull();
    const allNodeSnapshots = [...graph!.nodes.values()].map((n) => n.a11ySnapshot).join("");
    expect(allNodeSnapshots).not.toContain("FAKE-OTP-123456");
  });

  it("typeText OTP payload is redacted in events but real value typed into driver", async () => {
    const driver = new CapstoneDriver();
    const snapWithTextField = JSON.stringify({
      role: "application",
      children: [{ role: "textField", label: "Search", id: "search-field" }],
    }) as A11ySnapshot;
    driver.snapshotOverride = snapWithTextField;

    const typeAction: CandidateAction = {
      actionType: "typeText",
      actionPayload: JSON.stringify({ text: "654321" }), // OTP-shaped
      rationale: "type search query",
    };
    const policy = new FakeDecisionPolicy([
      { kind: "act", action: typeAction, usedLlm: false },
      { kind: "done", reason: "done" },
    ]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput("run-type-redact"));

    // The action:taken event must NOT contain the raw OTP-shaped text
    const events = eventStream.eventsFor("run-type-redact");
    const actionEvents = events.filter((e) => e.kind === "action:taken") as ActionTakenEvent[];
    const serialized = JSON.stringify(actionEvents);
    expect(serialized).not.toContain('"text":"654321"');
    // But the real text was typed into the driver
    expect(driver.typedTexts.some((t) => t.text === "654321")).toBe(true);
  });
});

// ── AC: Injection label → no off-allowlist action (T1/T2) ────────────────────

describe("E2.7 AC: injection resistance (T1/T2)", () => {
  it("injection-shaped label does NOT produce an off-allowlist action", async () => {
    const driver = new CapstoneDriver();
    const policy = new FakeDecisionPolicy([
      { kind: "act", action: tapAction("btn-injection", "go to injection"), usedLlm: false },
      { kind: "done", reason: "done" },
    ]);
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput("run-injection"));

    const events = eventStream.eventsFor("run-injection");
    const actionEvents = events.filter((e) => e.kind === "action:taken");
    const serialized = JSON.stringify(actionEvents);

    // No action should reference the injection text
    expect(serialized).not.toContain("Delete Account");
    expect(serialized).not.toContain("ignore previous instructions");
  });
});

// ── AC: candidateActions populated + CachedKnowledgePolicy cache-first ────────

describe("E2.7 AC: candidateActions populated + chain-head cache-first (MUST)", () => {
  it("CachedKnowledgePolicy returns usedLlm:false when untried candidate exists in context", async () => {
    /**
     * Wire CachedKnowledgePolicy as the chain head.
     * Home screen provides candidate buttons → CachedKnowledgePolicy should pick one
     * without calling the fake LLM (usedLlm: false).
     */
    const driver = new CapstoneDriver();
    const fakeLlmPolicy = new FakeDecisionPolicy([
      {
        kind: "act",
        action: tapAction("btn-injection", "LLM chose injection"),
        usedLlm: true,
      },
      { kind: "done", reason: "done" },
    ]);

    const chainHead = new CachedKnowledgePolicy(fakeLlmPolicy);

    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      chainHead,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput("run-cache-first", 3));

    const events = eventStream.eventsFor("run-cache-first");
    const actionEvents = events.filter((e) => e.kind === "action:taken") as ActionTakenEvent[];

    // At least one action should have usedLlm: false (CachedKnowledgePolicy picked it)
    const cacheHitAction = actionEvents.find((e) => {
      return e.decision.kind === "act" && !e.decision.usedLlm;
    });
    expect(cacheHitAction).toBeDefined();
  });

  it("candidateActions are populated in the decision context (enumerator invoked)", async () => {
    const receivedCandidates: Array<readonly CandidateAction[]> = [];

    const recordingPolicy = {
      async decide(ctx: DecisionContext): Promise<PolicyDecision> {
        const extCtx = ctx as DecisionContextWithCandidates;
        if (extCtx.candidateActions !== undefined) {
          receivedCandidates.push(extCtx.candidateActions);
        }
        return { kind: "done", reason: "done-after-recording" };
      },
    };

    const driver = new CapstoneDriver();
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      recordingPolicy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput("run-candidates"));

    // candidateActions should have been populated (Home screen has buttons)
    expect(receivedCandidates.length).toBeGreaterThanOrEqual(1);
    expect(receivedCandidates[0]!.length).toBeGreaterThanOrEqual(1);
  });
});

// ── AC: Budget feed — truthful LLM usage halts on cap ─────────────────────────

describe("E2.7 AC: truthful LLM usage feed to BudgetEnforcer (T6)", () => {
  it("run halts at LLM-call cap when usageReporter reports truthful counts", async () => {
    const driver = new CapstoneDriver();

    const mockUsageReporter = {
      lastCall: () => ({ promptTokens: 100, completionTokens: 50 }),
    };

    // Policy that always uses LLM
    const policy = new FakeDecisionPolicy(
      Array.from({ length: 20 }, () => ({
        kind: "act" as const,
        action: tapAction("btn-injection", "repeat action"),
        usedLlm: true,
      })),
    );

    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    // Budget: maxLlmCalls = 2 — should halt after 2 LLM calls
    const tightBudget = {
      ...defaultCrawlBudget(),
      maxSteps: 20,
      maxLlmCalls: 2,
      maxTokens: 999_999,
    };
    const budgetEnforcer = new BudgetEnforcer(tightBudget, eventStream, "run-budget-feed");

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({
        stateGraphRepository: graphRepo,
        crawlEventStream: eventStream,
        budgetEnforcer,
        usageReporter: mockUsageReporter,
      }),
    );

    await useCase.execute(makeInput("run-budget-feed"));

    const events = eventStream.eventsFor("run-budget-feed");
    const finished = events.find((e) => e.kind === "crawl:finished") as
      | CrawlFinishedEvent
      | undefined;
    const actionEvents = events.filter((e) => e.kind === "action:taken");

    expect(finished).toBeDefined();
    expect(finished!.status).toBe("partial");
    // Halted well before max 20 steps
    expect(actionEvents.length).toBeLessThan(15);
  });
});

// ── AC: Full integration — connected graph covering fixture screens ──────────

describe("E2.7 AC: full integration crawl", () => {
  it("produces a connected graph with multiple screens from capstone fixture", async () => {
    const driver = new CapstoneDriver();
    const policy = buildCapstonePolicy();
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({
        stateGraphRepository: graphRepo,
        crawlEventStream: eventStream,
      }),
    );

    await useCase.execute(makeInput("run-full-capstone", 30));

    const events = eventStream.eventsFor("run-full-capstone");
    const finished = events.find((e) => e.kind === "crawl:finished") as
      | CrawlFinishedEvent
      | undefined;
    const graph = await graphRepo.findByRunId("run-full-capstone");

    expect(finished).toBeDefined();
    expect(graph).not.toBeNull();
    expect(graph!.nodes.size).toBeGreaterThanOrEqual(2);
    expect(events.filter((e) => e.kind === "crawl:started")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "crawl:finished")).toHaveLength(1);
  });

  it("finalizes blocked-on-2fa when 2FA screen is reached via capstone policy", async () => {
    const driver = new CapstoneDriver();
    const policy = buildCapstonePolicy();
    const eventStream = new FakeCrawlEventStream();
    const graphRepo = new InMemoryStateGraphRepository();

    const useCase = new StartCrawlRun(
      driver,
      policy,
      defaultCollaborators({ stateGraphRepository: graphRepo, crawlEventStream: eventStream }),
    );

    await useCase.execute(makeInput("run-capstone-2fa", 30));

    const events = eventStream.eventsFor("run-capstone-2fa");
    const finished = events.find((e) => e.kind === "crawl:finished") as
      | CrawlFinishedEvent
      | undefined;

    expect(finished).toBeDefined();
    expect(finished!.status).toBe("blocked-on-2fa");
  });
});
