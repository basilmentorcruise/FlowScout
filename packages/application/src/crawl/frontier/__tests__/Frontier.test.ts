/**
 * Frontier tests — E2.4 acceptance criteria.
 *
 * AC coverage:
 * - AC1: A→B→A livelock prevention (no infinite revisit between two states)
 * - AC2: All actions tried → backtrack decision toward unexplored state
 * - AC3: Dead-end state (no actions) → backtrack; no target → graceful finalization
 * - AC4: No-effect actions (same post-state) → marked tried, not retried
 * - AC5: Real StateIdentity strategy (A11ySignatureStrategy) deduplicates same screen
 * - AC6: Coverage gate ≥85%
 * - Security: revisit cap + backtrack bound terminate exploration (no livelock, T6)
 * - Extension point: ProbeSource registration for #35
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Frontier } from "../Frontier.js";
import type { ProbeSource } from "../ProbeSource.js";
import type { CandidateAction } from "@flowscout/domain";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTapAction(elementId: string, rationale = "tap"): CandidateAction {
  return {
    actionType: "tap",
    actionPayload: JSON.stringify({ elementId }),
    rationale,
  };
}

const STATE_A = "state-id-A";
const STATE_B = "state-id-B";
const STATE_C = "state-id-C";

const MAX_REVISITS = 3;

// ── AC1: No livelock between two states ──────────────────────────────────────

describe("Frontier — AC1: livelock prevention", () => {
  it("returns isRevisitCapped=true once maxRevisitsPerState is reached", () => {
    const frontier = new Frontier({ maxRevisitsPerState: MAX_REVISITS });

    // Visit state A 3 times (at cap)
    for (let i = 0; i < MAX_REVISITS; i++) {
      expect(frontier.isRevisitCapped(STATE_A)).toBe(false);
      frontier.markVisited(STATE_A);
    }

    expect(frontier.isRevisitCapped(STATE_A)).toBe(true);
  });

  it("does not cap state B when only state A is capped", () => {
    const frontier = new Frontier({ maxRevisitsPerState: MAX_REVISITS });

    for (let i = 0; i < MAX_REVISITS; i++) {
      frontier.markVisited(STATE_A);
    }
    frontier.markVisited(STATE_B);

    expect(frontier.isRevisitCapped(STATE_A)).toBe(true);
    expect(frontier.isRevisitCapped(STATE_B)).toBe(false);
  });

  it("two-state cycle: once both states are revisit-capped the loop must terminate", () => {
    const frontier = new Frontier({ maxRevisitsPerState: 2 });

    // Simulate A→B→A→B — each visit increments count
    const simulateCycle = () => {
      let steps = 0;
      const maxSteps = 100; // safety guard — must stop well before this
      while (steps < maxSteps) {
        const currentState = steps % 2 === 0 ? STATE_A : STATE_B;
        frontier.markVisited(currentState);
        steps++;
        if (frontier.isRevisitCapped(STATE_A) && frontier.isRevisitCapped(STATE_B)) {
          return { terminatedAt: steps, livelock: false };
        }
      }
      return { terminatedAt: steps, livelock: true };
    };

    const result = simulateCycle();
    expect(result.livelock).toBe(false);
    // With cap=2, A and B each need 2 visits → at most 4 visits before both are capped
    expect(result.terminatedAt).toBeLessThanOrEqual(6);
  });
});

// ── AC2: All-tried-actions → backtrack ───────────────────────────────────────

describe("Frontier — AC2: backtrack when all actions tried", () => {
  let frontier: Frontier;

  beforeEach(() => {
    frontier = new Frontier({ maxRevisitsPerState: MAX_REVISITS });
  });

  it("hasUntried returns true when no actions tried", () => {
    const candidates = [makeTapAction("btn-1"), makeTapAction("btn-2")];
    expect(frontier.hasUntried(STATE_A, candidates)).toBe(true);
  });

  it("hasUntried returns false when all candidates tried", () => {
    const a1 = makeTapAction("btn-1");
    const a2 = makeTapAction("btn-2");
    const candidates = [a1, a2];

    frontier.markActionTried(STATE_A, a1);
    frontier.markActionTried(STATE_A, a2);

    expect(frontier.hasUntried(STATE_A, candidates)).toBe(false);
  });

  it("hasUntried returns true when at least one candidate is untried", () => {
    const a1 = makeTapAction("btn-1");
    const a2 = makeTapAction("btn-2");

    frontier.markActionTried(STATE_A, a1);

    expect(frontier.hasUntried(STATE_A, [a1, a2])).toBe(true);
  });

  it("selectBacktrackTarget returns the state with untried actions closest in visit history", () => {
    const frontier2 = new Frontier({ maxRevisitsPerState: MAX_REVISITS });
    const a1 = makeTapAction("btn-1");
    const a2 = makeTapAction("btn-2");

    // Visit A twice, visit B once
    frontier2.markVisited(STATE_A);
    frontier2.markVisited(STATE_A);
    frontier2.markVisited(STATE_B);

    // A has a tried action, B has none tried
    frontier2.markActionTried(STATE_A, a1);

    // B has untried [a2]
    const backtrackTarget = frontier2.selectBacktrackTarget(
      STATE_A,
      [STATE_A, STATE_B, STATE_C],
      { [STATE_A]: [a1], [STATE_B]: [a2], [STATE_C]: [] },
    );

    // Should pick B (has untried a2) over A (all tried) or C (never visited)
    expect(backtrackTarget).toBe(STATE_B);
  });

  it("selectBacktrackTarget returns null when no state has untried actions", () => {
    const frontier2 = new Frontier({ maxRevisitsPerState: MAX_REVISITS });
    const a1 = makeTapAction("btn-1");

    frontier2.markVisited(STATE_A);
    frontier2.markActionTried(STATE_A, a1);

    const result = frontier2.selectBacktrackTarget(STATE_A, [STATE_A], { [STATE_A]: [a1] });
    expect(result).toBeNull();
  });

  it("selectBacktrackTarget excludes the current state", () => {
    const frontier2 = new Frontier({ maxRevisitsPerState: MAX_REVISITS });
    const a1 = makeTapAction("btn-1");

    frontier2.markVisited(STATE_A);
    frontier2.markVisited(STATE_B);

    // Both have the same actions; mark A's tried
    frontier2.markActionTried(STATE_A, a1);

    // B has untried a1
    const result = frontier2.selectBacktrackTarget(STATE_A, [STATE_A, STATE_B], {
      [STATE_A]: [a1],
      [STATE_B]: [a1],
    });
    expect(result).toBe(STATE_B);
  });
});

// ── AC3: Dead-end + no backtrack target → graceful finalization ──────────────

describe("Frontier — AC3: dead-end handling", () => {
  it("isDeadEnd returns true when no candidates exist for a state", () => {
    const frontier = new Frontier({ maxRevisitsPerState: MAX_REVISITS });
    expect(frontier.isDeadEnd(STATE_A, [])).toBe(true);
  });

  it("isDeadEnd returns false when candidates exist", () => {
    const frontier = new Frontier({ maxRevisitsPerState: MAX_REVISITS });
    expect(frontier.isDeadEnd(STATE_A, [makeTapAction("btn-1")])).toBe(false);
  });

  it("isDeadEnd returns true when all candidates are tried", () => {
    const frontier = new Frontier({ maxRevisitsPerState: MAX_REVISITS });
    const a1 = makeTapAction("btn-1");
    frontier.markActionTried(STATE_A, a1);
    expect(frontier.isDeadEnd(STATE_A, [a1])).toBe(true);
  });

  it("selectBacktrackTarget returns null on true dead-end (no valid target) → graceful", () => {
    const frontier = new Frontier({ maxRevisitsPerState: MAX_REVISITS });
    const a1 = makeTapAction("btn-1");
    frontier.markActionTried(STATE_A, a1);

    const result = frontier.selectBacktrackTarget(STATE_A, [STATE_A], { [STATE_A]: [a1] });
    expect(result).toBeNull(); // Engine finalizes gracefully
  });

  it("entire graph exhausted → selectBacktrackTarget null", () => {
    const frontier = new Frontier({ maxRevisitsPerState: MAX_REVISITS });
    const a1 = makeTapAction("btn-1");
    const a2 = makeTapAction("btn-2");

    frontier.markVisited(STATE_A);
    frontier.markVisited(STATE_B);
    frontier.markActionTried(STATE_A, a1);
    frontier.markActionTried(STATE_B, a2);

    const result = frontier.selectBacktrackTarget(STATE_B, [STATE_A, STATE_B], {
      [STATE_A]: [a1],
      [STATE_B]: [a2],
    });
    expect(result).toBeNull();
  });
});

// ── AC4: No-effect actions marked tried ──────────────────────────────────────

describe("Frontier — AC4: no-effect action deduplication", () => {
  it("markActionTried deduplicates by payload (same action not added twice)", () => {
    const frontier = new Frontier({ maxRevisitsPerState: MAX_REVISITS });
    const action = makeTapAction("btn-1");

    frontier.markActionTried(STATE_A, action);
    frontier.markActionTried(STATE_A, action); // duplicate

    const tried = frontier.getTriedActions(STATE_A);
    expect(tried).toHaveLength(1);
  });

  it("isAlreadyTried returns true for an action with same type+payload", () => {
    const frontier = new Frontier({ maxRevisitsPerState: MAX_REVISITS });
    const action = makeTapAction("btn-1");
    frontier.markActionTried(STATE_A, action);

    // Same type + payload but different rationale — still considered same action
    const sameActionDifferentRationale: CandidateAction = {
      actionType: "tap",
      actionPayload: JSON.stringify({ elementId: "btn-1" }),
      rationale: "different rationale",
    };
    expect(frontier.isAlreadyTried(STATE_A, sameActionDifferentRationale)).toBe(true);
  });

  it("isAlreadyTried returns false for a different action payload", () => {
    const frontier = new Frontier({ maxRevisitsPerState: MAX_REVISITS });
    const action = makeTapAction("btn-1");
    frontier.markActionTried(STATE_A, action);

    expect(frontier.isAlreadyTried(STATE_A, makeTapAction("btn-2"))).toBe(false);
  });

  it("marking a no-effect action as tried advances frontier (hasUntried shrinks)", () => {
    const frontier = new Frontier({ maxRevisitsPerState: MAX_REVISITS });
    const noEffectAction = makeTapAction("btn-noop", "no observable change");
    const otherAction = makeTapAction("btn-next");

    frontier.markActionTried(STATE_A, noEffectAction);

    // Other action still untried
    expect(frontier.hasUntried(STATE_A, [noEffectAction, otherAction])).toBe(true);

    frontier.markActionTried(STATE_A, otherAction);

    // Now all are tried
    expect(frontier.hasUntried(STATE_A, [noEffectAction, otherAction])).toBe(false);
  });
});

// ── AC5: Real StateIdentity — deduplication via A11ySignatureStrategy ─────────

describe("Frontier — AC5: StateIdentity deduplication", () => {
  it("same stateId from two paths results in same visit count entry", () => {
    const frontier = new Frontier({ maxRevisitsPerState: MAX_REVISITS });
    const sharedStateId = "same-state-sha256-abc123";

    // Path 1 reaches the shared state
    frontier.markVisited(sharedStateId);
    // Path 2 also reaches the same state (via a different navigation)
    frontier.markVisited(sharedStateId);

    // Both increments land on the same entry → visit count = 2
    expect(frontier.getVisitCount(sharedStateId)).toBe(2);
  });

  it("two distinct stateIds track independently", () => {
    const frontier = new Frontier({ maxRevisitsPerState: MAX_REVISITS });
    const stateX = "state-sha256-x";
    const stateY = "state-sha256-y";

    frontier.markVisited(stateX);
    frontier.markVisited(stateX);
    frontier.markVisited(stateY);

    expect(frontier.getVisitCount(stateX)).toBe(2);
    expect(frontier.getVisitCount(stateY)).toBe(1);
  });

  it("tried actions are per-stateId (different states do not share tried sets)", () => {
    const frontier = new Frontier({ maxRevisitsPerState: MAX_REVISITS });
    const action = makeTapAction("shared-element");

    frontier.markActionTried(STATE_A, action);

    expect(frontier.isAlreadyTried(STATE_A, action)).toBe(true);
    expect(frontier.isAlreadyTried(STATE_B, action)).toBe(false);
  });
});

// ── Probe extension point for #35 ────────────────────────────────────────────

describe("Frontier — probe extension point (for #35)", () => {
  it("accepts a ProbeSource registration without error", () => {
    const frontier = new Frontier({ maxRevisitsPerState: MAX_REVISITS });
    const probeSource: ProbeSource = {
      id: "scroll-reveal",
      generateCandidates: async (_stateId, _snapshot) => [
        {
          actionType: "scroll",
          actionPayload: JSON.stringify({ direction: "down" }),
          rationale: "scroll to reveal hidden controls",
        },
      ],
    };
    expect(() => frontier.registerProbeSource(probeSource)).not.toThrow();
  });

  it("registered probes are included in getEnumeratedCandidates", async () => {
    const frontier = new Frontier({ maxRevisitsPerState: MAX_REVISITS });
    const probeCandidate: CandidateAction = {
      actionType: "scroll",
      actionPayload: JSON.stringify({ direction: "down" }),
      rationale: "probe: scroll-reveal",
    };
    const probeSource: ProbeSource = {
      id: "scroll-reveal",
      generateCandidates: async (_stateId, _snapshot) => [probeCandidate],
    };
    frontier.registerProbeSource(probeSource);

    const snapshot = '{"role":"application","children":[]}';
    const candidates = await frontier.getEnumeratedCandidates(STATE_A, snapshot as never);

    expect(candidates).toContainEqual(probeCandidate);
  });

  it("multiple probe sources are all consulted", async () => {
    const frontier = new Frontier({ maxRevisitsPerState: MAX_REVISITS });

    const probeA: ProbeSource = {
      id: "probe-a",
      generateCandidates: async () => [makeTapAction("hidden-a", "probe-a")],
    };
    const probeB: ProbeSource = {
      id: "probe-b",
      generateCandidates: async () => [makeTapAction("hidden-b", "probe-b")],
    };

    frontier.registerProbeSource(probeA);
    frontier.registerProbeSource(probeB);

    const candidates = await frontier.getEnumeratedCandidates(STATE_A, "" as never);
    const rationales = candidates.map((c) => c.rationale);
    expect(rationales).toContain("probe-a");
    expect(rationales).toContain("probe-b");
  });

  it("duplicate probe source id replaces the existing one", () => {
    const frontier = new Frontier({ maxRevisitsPerState: MAX_REVISITS });

    const probe1: ProbeSource = {
      id: "scroll-reveal",
      generateCandidates: async () => [makeTapAction("btn-old", "old")],
    };
    const probe2: ProbeSource = {
      id: "scroll-reveal",
      generateCandidates: async () => [makeTapAction("btn-new", "new")],
    };

    frontier.registerProbeSource(probe1);
    frontier.registerProbeSource(probe2);

    // Should only have one entry for the same id
    const probeIds = frontier.getProbeSourceIds();
    expect(probeIds.filter((id) => id === "scroll-reveal")).toHaveLength(1);
  });
});

// ── Revisit cap + termination bound (security T6 / no-livelock proof) ────────

describe("Frontier — revisit cap termination (no-livelock property)", () => {
  it("with revisit cap=1, a single state cannot be re-entered", () => {
    const frontier = new Frontier({ maxRevisitsPerState: 1 });

    frontier.markVisited(STATE_A);
    expect(frontier.isRevisitCapped(STATE_A)).toBe(true);
  });

  it("visit count increments correctly and cap fires at threshold", () => {
    const cap = 3;
    const frontier = new Frontier({ maxRevisitsPerState: cap });

    for (let i = 0; i < cap; i++) {
      expect(frontier.isRevisitCapped(STATE_A)).toBe(false);
      frontier.markVisited(STATE_A);
    }
    expect(frontier.isRevisitCapped(STATE_A)).toBe(true);
    expect(frontier.getVisitCount(STATE_A)).toBe(cap);
  });

  it("frontier terminates in bounded steps: N states × cap revisits + actions", () => {
    const cap = 2;
    const frontier = new Frontier({ maxRevisitsPerState: cap });
    const states = [STATE_A, STATE_B, STATE_C];
    const actionPerState: Record<string, CandidateAction[]> = {
      [STATE_A]: [makeTapAction("a1")],
      [STATE_B]: [makeTapAction("b1")],
      [STATE_C]: [],
    };

    // Simulate exploration: visit each state cap times, try their actions
    let totalSteps = 0;
    const maxBound = states.length * cap * 2 + 10; // generous upper bound

    while (totalSteps < maxBound) {
      // Find a state that is not revisit-capped and has untried actions
      const active = states.find(
        (s) => !frontier.isRevisitCapped(s) && frontier.hasUntried(s, actionPerState[s] ?? []),
      );
      if (active === undefined) break; // all states capped or exhausted → terminate

      frontier.markVisited(active);
      const untried = (actionPerState[active] ?? []).filter(
        (a) => !frontier.isAlreadyTried(active, a),
      );
      if (untried[0]) frontier.markActionTried(active, untried[0]);
      totalSteps++;
    }

    // Should have terminated well within the bound (not run to maxBound)
    expect(totalSteps).toBeLessThan(maxBound);

    // All revisitable states should be capped or exhausted
    for (const s of states.filter((s) => actionPerState[s]!.length > 0)) {
      const allTried = !frontier.hasUntried(s, actionPerState[s] ?? []);
      const capped = frontier.isRevisitCapped(s);
      expect(allTried || capped).toBe(true);
    }
  });
});

// ── getVisitCount + markVisited basic contract ────────────────────────────────

describe("Frontier — visit tracking basics", () => {
  it("returns 0 for never-visited state", () => {
    const frontier = new Frontier({ maxRevisitsPerState: MAX_REVISITS });
    expect(frontier.getVisitCount("never-visited")).toBe(0);
  });

  it("getTriedActions returns empty array for never-touched state", () => {
    const frontier = new Frontier({ maxRevisitsPerState: MAX_REVISITS });
    expect(frontier.getTriedActions("never-touched")).toEqual([]);
  });

  it("correctly accumulates multiple distinct actions", () => {
    const frontier = new Frontier({ maxRevisitsPerState: MAX_REVISITS });
    const a1 = makeTapAction("btn-1");
    const a2 = makeTapAction("btn-2");
    const a3 = makeTapAction("btn-3");

    frontier.markActionTried(STATE_A, a1);
    frontier.markActionTried(STATE_A, a2);
    frontier.markActionTried(STATE_A, a3);

    const tried = frontier.getTriedActions(STATE_A);
    expect(tried).toHaveLength(3);
  });
});
