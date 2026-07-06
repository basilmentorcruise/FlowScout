/**
 * E7.2 seeded-secret clean gate (#84, M84.1/T1 — the NFR4 AC made concrete) +
 * write-path lifecycle evidence over the REAL pipeline:
 *
 *   real StartCrawlRun (real CredentialRedactor at TB-A, real boundary detector)
 *     → durable Sqlite* repositories (in-memory SQLite, same codec/guard path)
 *     → RunAndPersist (via wireRunPersistence) → real BuildWorkflowMap (stub
 *       LLM/embedding ports — no network).
 *
 * The driver is scripted to render the E3 seeded-secret markers on screen
 * (secure-field credential value + OTP-shaped value). The assertions RELOAD the
 * persisted StateGraph and Report from the store and prove:
 *   - neither aggregate contains the credential or the OTP value,
 *   - the upstream `[REDACTED]` marker IS present where a value was masked,
 *   - persistence added no new secret sink (the store's save-time guard stayed quiet),
 *   - the run is finalized with the event-derived terminal status + finishedAt.
 *
 * The markers are CONSTRUCTED AT RUNTIME from parts — no secret-shaped literal
 * exists in this source for gitleaks to flag.
 */
import { describe, it, expect } from "vitest";
import { StartCrawlRun, defaultCollaborators, REDACTED_MARKER } from "@flowscout/application";
import type {
  A11ySnapshot,
  CrawlEvent,
  CrawlEventStream,
  DecisionPolicy,
  DeviceInfo,
  MobileDriverPort,
  PolicyDecision,
  Report,
  ScreenshotBytes,
  StateGraph,
} from "@flowscout/domain";
import { defaultCrawlBudget } from "@flowscout/domain";
import {
  openDatabase,
  SqliteRunRepository,
  SqliteStateGraphRepository,
  SqliteReportRepository,
} from "@flowscout/adapter-persistence";
import type {
  EmbeddingInput,
  EmbeddingPort,
  EmbeddingResult,
  LlmCompletionResult,
  LlmPort,
} from "@flowscout/domain";
import { wireBuildWorkflowMap } from "../composition-root/wire.js";
import { wireRunPersistence } from "../composition-root/wireRunPersistence.js";

// ── Seeded-secret markers (runtime-constructed — never literals; T1/M84.1) ───

/** E3 credential marker: a secure-field value that must NEVER reach the store. */
const SEEDED_SECRET = ["hunter2", "SECRET"].join("-");
/** E3 OTP marker: an OTP-shaped value that must NEVER reach the store. */
const SEEDED_OTP = ["482", "913"].join("");

// ── Scripted, port-typed fakes (no simulator, no network) ────────────────────

class ScriptedDriver implements MobileDriverPort {
  readonly typedTexts: string[] = [];
  private index = 0;

  constructor(private readonly snapshots: readonly string[]) {}

  listDevices(): Promise<readonly DeviceInfo[]> {
    return Promise.resolve([]);
  }

  snapshotAccessibilityTree(_udid: string): Promise<A11ySnapshot> {
    const i = Math.min(this.index, this.snapshots.length - 1);
    this.index++;
    return Promise.resolve(this.snapshots[i] as A11ySnapshot);
  }

  screenshot(_udid: string): Promise<ScreenshotBytes> {
    return Promise.resolve(new Uint8Array());
  }

  tap(): Promise<void> {
    return Promise.resolve();
  }

  typeText(_udid: string, text: string): Promise<void> {
    // The driver receives the REAL text (the app needs it); only recorded forms are masked.
    this.typedTexts.push(text);
    return Promise.resolve();
  }

  swipe(): Promise<void> {
    return Promise.resolve();
  }
}

/** Types an OTP-shaped value once, then finishes — deterministic, LLM-free. */
class ScriptedPolicy implements DecisionPolicy {
  private step = 0;

  decide(): Promise<PolicyDecision> {
    this.step++;
    if (this.step === 1) {
      return Promise.resolve({
        kind: "act",
        action: {
          actionType: "typeText",
          actionPayload: JSON.stringify({ text: SEEDED_OTP }),
          rationale: "enter the one-time value",
        },
        usedLlm: false,
      });
    }
    return Promise.resolve({ kind: "done", reason: "exploration complete" });
  }
}

