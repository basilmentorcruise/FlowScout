/**
 * LlmAdapter — stub implementing LlmPort (and a placeholder DecisionPolicy).
 *
 * TODO (E2/E3): Implement using the chosen LLM provider SDK (provider TBD per ADR-0001 R3).
 *               Wire the Chain of Responsibility policy here:
 *               CachedKnowledgePolicy → LLMPolicy (fallback).
 */
import type {
  LlmPort,
  LlmMessage,
  LlmCompletionOptions,
  LlmCompletionResult,
  DecisionPolicy,
  DecisionContext,
  PolicyDecision,
} from "@flowscout/domain";

function notImplemented(method: string): Promise<never> {
  return Promise.reject(
    new Error(`LlmAdapter.${method} is not yet implemented — see TODO (E2/E3) in LlmAdapter.ts`),
  );
}

/** LlmAdapter — stub for the LlmPort. Concrete provider chosen in E2/E3 per ADR-0001 R3. */
export class LlmAdapter implements LlmPort {
  complete(
    _messages: readonly LlmMessage[],
    _options: LlmCompletionOptions,
  ): Promise<LlmCompletionResult> {
    return notImplemented("complete");
  }
}

/**
 * LlmDecisionPolicy — stub implementing DecisionPolicy via the LlmPort.
 * TODO (E2/E3): Implement Chain of Responsibility: CachedKnowledgePolicy → LLMPolicy.
 */
export class LlmDecisionPolicy implements DecisionPolicy {
  constructor(private readonly llm: LlmPort) {}

  decide(_context: DecisionContext): Promise<PolicyDecision> {
    void this.llm; // wired for E2/E3 (CachedKnowledgePolicy → LLMPolicy); not yet used
    return notImplemented("decide");
  }
}
