/**
 * @flowscout/adapter-llm — public API barrel.
 *
 * Exports:
 *   - LlmAdapter: real LlmPort over @anthropic-ai/sdk (E2.6, #36)
 *   - LlmAdapterConfig: config type for LlmAdapter
 *   - createAnthropicClient: factory to build the SDK client from env (composition root #37)
 *   - DEFAULT_MODEL_ID: the config-pinned model id (claude-opus-4-8)
 *   - LLMPolicy: LLM-backed policy (Chain of Responsibility second link)
 *   - LlmCallResult: token usage type from LLMPolicy.lastCallResult
 *   - PolicyChain: assembled chain (CachedKnowledge → LLM) wrapper
 *   - createPolicyChain / assembleLlmPolicyFromPorts: composition root helpers
 *
 * NOT exported (legacy stub — replaced by the chain):
 *   LlmDecisionPolicy (the old stub is removed; PolicyChain replaces it)
 *
 * Security: @anthropic-ai/sdk is imported ONLY in LlmAdapter.ts.
 * The SDK import is isolated to this package (T10/NFR1 — depcruiser enforces).
 */
export { LlmAdapter, createAnthropicClient, DEFAULT_MODEL_ID } from "./LlmAdapter.js";
export type { LlmAdapterConfig, AnthropicClientLike } from "./LlmAdapter.js";

export { LLMPolicy } from "./LLMPolicy.js";
export type { LlmCallResult } from "./LLMPolicy.js";

export { PolicyChain, createPolicyChain, assembleLlmPolicyFromPorts } from "./PolicyChain.js";

// EmbeddingAdapter — the real EmbeddingPort (#57) + its env client factory (composition root #59).
export {
  EmbeddingAdapter,
  createEmbeddingClient,
  DEFAULT_EMBEDDING_MODEL_ID,
} from "./EmbeddingAdapter.js";
export type {
  EmbeddingAdapterConfig,
  EmbeddingClientLike,
  EmbeddingRequestOptions,
} from "./EmbeddingAdapter.js";
