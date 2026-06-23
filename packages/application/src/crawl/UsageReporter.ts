/**
 * UsageReporter — port-purity workaround for truthful LLM usage feed (#37 / E2.7).
 *
 * The engine must feed real LLM token counts into BudgetEnforcer (T6: engine-owned caps).
 * But the engine holds DecisionPolicy (the port) and must NOT import PolicyChain (T10).
 *
 * Solution (§4 of E2.7 plan):
 *   - Inject a `usageReporter` collaborator — a thin interface that the engine calls.
 *   - The composition root backs it with a closure over `chain.llmPolicy.lastCallResult`.
 *   - The engine never names PolicyChain; it just calls `usageReporter.lastCall()`.
 *
 * Port-only: no adapter/SDK imports (T10/NFR1).
 */

// ── LLM call usage snapshot ───────────────────────────────────────────────────

/** Usage from the most recent LLM call (null if no LLM call has been made). */
export interface LlmCallUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

// ── UsageReporter interface ───────────────────────────────────────────────────

/**
 * UsageReporter — a collaborator the loop calls after each `policy.decide()`.
 *
 * Returns the token counts from the most recent LLM call (if any), or null if
 * the last decision did not use the LLM (e.g. cache hit via CachedKnowledgePolicy).
 *
 * The composition root wires this to `chain.llmPolicy.lastCallResult`; the engine
 * never names the concrete PolicyChain class.
 */
export interface UsageReporter {
  /** Returns usage from the last LLM call, or null if none occurred. */
  lastCall(): LlmCallUsage | null;
}

// ── Default no-op implementation ──────────────────────────────────────────────

/**
 * NoOpUsageReporter — always returns null (no LLM usage reported).
 *
 * Used as the default in `defaultCollaborators()` so existing tests that
 * don't wire a real LLM chain continue to work unchanged (backward-compat).
 *
 * Budget enforcer receives `llmCallCount: 0, tokenCount: 0` in no-op mode —
 * which means the LLM-call cap and token cap are not enforced (same behavior
 * as before #37). The composition root always injects a real reporter.
 */
export class NoOpUsageReporter implements UsageReporter {
  lastCall(): LlmCallUsage | null {
    return null;
  }
}
