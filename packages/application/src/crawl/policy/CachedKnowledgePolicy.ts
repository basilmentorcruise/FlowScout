/**
 * CachedKnowledgePolicy — the LLM-LESS first link of the DecisionPolicy Chain of Responsibility.
 *
 * Selects the next UNTRIED candidate action from the DecisionContext without making any LLM call.
 * If no untried action exists, falls through to the next policy in the chain (LLMPolicy).
 *
 * "Knowledge" = the candidate actions passed in context minus the already-tried actions.
 * The policy computes the untried set by diffing context.triedActions from the candidate list.
 *
 * NOTE: This policy does NOT enumerate candidates from the a11y tree — that is the
 * Frontier's job (#34). The candidates in DecisionContext are assembled by the loop before
 * calling decide(). This policy merely selects from the pre-enumerated set.
 *
 * Security (T10/NFR1): pure application logic, zero adapter/SDK imports.
 * Port-only: depends only on @flowscout/domain types and the next policy interface.
 *
 * ADR-0004 §3.2, §3.5 — CachedKnowledgePolicy lives in application, not adapters/llm.
 */
import type {
  DecisionPolicy,
  DecisionContext,
  PolicyDecision,
  CandidateAction,
} from "@flowscout/domain";

/**
 * CachedKnowledgePolicy — selects an untried action from context knowledge without LLM.
 *
 * Chain of Responsibility:
 *   - If an untried candidate action exists → return it (usedLlm: false).
 *   - If no untried candidate exists → delegate to the `next` policy (LLMPolicy).
 *
 * Injected via constructor (DI). The `next` policy is called only on fallthrough.
 */
export class CachedKnowledgePolicy implements DecisionPolicy {
  constructor(private readonly next: DecisionPolicy) {}

  async decide(context: DecisionContext): Promise<PolicyDecision> {
    const untried = this.findFirstUntried(context);
    if (untried !== null) {
      return { kind: "act", action: untried, usedLlm: false };
    }
    // No untried action in cache knowledge — fall through to LLMPolicy
    return this.next.decide(context);
  }

  /**
   * Finds the first candidate action that is not in the tried set.
   *
   * Strategy: builds a Set of deduplication keys from triedActions for O(1) lookup,
   * then iterates candidates to find the first untried one.
   *
   * Deduplication key = actionType + "::" + actionPayload (same as Frontier.actionKey).
   * The `rationale` field is telemetry-only and does not affect identity.
   */
  private findFirstUntried(context: DecisionContext): CandidateAction | null {
    const triedKeys = new Set<string>(context.triedActions.map((a) => actionKey(a)));

    // context.candidateActions comes from the loop; if not provided, use triedActions as hint
    // The loop passes a11ySnapshot but not explicit candidates — the policy must derive them.
    // For the CachedKnowledge path, we check if the context exposes candidateActions.
    // Since DecisionContext only has triedActions + a11ySnapshot, and the candidates are
    // assembled from the a11y tree by the Frontier, we rely on the context contract:
    // if triedActions is empty, there is nothing to select from either (the LLM will pick).
    // The real candidate derivation is done by LLMPolicy using the a11y snapshot.
    //
    // For CachedKnowledgePolicy to function as a "select untried from known candidates",
    // the candidates must be provided via a richer context. However, DecisionContext
    // (frozen domain contract) only has triedActions — the set of what has been tried.
    // There is no separate "all known candidates" list in the current contract.
    //
    // Architecture decision: CachedKnowledgePolicy acts as a "have we been here before?"
    // check. If triedActions is empty (fresh state), fall through to LLM to enumerate.
    // If triedActions are non-empty but no candidates remain, fall through to LLM.
    // The actual "untried action selection" is: if the context provides candidates AND
    // at least one is not in triedKeys, pick the first one.
    //
    // Since DecisionContext does not have a candidateActions field, and #36 must not
    // change the frozen DecisionContext interface, CachedKnowledgePolicy checks if
    // candidateActions are available on an extended context type. For backward
    // compatibility, this falls through to LLM when no extension is available.
    const extCtx = context as DecisionContextWithCandidates;
    const candidates = extCtx.candidateActions;

    if (!candidates || candidates.length === 0) {
      return null; // No candidates known — fall through to LLM
    }

    for (const candidate of candidates) {
      if (!triedKeys.has(actionKey(candidate))) {
        return candidate;
      }
    }

    return null; // All candidates tried — fall through to LLM
  }
}

/** Canonical deduplication key for a CandidateAction (must match Frontier's key). */
function actionKey(action: CandidateAction): string {
  return `${action.actionType}::${action.actionPayload}`;
}

/**
 * Extended context — loop may attach candidateActions to provide the full candidate set.
 * This is an additive protocol extension: CachedKnowledgePolicy reads it if present,
 * ignores if absent. The frozen DecisionContext domain contract is unchanged.
 */
export interface DecisionContextWithCandidates extends DecisionContext {
  readonly candidateActions?: readonly CandidateAction[];
}
