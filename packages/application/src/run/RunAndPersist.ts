/**
 * RunAndPersist — the E7.2 write-path orchestrator (#84, ADR-0008 §6).
 *
 * An application-layer Facade/Orchestrator that composes the EXISTING pieces —
 * `StartCrawlRun` (frozen constructor, composed via a structural seam, never
 * modified), the `CrawlEventStream` (the status channel: `execute()` returns
 * void, so the terminal `crawl:finished` / `crawl:error` event carries the
 * outcome), `BuildWorkflowMap`, and the three repository ports — so a real
 * crawl automatically leaves durable artifacts:
 *
 *   1. `runRepository.save` of `{ status:"running", finishedAt:null }` BEFORE
 *      the crawl — the run is discoverable by id mid-crawl (FR4 / ADR-0008 OQ2;
 *      the discoverability predicate is `finishedAt === null`).
 *   2. `startCrawlRun.execute(...)` — the graph persists INCREMENTALLY through
 *      the durable `stateGraphRepository` wired at the composition root.
 *   3. terminal `crawl:finished` ⇒ `buildWorkflowMap` → `assembleReport` (pure,
 *      "" artifactUri sentinel) → `reportRepository.save`, then the run is
 *      finalized with the EVENT's status + `finishedAt` (derived, not re-guessed).
 *   4. `crawl:error` (or nothing terminal) ⇒ finalize `status:"error"`, no report.
 *   5. a THROWN crawl or store save failure ⇒ best-effort finalize to
 *      `status:"error"` + `finishedAt`, then rethrow (M84.2/T6 — the run is
 *      recorded as failed, never silently lost). An uncatchable process kill
 *      leaves the step-1 `running`/`finishedAt:null` row — still discoverable.
 *
 * Security (e7 threat model):
 *   - T1/M84.1: this orchestrator only MOVES already-redacted aggregates between
 *     ports — it never re-derives raw text, never de-redacts, and never logs or
 *     echoes payload/graph/report content.
 *   - T7/M84.3: `WorkflowMap`/label strings pass through verbatim (raw + inert);
 *     E4 context-encodes on render.
 *
 * Port purity (NFR3): depends on domain ports + application seams only — no
 * adapter import (dependency-cruiser enforces the boundary).
 */
import type {
  CrawlEvent,
  CrawlEventStream,
  Platform,
  ReportRepository,
  Run,
  RunRepository,
  RunStatus,
  StateGraphRepository,
  WorkflowMap,
} from "@flowscout/domain";
import type { CrawlBudget } from "@flowscout/domain";
import type { StartCrawlRunInput } from "../crawl/StartCrawlRun.js";
import type { Clock } from "../semantic/BuildWorkflowMap.js";
import { assembleReport } from "./assembleReport.js";
import { defaultRunVersions } from "./versions.js";
import type { RunVersions } from "./versions.js";

/**
 * Structural seam over `StartCrawlRun` (its constructor is FROZEN — ADR-0004 /
 * ADR-0008 §6): the orchestrator composes it, never extends or modifies it.
 */
export interface CrawlExecutor {
  execute(input: StartCrawlRunInput): Promise<void>;
}

/** Structural seam over `BuildWorkflowMap` (composed, not modified). */
export interface WorkflowMapBuilder {
  execute(runId: string): Promise<WorkflowMap>;
}

/** Input to the orchestrator — the full budget travels onto the persisted `Run`. */
export interface RunAndPersistInput {
  /** Unique identifier for this crawl run. */
  readonly runId: string;
  /** Bundle ID / app identifier. */
  readonly appId: string;
  /** App version string. */
  readonly appVersion: string;
  /** Target platform. */
  readonly platform: Platform;
  /** Device/simulator UDID to drive. */
  readonly udid: string;
  /** Crawl budget — persisted on the Run; `maxSteps` feeds the crawl input. */
  readonly budget: CrawlBudget;
}

