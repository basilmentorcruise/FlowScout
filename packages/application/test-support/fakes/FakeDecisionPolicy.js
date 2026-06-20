export class FakeDecisionPolicy {
  decisions;
  callCount = 0;
  constructor(decisions = []) {
    this.decisions =
      decisions.length > 0 ? decisions : [{ kind: "done", reason: "fake-policy-exhausted" }];
  }
  async decide(_context) {
    const decision = this.decisions[this.callCount] ?? this.decisions[this.decisions.length - 1];
    if (decision === undefined) {
      return { kind: "done", reason: "fake-policy-exhausted" };
    }
    this.callCount++;
    return decision;
  }
  getCallCount() {
    return this.callCount;
  }
  /** Factory: return a single tap action. */
  static withTap(elementId) {
    const action = {
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
//# sourceMappingURL=FakeDecisionPolicy.js.map
