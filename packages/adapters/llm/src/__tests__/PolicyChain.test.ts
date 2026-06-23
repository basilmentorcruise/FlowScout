/**
 * PolicyChain unit tests.
 *
 * Covers:
 *   - PolicyChain.decide() delegates to the chain head
 *   - PolicyChain exposes llmPolicy accessor
 *   - createPolicyChain factory function
 *   - assembleLlmPolicyFromPorts factory function
 */
import { describe, it, expect } from "vitest";
import { PolicyChain, createPolicyChain, assembleLlmPolicyFromPorts } from "../PolicyChain.js";
import { LLMPolicy } from "../LLMPolicy.js";
import type {
  DecisionPolicy,
  DecisionContext,
  PolicyDecision,
  LlmPort,
  LlmMessage,
  LlmCompletionOptions,
  LlmCompletionResult,
  DecisionCachePort,
} from "@flowscout/domain";
import { makeStateIdentity } from "@flowscout/domain";

// ── Fakes ──────────────────────────────────────────────────────────────────────

class FakeChainHead implements DecisionPolicy {
  private readonly _decision: PolicyDecision;
  private _callCount = 0;

  constructor(decision: PolicyDecision) {
    this._decision = decision;
  }

  decide(_ctx: DecisionContext): Promise<PolicyDecision> {
    this._callCount++;
    return Promise.resolve(this._decision);
  }

  get callCount(): number {
    return this._callCount;
  }
}

class FakeLlmPort implements LlmPort {
  complete(
    _messages: readonly LlmMessage[],
    _options: LlmCompletionOptions,
  ): Promise<LlmCompletionResult> {
    return Promise.resolve({
      content: '{"choice":"backtrack","reason":"fake"}',
      promptTokens: 50,
      completionTokens: 10,
      modelId: "claude-opus-4-8",
    });
  }
}

class FakeDecisionCache implements DecisionCachePort {
  private readonly _store = new Map<string, PolicyDecision>();

  get(stateId: string): Promise<PolicyDecision | null> {
    return Promise.resolve(this._store.get(stateId) ?? null);
  }

  set(stateId: string, decision: PolicyDecision): Promise<void> {
    this._store.set(stateId, decision);
    return Promise.resolve();
  }
}

const STATE = makeStateIdentity("state-chain-test");
const CALL_COUNT_TWO = 2;

function makeContext(): DecisionContext {
  return {
    runId: "run-chain",
    currentStateId: STATE,
    a11ySnapshot: '{"role":"application"}' as never,
    triedActions: [],
    visitCount: 1,
  };
}

function makeParts(): { llmPolicy: LLMPolicy; chainHead: FakeChainHead } {
  const fakeLlm = new FakeLlmPort();
  const fakeCache = new FakeDecisionCache();
  const llmPolicy = new LLMPolicy(fakeLlm, fakeCache);
  const chainHead = new FakeChainHead({ kind: "done", reason: "test done" });
  return { llmPolicy, chainHead };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("PolicyChain.decide()", () => {
  it("delegates decide() to the injected chain head", async () => {
    const { llmPolicy, chainHead } = makeParts();
    const expectedDecision: PolicyDecision = { kind: "done", reason: "test done" };
    const chain = new PolicyChain(chainHead, llmPolicy);

    const result = await chain.decide(makeContext());

    expect(result).toEqual(expectedDecision);
    expect(chainHead.callCount).toBe(1);
  });

  it("can be called multiple times", async () => {
    const { llmPolicy, chainHead } = makeParts();
    const chain = new PolicyChain(chainHead, llmPolicy);
    const ctx = makeContext();

    await chain.decide(ctx);
    await chain.decide(ctx);

    expect(chainHead.callCount).toBe(CALL_COUNT_TWO);
  });
});

describe("PolicyChain.llmPolicy accessor", () => {
  it("exposes the llmPolicy passed to constructor", () => {
    const { llmPolicy, chainHead } = makeParts();
    const chain = new PolicyChain(chainHead, llmPolicy);
    expect(chain.llmPolicy).toBe(llmPolicy);
  });
});

describe("createPolicyChain factory", () => {
  it("returns a PolicyChain instance", () => {
    const { llmPolicy, chainHead } = makeParts();
    const chain = createPolicyChain(chainHead, llmPolicy);
    expect(chain).toBeInstanceOf(PolicyChain);
  });

  it("exposes the llmPolicy passed to it", () => {
    const { llmPolicy, chainHead } = makeParts();
    const chain = createPolicyChain(chainHead, llmPolicy);
    expect(chain.llmPolicy).toBe(llmPolicy);
  });
});

describe("assembleLlmPolicyFromPorts factory", () => {
  it("returns an LLMPolicy instance", () => {
    const fakeLlm = new FakeLlmPort();
    const fakeCache = new FakeDecisionCache();
    const policy = assembleLlmPolicyFromPorts(fakeLlm, fakeCache);
    expect(policy).toBeInstanceOf(LLMPolicy);
  });

  it("the returned LLMPolicy has null lastCallResult initially", () => {
    const fakeLlm = new FakeLlmPort();
    const fakeCache = new FakeDecisionCache();
    const policy = assembleLlmPolicyFromPorts(fakeLlm, fakeCache);
    expect(policy.lastCallResult).toBeNull();
  });
});
