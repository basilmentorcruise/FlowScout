/**
 * StartCrawlRun — the walking-skeleton crawl loop use-case.
 *
 * UNFROZEN by #37 (additive — per ADR-0004 §7.2 addendum recorded in E2.7-integration-plan.md):
 *   - candidateActions enumeration + population of DecisionContextWithCandidates (§2)
 *   - Redaction boundary applied before every sink (§3)
 *   - Truthful LLM usage fed to BudgetEnforcer via usageReporter (§4)
 *   - 2FA/credential boundary detection before decide() (§5)
 *   - No-production guard + reset-safety-net in execute() (§6)
 *   - Duplicate-path detection at finalize (§7)
 *
 * Public constructor signature is UNCHANGED: `new StartCrawlRun(driver, policy, collaborators)`.
 * `defaultCollaborators({ stateGraphRepository, crawlEventStream })` is UNCHANGED.
 *
 * Loop flow:
 *   1. Emit crawl:started; initialise StateGraph
 *   2. No-production guard + reset-safety-net (NEW in #37)
 *   3. runLoop: observe → REDACT → identify → record → budget-check →
 *               2FA detect (NEW) → enumerate candidates (NEW) → decide → act → repeat
 *   4. Duplicate-path detection (NEW in #37)
 *   5. Emit crawl:finished
 *
 * Security invariants:
 *   - Redaction applied BEFORE any sink (T3/T7/T8).
 *   - 2FA detection on redacted snapshot, stops BEFORE decide (T8).
 *   - No-production guard refuses production targets (T4).
 *   - Reset-safety-net aborts if snapshot cannot be established (T4).
 *   - Truthful LLM usage fed via usageReporter closure (T6).
 *
 * Port-only: no imports from adapters/*, MCP SDK, or LLM SDK (T10/NFR1).
 * Dependency-cruiser enforces this boundary.
 */
import type {
  MobileDriverPort,
  DecisionPolicy,
  Platform,
  StateGraph,
  StateNode,
  StateEdge,
  StateIdentity,
  A11ySnapshot,
  SwipeDirection,
  CrawlStartedEvent,
  StateDiscoveredEvent,
  ActionTakenEvent,
  StateTransitionEvent,
  CrawlFinishedEvent,
  CrawlErrorEvent,
  CandidateAction,
  PolicyDecision,
} from "@flowscout/domain";
import type { CrawlCollaborators, BudgetContext } from "./collaborators.js";
import type { DecisionContextWithCandidates } from "./policy/CachedKnowledgePolicy.js";

/** Input to the StartCrawlRun use-case. */
export interface StartCrawlRunInput {
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
  /**
   * Maximum crawl steps for this run.
   * No magic number: supplied by the caller from CrawlBudget config.
   * #33 added the full CrawlBudget (LLM-call cap, token cap, revisit cap).
   */
  readonly maxSteps: number;
}

/** Label prefix length for state node labels derived from identity strings. */
const STATE_LABEL_PREFIX_LEN = 8;

/** Snapshot name used for the reset-safety-net (T4). */
const SAFETY_NET_SNAPSHOT_NAME = "flowscout-safety-net";

/** Mutable loop state threaded through each step. */
interface LoopState {
  runId: string;
  platform: Platform;
  udid: string;
  maxSteps: number;
  stepCount: number;
  termination: "completed" | "partial" | "blocked-on-2fa";
  running: boolean;
  /** Accumulated LLM call count (truthful, feeds BudgetEnforcer). */
  llmCallCount: number;
  /** Accumulated LLM token count (truthful, feeds BudgetEnforcer). */
  tokenCount: number;
}

/**
 * StartCrawlRun — orchestrates the autonomous crawl loop.
 *
 * SOLID/DI: all evolving behaviour is injected via CrawlCollaborators.
 * Constructor signature is UNCHANGED (backward-compatible with #31 tests).
 */
export class StartCrawlRun {
  constructor(
    private readonly driver: MobileDriverPort,
    private readonly policy: DecisionPolicy,
    private readonly collaborators: CrawlCollaborators,
  ) {}

