/**
 * CompositeStateIdentityStrategy — composition seam for E3 additive inputs.
 *
 * E2 wires only the primary a11y-signature strategy.
 * E3 will inject embedding + semantic-label refinements here without changing the loop.
 *
 * ADR-0004 §2.3: a11y-signature is the coarse bucket (cheap, exact); embedding is a
 * within-bucket / cross-bucket merge step (deferred); semantic label is a tie-break/label only.
 *
 * For E2, this class simply delegates to the primary strategy — no weighting or merging yet.
 * The interface seam is designed to allow future additives without any loop change.
 */
import type { StateIdentityInput, StateIdentityStrategy } from "../../ports/StateIdentityPort.js";
import type { StateIdentity } from "../state-graph.js";

/**
 * CompositeStateIdentityStrategy — wraps a primary strategy.
 *
 * E2: delegates fully to primary (sameness = exact hash match, threshold 1.0).
 * E3: will optionally merge cross-bucket identities via embedding cosine similarity.
 */
export class CompositeStateIdentityStrategy implements StateIdentityStrategy {
  constructor(private readonly _primary: StateIdentityStrategy) {}

  identify(input: StateIdentityInput): StateIdentity {
    // E2: exact delegation. E3 will add embedding refinement here.
    return this._primary.identify(input);
  }
}
