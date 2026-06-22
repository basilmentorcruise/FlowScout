/**
 * PolicyChain — the assembled Chain of Responsibility (CachedKnowledge → LLM).
 *
 * Wraps both policies behind the DecisionPolicy port interface.
 * The composition root (#37) assembles the chain:
 *
 *   const cache = new InMemoryDecisionCache();
 *   const llmAdapter = new LlmAdapter(createAnthropicClient(), { modelId });
 *   const llmPolicy = new LLMPolicy(llmAdapter, cache);
 *   const cachedPolicy = new CachedKnowledgePolicy(llmPolicy);  // from application
 *   const chain = new PolicyChain(cachedPolicy, llmPolicy);     // from adapters/llm
 *
 * Why this split:
 *   - CachedKnowledgePolicy is pure application logic (no SDK) → lives in application.
 *   - LLMPolicy + PolicyChain touch LlmPort (SDK-adjacent) → live in adapters/llm.
 *   - PolicyChain does NOT import from application; it receives the assembled chain head.
 *   - This avoids an adapters→application package dependency (clean hexagonal layering).
 *
 * Usage reporting (#37 wiring):
 *   After each `decide()` call, read `chain.llmPolicy.lastCallResult` to get token counts
 *   and feed them into the BudgetEnforcer.
 *
 * SDK note: PolicyChain imports nothing from @anthropic-ai/sdk — SDK is confined to
 * LlmAdapter.ts only (T10/NFR1 — dependency-cruiser enforces).
 */
import type { DecisionPolicy, DecisionContext, PolicyDecision, LlmPort } from "@flowscout/domain";
import type { DecisionCachePort } from "@flowscout/domain";
import { LLMPolicy } from "./LLMPolicy.js";

/**
 * PolicyChain — implements DecisionPolicy as a drop-in for the composition root.
 *
 * Receives the pre-assembled chain head (CachedKnowledgePolicy wrapping LLMPolicy)
 * and exposes `llmPolicy` so the composition root can read token usage.
 */
export class PolicyChain implements DecisionPolicy {
  /** Exposed for #37 to read token usage after each decide() call. */
  readonly llmPolicy: LLMPolicy;

  /**
   * @param chainHead   The first policy in the chain (CachedKnowledgePolicy).
   *                    Assembled by the composition root; not constructed here to avoid
   *                    an adapters→application package import.
   * @param llmPolicy   The LLMPolicy instance (for usage reporting access).
   */
  constructor(
    private readonly chainHead: DecisionPolicy,
    llmPolicy: LLMPolicy,
  ) {
    this.llmPolicy = llmPolicy;
  }

  async decide(context: DecisionContext): Promise<PolicyDecision> {
    return this.chainHead.decide(context);
  }
}

/**
 * Factory: creates a PolicyChain given ports (the composition root calls this after
 * constructing CachedKnowledgePolicy separately — see comment above).
 *
 * #37 must:
 *   1. Construct a LlmAdapter (with the real Anthropic client from env).
 *   2. Construct an InMemoryDecisionCache (or persistent for E7).
 *   3. Build an LLMPolicy: `const llmPolicy = new LLMPolicy(adapter, cache)`.
 *   4. Build a CachedKnowledgePolicy (from @flowscout/application):
 *      `const cachedKnowledge = new CachedKnowledgePolicy(llmPolicy)`.
 *   5. Call `createPolicyChain(cachedKnowledge, llmPolicy)`.
 *   6. Inject the returned chain as DecisionPolicy into StartCrawlRun.
 *   7. After each crawl step: read `chain.llmPolicy.lastCallResult` for budget updates.
 */
export function createPolicyChain(
  chainHead: DecisionPolicy,
  llmPolicy: LLMPolicy,
): PolicyChain {
  return new PolicyChain(chainHead, llmPolicy);
}

/**
 * Convenience factory for tests — assembles LLMPolicy internally given ports.
 * The actual CachedKnowledgePolicy must be provided by the caller (it lives in application).
 * The composition root (#37) uses the full factory pattern above.
 */
export function assembleLlmPolicyFromPorts(
  llm: LlmPort,
  cache: DecisionCachePort,
): LLMPolicy {
  return new LLMPolicy(llm, cache);
}