  async execute(input: StartCrawlRunInput): Promise<void> {
    const { runId, appId, appVersion, platform, udid, maxSteps } = input;
    const { stateGraphRepository, crawlEventStream, runSafety, simulatorLifecycle } =
      this.collaborators;

    // ── §6: No-production guard (T4 mitigation 2) ────────────────────────────
    if (runSafety !== undefined && !runSafety.nonProduction) {
      const errorEvent: CrawlErrorEvent = {
        kind: "crawl:error",
        runId,
        message: "Crawl aborted: target is not marked as non-production (T4 guard).",
        timestamp: nowIso(),
      };
      await crawlEventStream.publish(errorEvent);
      return;
    }

    // ── §6: Reset-safety-net (T4 mitigation 1) ───────────────────────────────
    if (simulatorLifecycle !== undefined) {
      try {
        await simulatorLifecycle.takeSnapshot(udid, SAFETY_NET_SNAPSHOT_NAME);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown error";
        const errorEvent: CrawlErrorEvent = {
          kind: "crawl:error",
          runId,
          message: `Crawl aborted: could not establish reset-safety-net snapshot: ${msg.slice(0, 80)}`,
          timestamp: nowIso(),
        };
        await crawlEventStream.publish(errorEvent);
        return;
      }
    }

    await crawlEventStream.publish(this.buildStartedEvent(runId, appId, appVersion));
    await stateGraphRepository.saveGraph(
      this.buildInitialGraph(runId, appId, appVersion, platform),
    );

    const loopState: LoopState = {
      runId,
      platform,
      udid,
      maxSteps,
      stepCount: 0,
      termination: "partial",
      running: true,
      llmCallCount: 0,
      tokenCount: 0,
    };
    await this.runLoop(loopState);

    // ── §7: Duplicate-path detection at finalize ──────────────────────────────
    const graph = await stateGraphRepository.findByRunId(runId);
    if (graph !== null) {
      const { duplicatePathDetector } = this.collaborators;
      const dupIds = duplicatePathDetector.detect(graph);
      // Persist the updated graph with duplicatePathNodeIds populated
      const updatedGraph: StateGraph = {
        ...graph,
        duplicatePathNodeIds: dupIds,
      };
      await stateGraphRepository.saveGraph(updatedGraph);
    }

    const finalGraph = await stateGraphRepository.findByRunId(runId);
    await crawlEventStream.publish(
      this.buildFinishedEvent(runId, finalGraph?.nodes.size ?? 0, loopState),
    );
  }

  private async runLoop(ls: LoopState): Promise<void> {
    const {
      identifyState,
      budgetEnforcer,
      frontier,
      redactor,
      enumerateBaseCandidates,
      usageReporter,
    } = this.collaborators;

    while (ls.running) {
      // ── Observe + REDACT (TB-A: single boundary before any sink, T3/T7/T8) ─
      const rawSnapshot = await this.driver.snapshotAccessibilityTree(ls.udid);
      const safeSnapshot = redactor.redact(rawSnapshot);

      const stateId = identifyState(safeSnapshot);

      await this.recordStateIfNew(ls.runId, ls.platform, stateId, safeSnapshot);
      frontier.markVisited(stateId);
      const visitCount = frontier.getVisitCount(stateId);

      const budgetCtx = this.buildBudgetCtx(ls, stateId, visitCount);
      if (budgetEnforcer.shouldStop(budgetCtx)) {
        ls.termination = "partial";
        ls.running = false;
        continue;
      }

      // ── §5: 2FA/credential boundary detection (T8) ────────────────────────
      if (await this.checkCredentialBoundary(ls, stateId, safeSnapshot)) {
        continue;
      }

      // ── §2: Enumerate candidates + populate DecisionContextWithCandidates ─
      const baseCandidates = enumerateBaseCandidates(safeSnapshot);
      const probeCandidates = await frontier.getEnumeratedCandidates(stateId, safeSnapshot);

      // Merge + deduplicate base + probe candidates
      const mergedCandidates = mergeCandidates(baseCandidates, probeCandidates);

      // Build the additive DecisionContextWithCandidates (DecisionContext is frozen)
      const context: DecisionContextWithCandidates = {
        runId: ls.runId,
        currentStateId: stateId,
        a11ySnapshot: safeSnapshot,
        triedActions: frontier.getTriedActions(stateId),
        visitCount,
        candidateActions: mergedCandidates,
      };

      const decision = await this.policy.decide(context);

      // ── §4: Feed truthful LLM usage into BudgetEnforcer (T6) ──────────────
      if (decision.kind === "act" && decision.usedLlm) {
        ls.llmCallCount++;
        const usage = usageReporter.lastCall();
        if (usage !== null) {
          ls.tokenCount += usage.promptTokens + usage.completionTokens;
        }
      }

      const keepGoing = await this.handleDecision(ls, decision, stateId, budgetCtx);
      if (!keepGoing) ls.running = false;
    }
  }

