/**
 * FakeDecisionPolicy — deterministic test double for DecisionPolicy.
 * Returns a pre-configured sequence of decisions; defaults to "done" when exhausted.
 */
import type { DecisionPolicy, DecisionContext, PolicyDecision } from "@flowscout/domain";
export declare class FakeDecisionPolicy implements DecisionPolicy {
  private decisions;
  private callCount;
  constructor(decisions?: PolicyDecision[]);
  decide(_context: DecisionContext): Promise<PolicyDecision>;
  getCallCount(): number;
  /** Factory: return a single tap action. */
  static withTap(elementId: string): FakeDecisionPolicy;
}
//# sourceMappingURL=FakeDecisionPolicy.d.ts.map