class InProcessStream implements CrawlEventStream {
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

class StubLlmPort implements LlmPort {
  complete(): Promise<LlmCompletionResult> {
    return Promise.resolve({
      content: '{"appPurpose":"A demo app"}',
      promptTokens: 10,
      completionTokens: 4,
      modelId: "stub",
    });
  }
}

class StubEmbeddingPort implements EmbeddingPort {
  embed(_input: EmbeddingInput): Promise<EmbeddingResult> {
    return Promise.resolve({
      vector: new Array<number>(256).fill(1),
      modelId: "stub-embedding",
      promptTokens: 1,
    });
  }
}

// ── Scripted screens (secret material rendered RAW by the fake app) ──────────

function statusScreenWithOtp(): string {
  return JSON.stringify({
    role: "application",
    screen: "status",
    children: [
      { role: "staticText", label: "Status", value: SEEDED_OTP },
      { role: "button", label: "Continue" },
    ],
  });
}

function doneScreen(): string {
  return JSON.stringify({
    role: "application",
    screen: "done",
    children: [{ role: "staticText", label: "All set", value: "ok" }],
  });
}

function loginScreenWithCredential(): string {
  return JSON.stringify({
    role: "application",
    screen: "login",
    children: [
      { role: "secureTextField", label: "Password", value: SEEDED_SECRET },
      { role: "button", label: "Sign in" },
    ],
  });
}

// ── Harness: full write path over in-memory SQLite ────────────────────────────

function makeHarness(driver: MobileDriverPort, policy: DecisionPolicy) {
  const db = openDatabase(":memory:");
  const runRepository = new SqliteRunRepository(db);
  const stateGraphRepository = new SqliteStateGraphRepository(db);
  const reportRepository = new SqliteReportRepository(db);
  const crawlEventStream = new InProcessStream();

  const startCrawlRun = new StartCrawlRun(
    driver,
    policy,
    defaultCollaborators({ stateGraphRepository, crawlEventStream }),
  );
  const buildWorkflowMap = wireBuildWorkflowMap({
    stateGraphRepository,
    llm: new StubLlmPort(),
    embeddings: new StubEmbeddingPort(),
    crawlBudget: defaultCrawlBudget(),
  });

  const orchestrator = wireRunPersistence({
    runRepository,
    stateGraphRepository,
    reportRepository,
    crawlEventStream,
    startCrawlRun,
    buildWorkflowMap,
  });

  return { db, runRepository, stateGraphRepository, reportRepository, orchestrator };
}

function runInput(runId: string) {
  return {
    runId,
    appId: "com.example.seeded",
    appVersion: "1.0.0",
    platform: "ios" as const,
    udid: "SIM-UDID-TEST",
    budget: defaultCrawlBudget(),
  };
}

/** Serialize a reloaded aggregate for whole-payload marker scans. */
function stringifyGraph(graph: StateGraph): string {
  return JSON.stringify({ nodes: [...graph.nodes.values()], edges: graph.edges });
}

function stringifyReport(report: Report): string {
  return JSON.stringify(report);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("M84.1/T1 — seeded-secret clean gate through the real write path", () => {
  it("a completed crawl persists NO OTP/typed secret; [REDACTED] survives into the store", async () => {
    const runId = "run-seeded-otp";
    const driver = new ScriptedDriver([
      statusScreenWithOtp(), // iteration 1: observe (raw OTP on screen)
      doneScreen(), // post-action transition snapshot
      doneScreen(), // iteration 2: observe → policy says done
    ]);
    const h = makeHarness(driver, new ScriptedPolicy());

    const result = await h.orchestrator.execute(runInput(runId));
    expect(result.status).toBe("completed");

    // Reload BOTH aggregates from the store (row → codec decode — the persisted form).
    const graph = await h.stateGraphRepository.findByRunId(runId);
    const report = await h.reportRepository.findByRunId(runId);
    expect(graph).not.toBeNull();
    expect(report).not.toBeNull();
    if (graph === null || report === null) return;

    const graphText = stringifyGraph(graph);
    const reportText = stringifyReport(report);
    // The OTP value never reaches the store — neither on nodes nor on the typed edge.
    expect(graphText).not.toContain(SEEDED_OTP);
    expect(reportText).not.toContain(SEEDED_OTP);
    expect(graphText).not.toContain(SEEDED_SECRET);
    expect(reportText).not.toContain(SEEDED_SECRET);
    // Upstream redaction happened (not silent dropping): the marker is present…
    expect(graphText).toContain(REDACTED_MARKER);
    // …on the recorded typeText edge payload too (T7 boundary held for actions).
    const typedEdge = graph.edges.find((e) => e.actionType === "typeText");
    expect(typedEdge?.actionPayload).toContain(REDACTED_MARKER);
    // The driver still received the REAL text (redaction is record-side only).
    expect(driver.typedTexts).toEqual([SEEDED_OTP]);

    // Lifecycle: run finalized from the crawl:finished event + finishedAt set (FR4).
    const run = await h.runRepository.findById(runId);
    expect(run?.status).toBe("completed");
    expect(typeof run?.finishedAt).toBe("string");
    expect(report.metadata.runId).toBe(runId);
    expect(report.metadata.artifactUri).toBe("");
  });

  it("a credential surface (secure field) persists [REDACTED], never the credential", async () => {
    const runId = "run-seeded-credential";
    const driver = new ScriptedDriver([loginScreenWithCredential()]);
    const h = makeHarness(driver, new ScriptedPolicy());

    // The 2FA boundary stops the crawl BEFORE decide() — a non-error terminal.
    const result = await h.orchestrator.execute(runInput(runId));
    expect(result.status).toBe("blocked-on-2fa");

    const graph = await h.stateGraphRepository.findByRunId(runId);
    const report = await h.reportRepository.findByRunId(runId);
    expect(graph).not.toBeNull();
    expect(report).not.toBeNull();
    if (graph === null || report === null) return;

    const graphText = stringifyGraph(graph);
    // The credential value is absent; the masked secure field carries the marker.
    expect(graphText).not.toContain(SEEDED_SECRET);
    expect(graphText).toContain(REDACTED_MARKER);
    expect(stringifyReport(report)).not.toContain(SEEDED_SECRET);

    const run = await h.runRepository.findById(runId);
    expect(run?.status).toBe("blocked-on-2fa");
    expect(typeof run?.finishedAt).toBe("string");
  });
});