  /**
   * Checks for credential/2FA surfaces. If detected, emits event and stops the loop.
   * Returns true if a boundary was detected (caller should `continue`), false otherwise.
   */
  private async checkCredentialBoundary(
    ls: LoopState,
    stateId: StateIdentity,
    safeSnapshot: A11ySnapshot,
  ): Promise<boolean> {
    const { credentialBoundary, crawlEventStream } = this.collaborators;
    const result = credentialBoundary.detect(safeSnapshot);
    if (!result.isCredentialSurface) return false;

    await crawlEventStream.publish({
      kind: "credential:prompt",
      runId: ls.runId,
      promptType: result.promptType,
      stateId,
      message: "Credential surface detected — redacted: no actual credential values here.",
      timestamp: nowIso(),
    });
    ls.termination = "blocked-on-2fa";
    ls.running = false;
    return true;
  }

  private async handleDecision(
    ls: LoopState,
    decision: PolicyDecision,
    stateId: StateIdentity,
    budgetCtx: BudgetContext,
  ): Promise<boolean> {
    if (decision.kind === "done") {
      ls.termination = "completed";
      return false;
    }
    if (decision.kind === "backtrack") {
      ls.termination = "completed";
      return false;
    }

    const { action } = decision;
    const { frontier, budgetEnforcer, crawlEventStream } = this.collaborators;

    // Redact action payload before recording in event (T7/T8)
    const redactedAction = this.redactAction(action);

    await crawlEventStream.publish(
      this.buildActionTakenEvent(ls.runId, stateId, redactedAction, decision),
    );
    // Execute with REAL action (driver needs real text); record redacted form
    await this.executeAction(ls.udid, action);
    frontier.markActionTried(stateId, action);
    budgetEnforcer.recordStep(budgetCtx);
    ls.stepCount++;

    await this.recordTransition(ls.runId, ls.udid, stateId, redactedAction, ls.stepCount);
    return true;
  }

  /**
   * Returns a copy of the action with redacted payload (for recording in events/edges).
   * The original action is used for driver execution; only the recorded form is masked.
   */
  private redactAction(action: CandidateAction): CandidateAction {
    if (action.actionType !== "typeText") return action;

    const { redactor } = this.collaborators;
    const p = safeParseJson(action.actionPayload);
    if (p && typeof p === "object" && "text" in p && typeof p.text === "string") {
      const redactedText = redactor.redactText(p.text);
      if (redactedText !== p.text) {
        return {
          ...action,
          actionPayload: JSON.stringify({ ...p, text: redactedText }),
        };
      }
    }
    return action;
  }

  private buildBudgetCtx(ls: LoopState, stateId: StateIdentity, visitCount: number): BudgetContext {
    return {
      stepCount: ls.stepCount,
      maxSteps: ls.maxSteps,
      llmCallCount: ls.llmCallCount, // truthful: accumulated in runLoop (§4)
      tokenCount: ls.tokenCount, // truthful: accumulated in runLoop (§4)
      currentStateId: stateId,
      visitCount,
    };
  }

  private async recordStateIfNew(
    runId: string,
    platform: Platform,
    stateId: StateIdentity,
    safeSnapshot: string, // already redacted (T3/T7)
  ): Promise<void> {
    const { stateGraphRepository, crawlEventStream } = this.collaborators;
    const existing = await stateGraphRepository.findByRunId(runId);
    if (existing?.nodes.has(stateId)) return;

    const node: StateNode = {
      id: stateId,
      label: `state-${stateId.slice(0, STATE_LABEL_PREFIX_LEN)}`,
      platform,
      firstSeenAt: nowIso(),
      a11ySnapshot: safeSnapshot, // redacted snapshot stored (T7)
      screenshotUri: null,
    };
    await stateGraphRepository.upsertNode(runId, node);
    await crawlEventStream.publish(this.buildDiscoveredEvent(runId, stateId, node.label));
  }

  private async recordTransition(
    runId: string,
    udid: string,
    stateId: StateIdentity,
    redactedAction: CandidateAction, // already redacted action payload (T7)
    stepCount: number,
  ): Promise<void> {
    const { identifyState, stateGraphRepository, crawlEventStream, redactor } = this.collaborators;
    const rawPostSnapshot = await this.driver.snapshotAccessibilityTree(udid);
    const safePostSnapshot = redactor.redact(rawPostSnapshot);
    const toStateId = identifyState(safePostSnapshot);

    const edge: StateEdge = {
      id: `${stateId}:${redactedAction.actionType}:${String(stepCount)}`,
      fromId: stateId,
      toId: toStateId,
      actionType: redactedAction.actionType,
      actionPayload: redactedAction.actionPayload, // redacted (T7)
      observedAt: nowIso(),
    };
    await stateGraphRepository.appendEdge(runId, edge);
    await crawlEventStream.publish(this.buildTransitionEvent(runId, stateId, toStateId));
  }

