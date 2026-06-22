/**
 * CrawlEventStream — the port through which the crawl engine publishes events.
 * The API adapter subscribes and relays them to SSE clients.
 * Modelling live crawl observation + 2FA-pause flow as first-class events.
 */
import type { StateIdentity } from "../models/state-graph.js";
import type { CandidateAction, PolicyDecision } from "./DecisionPolicyPort.js";

/** Discriminated union of all crawl events. */
export type CrawlEvent =
  | CrawlStartedEvent
  | StateDiscoveredEvent
  | ActionTakenEvent
  | StateTransitionEvent
  | CredentialPromptEvent
  | BudgetWarningEvent
  | CrawlFinishedEvent
  | CrawlErrorEvent;

export interface CrawlStartedEvent {
  readonly kind: "crawl:started";
  readonly runId: string;
  readonly appId: string;
  readonly appVersion: string;
  readonly timestamp: string; // ISO-8601
}

export interface StateDiscoveredEvent {
  readonly kind: "state:discovered";
  readonly runId: string;
  readonly stateId: StateIdentity;
  readonly label: string;
  readonly timestamp: string;
}

export interface ActionTakenEvent {
  readonly kind: "action:taken";
  readonly runId: string;
  readonly fromStateId: StateIdentity;
  readonly action: CandidateAction;
  readonly decision: PolicyDecision;
  readonly timestamp: string;
}

export interface StateTransitionEvent {
  readonly kind: "state:transition";
  readonly runId: string;
  readonly fromStateId: StateIdentity;
  readonly toStateId: StateIdentity;
  readonly timestamp: string;
}

/**
 * CredentialPromptEvent — emitted when the crawl hits a 2FA surface.
 * The engine transitions to `blocked-on-2FA` and awaits operator input.
 */
export interface CredentialPromptEvent {
  readonly kind: "credential:prompt";
  readonly runId: string;
  readonly promptType: "2fa-otp" | "password" | "username";
  readonly stateId: StateIdentity;
  readonly message: string; // redacted: no actual credential values here
  readonly timestamp: string;
}

export interface BudgetWarningEvent {
  readonly kind: "budget:warning";
  readonly runId: string;
  /**
   * Which budget dimension is nearing exhaustion.
   * - "steps"    — approaching maxSteps cap.
   * - "llm-calls"— approaching maxLlmCalls cap.
   * - "tokens"   — approaching maxTokens cap.
   * - "revisits" — a state has been visited near its maxRevisitsPerState limit.
   * - "plateau"  — steps-since-new-state is nearing the plateauWindow limit.
   *
   * "revisits" and "plateau" added by #33 (ADR-0004 §8).
   */
  readonly budgetType: "steps" | "llm-calls" | "tokens" | "revisits" | "plateau";
  readonly used: number;
  readonly limit: number;
  readonly timestamp: string;
}

export interface CrawlFinishedEvent {
  readonly kind: "crawl:finished";
  readonly runId: string;
  readonly totalStates: number;
  readonly totalSteps: number;
  readonly status: "completed" | "partial" | "blocked-on-2fa" | "error";
  readonly timestamp: string;
}

export interface CrawlErrorEvent {
  readonly kind: "crawl:error";
  readonly runId: string;
  readonly message: string; // redacted: no secrets
  readonly timestamp: string;
}

/** CrawlEventStream port — publish events from the engine; subscribe in the API adapter. */
export interface CrawlEventStream {
  publish(event: CrawlEvent): Promise<void>;
  subscribe(runId: string, handler: (event: CrawlEvent) => void): () => void;
}
