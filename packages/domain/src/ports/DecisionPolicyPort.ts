/**
 * DecisionPolicyPort — the port through which the crawl engine asks "what to do next".
 *
 * Layered/chained via Chain of Responsibility in the application layer:
 *   1. CachedKnowledgePolicy (LLM-less, uses accumulated state knowledge)
 *   2. LLMPolicy (fallback when cache cannot decide)
 *
 * Neither the engine nor the domain knows whether an LLM was consulted.
 */
import type { A11ySnapshot } from "./MobileDriverPort.js";
import type { StateIdentity } from "../models/state-graph.js";
import type { ActionType } from "../models/state-graph.js";

/** A single candidate action the policy can recommend. */
export interface CandidateAction {
  readonly actionType: ActionType;
  /** Serialised payload (e.g. coordinates, element ID, text). */
  readonly actionPayload: string;
  /** Human-readable explanation (for telemetry / report). */
  readonly rationale: string;
}

/** Context passed to the decision policy for each step. */
export interface DecisionContext {
  readonly runId: string;
  readonly currentStateId: StateIdentity;
  readonly a11ySnapshot: A11ySnapshot;
  /** Action types already tried from this state. */
  readonly triedActions: readonly CandidateAction[];
  /** Number of times this state has been visited in this run. */
  readonly visitCount: number;
}

/** The policy's decision for one crawl step. */
export type PolicyDecision =
  | { readonly kind: "act"; readonly action: CandidateAction; readonly usedLlm: boolean }
  | { readonly kind: "backtrack"; readonly reason: string }
  | { readonly kind: "done"; readonly reason: string };

/**
 * DecisionPolicy — consulted by the crawl engine every step.
 * Implementations are composable (Chain of Responsibility).
 */
export interface DecisionPolicy {
  decide(context: DecisionContext): Promise<PolicyDecision>;
}

/**
 * LLMPort — the raw LLM interaction port (used only by the LLM policy adapter).
 * Isolated here so cost telemetry and provider-switching happen in one place.
 */
export interface LlmMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
}

export interface LlmCompletionOptions {
  readonly maxTokens: number;
  readonly temperature?: number;
}

export interface LlmCompletionResult {
  readonly content: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly modelId: string;
}

export interface LlmPort {
  complete(
    messages: readonly LlmMessage[],
    options: LlmCompletionOptions,
  ): Promise<LlmCompletionResult>;
}