  /**
   * Dispatches a driver action. Security (T2): actionType is restricted to the
   * domain's ActionType union — no free-form eval of payloads.
   */
  private executeAction(udid: string, action: CandidateAction): Promise<void> {
    switch (action.actionType) {
      case "tap":
        return this.executeTap(udid, action.actionPayload);
      case "typeText":
        return this.executeTypeText(udid, action.actionPayload);
      case "swipe":
        return this.executeSwipe(udid, action.actionPayload);
      case "scroll":
      case "gesture":
      case "navigate":
        return Promise.resolve(); // degraded no-op; #35 fills in probe handling
      default: {
        const _x: never = action.actionType;
        void _x;
        return Promise.resolve();
      }
    }
  }

  private async executeTap(udid: string, actionPayload: string): Promise<void> {
    const p = safeParseJson(actionPayload);
    if (!p || typeof p !== "object") return;
    if ("elementId" in p && typeof p.elementId === "string") {
      await this.driver.tap(udid, { kind: "element", elementId: p.elementId });
    } else if ("x" in p && "y" in p && typeof p.x === "number" && typeof p.y === "number") {
      await this.driver.tap(udid, { kind: "coordinate", x: p.x, y: p.y });
    }
  }

  private async executeTypeText(udid: string, actionPayload: string): Promise<void> {
    const p = safeParseJson(actionPayload);
    if (p && typeof p === "object" && "text" in p && typeof p.text === "string") {
      // Type the REAL text into the driver (app needs it); payload is recorded redacted (T7)
      await this.driver.typeText(udid, p.text);
    }
  }

  private async executeSwipe(udid: string, actionPayload: string): Promise<void> {
    const p = safeParseJson(actionPayload);
    if (p && typeof p === "object" && "direction" in p) {
      const direction = p.direction as SwipeDirection;
      const distance = "distance" in p && typeof p.distance === "number" ? p.distance : undefined;
      await this.driver.swipe(udid, direction, distance);
    }
  }

  // ── Event builders (pure) ───────────────────────────────────────────────────

  private buildStartedEvent(runId: string, appId: string, appVersion: string): CrawlStartedEvent {
    return { kind: "crawl:started", runId, appId, appVersion, timestamp: nowIso() };
  }

  private buildInitialGraph(
    runId: string,
    appId: string,
    appVersion: string,
    platform: Platform,
  ): StateGraph {
    return {
      runId,
      appId,
      appVersion,
      platform,
      nodes: new Map(),
      edges: [],
      duplicatePathNodeIds: new Set(),
    };
  }

  private buildDiscoveredEvent(
    runId: string,
    stateId: StateIdentity,
    label: string,
  ): StateDiscoveredEvent {
    return { kind: "state:discovered", runId, stateId, label, timestamp: nowIso() };
  }

  private buildActionTakenEvent(
    runId: string,
    fromStateId: StateIdentity,
    action: CandidateAction,
    decision: PolicyDecision,
  ): ActionTakenEvent {
    return { kind: "action:taken", runId, fromStateId, action, decision, timestamp: nowIso() };
  }

  private buildTransitionEvent(
    runId: string,
    fromStateId: StateIdentity,
    toStateId: StateIdentity,
  ): StateTransitionEvent {
    return { kind: "state:transition", runId, fromStateId, toStateId, timestamp: nowIso() };
  }

  private buildFinishedEvent(
    runId: string,
    totalStates: number,
    ls: LoopState,
  ): CrawlFinishedEvent {
    return {
      kind: "crawl:finished",
      runId,
      totalStates,
      totalSteps: ls.stepCount,
      status: ls.termination,
      timestamp: nowIso(),
    };
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Safe JSON parse — never throws; returns null on failure.
 * Prevents crashes on malformed payloads (T2 safe fallback).
 */
function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * Merges base and probe candidates, deduplicating by (actionType, actionPayload) key.
 * Base candidates appear first; probe candidates are appended if not already present.
 */
function mergeCandidates(
  base: readonly CandidateAction[],
  probes: readonly CandidateAction[],
): readonly CandidateAction[] {
  const seen = new Set<string>();
  const merged: CandidateAction[] = [];

  for (const c of [...base, ...probes]) {
    const key = `${c.actionType}::${c.actionPayload}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(c);
    }
  }

  return merged;
}
