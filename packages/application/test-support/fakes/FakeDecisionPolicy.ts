/**
 * FakeDecisionPolicy — deterministic test double for DecisionPolicy.
 * Returns a pre-configured sequence of decisions; defaults to "done" when exhausted.
 */
import type {
  DecisionPolicy,
  DecisionContext,
  PolicyDecision,
  CandidateAction,
} from "@flowscout/domain";

export class FakeDecisionPolicy implements DecisionPolicy {
  private decisions: PolicyDecision[];
  private callCount = 0;

  constructor(decisions: PolicyDecision[] = []) {
    this.decisions =
      decisions.length > 0 ? decisions : [{ kind: "done", reason: "fake-policy-exhausted" }];
  }

  async decide(_context: DecisionContext): Promise<PolicyDecision> {
    const decision = this.decisions[this.callCount] ?? this.decisions[this.decisions.length - 1];
    if (decision === undefined) {
      return { kind: "done", reason: "fake-policy-exhausted" };
    }
    this.callCount++;
    return decision;
  }

  getCallCount(): number {
    return this.callCount;
  }

  /** Factory: return a single tap action. */
  static withTap(elementId: string): FakeDecisionPolicy {
    const action: CandidateAction = {
      actionType: "tap",
      actionPayload: JSON.stringify({ elementId }),
      rationale: "fake tap",
    };
    return new FakeDecisionPolicy([
      { kind: "act", action, usedLlm: false },
      { kind: "done", reason: "fake-policy-exhausted" },
    ]);
  }
}