/** Outcome of a persisted run (terminal — the run row carries the same status). */
export interface RunAndPersistResult {
  readonly runId: string;
  readonly status: RunStatus;
}

/** Mutable holder for the terminal event status (avoids closed-over-let narrowing). */
interface TerminalOutcome {
  status: RunStatus | null;
}

export class RunAndPersist {
  constructor(
    private readonly runRepository: RunRepository,
    private readonly stateGraphRepository: StateGraphRepository,
    private readonly reportRepository: ReportRepository,
    private readonly crawlEventStream: CrawlEventStream,
    private readonly startCrawlRun: CrawlExecutor,
    private readonly buildWorkflowMap: WorkflowMapBuilder,
    private readonly versions: RunVersions = defaultRunVersions(),
    private readonly clock: Clock = () => new Date().toISOString(),
  ) {}

  async execute(input: RunAndPersistInput): Promise<RunAndPersistResult> {
    const run = this.buildInitialRun(input);
    // Step 1 (FR4): the run exists — discoverable by id — BEFORE the crawl starts.
    await this.runRepository.save(run);

    const terminal: TerminalOutcome = { status: null };
    const unsubscribe = this.crawlEventStream.subscribe(input.runId, (event) => {
      this.captureTerminal(terminal, event);
    });

    try {
      await this.startCrawlRun.execute(this.toCrawlInput(input));
      // No terminal event at all is abnormal — finalize defensively as "error".
      const status: RunStatus = terminal.status ?? "error";
      if (status !== "error") {
        await this.persistReport(run, status);
      }
      await this.runRepository.update(run.id, { status, finishedAt: this.clock() });
      return { runId: run.id, status };
    } catch (error) {
      // M84.2/T6: thrown crawl OR store save failure ⇒ recorded as a failed run,
      // never silently lost. Best-effort — if even this fails, the step-1
      // running/finishedAt:null row remains discoverable (ADR-0008 OQ2).
      await this.markErrored(run.id);
      throw error;
    } finally {
      unsubscribe();
    }
  }

  /** Records the terminal outcome from the event stream (the only status channel). */
  private captureTerminal(terminal: TerminalOutcome, event: CrawlEvent): void {
    if (event.kind === "crawl:finished") {
      terminal.status = event.status;
    } else if (event.kind === "crawl:error") {
      terminal.status = "error";
    }
  }

  /** Step 3: map → report ("" artifactUri sentinel) → save (idempotent upsert on runId). */
  private async persistReport(run: Run, status: RunStatus): Promise<void> {
    const workflowMap = await this.buildWorkflowMap.execute(run.id);
    const graph = await this.stateGraphRepository.findByRunId(run.id);
    const report = assembleReport({
      run,
      graph,
      workflowMap,
      runStatus: status,
      generatedAt: this.clock(),
    });
    await this.reportRepository.save(report);
  }

  /** Best-effort error finalization — never throws (the original error propagates). */
  private async markErrored(runId: string): Promise<void> {
    try {
      await this.runRepository.update(runId, { status: "error", finishedAt: this.clock() });
    } catch {
      // Swallow: the run stays "running"/finishedAt:null — still discoverable (FR4).
    }
  }

  private toCrawlInput(input: RunAndPersistInput): StartCrawlRunInput {
    return {
      runId: input.runId,
      appId: input.appId,
      appVersion: input.appVersion,
      platform: input.platform,
      udid: input.udid,
      maxSteps: input.budget.maxSteps,
    };
  }

  private buildInitialRun(input: RunAndPersistInput): Run {
    return {
      id: input.runId,
      appId: input.appId,
      appVersion: input.appVersion,
      platform: input.platform,
      budget: input.budget,
      status: "running",
      startedAt: this.clock(),
      finishedAt: null,
      driverVersion: this.versions.driverVersion,
      policyVersion: this.versions.policyVersion,
      schemaVersion: this.versions.schemaVersion,
    };
  }
}
