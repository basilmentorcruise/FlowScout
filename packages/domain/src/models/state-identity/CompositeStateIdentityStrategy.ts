/**
 * CompositeStateIdentityStrategy — the activated E3 composition seam (#57, ADR-0005 §2/§7).
 *
 * E2 wired only the primary a11y-signature strategy and delegated fully. E3 ACTIVATES the merge
 * step here WITHOUT changing the loop and WITHOUT making `identify` async:
 *
 *   - `_primary` (the `A11ySignatureStrategy`) remains the AUTHORITATIVE COARSE BUCKET source.
 *     `identify` first computes the a11y bucket synchronously, exactly as E2 did.
 *   - The async embedding + the cross-bucket `SamenessRefiner` run POST-HOC, OUTSIDE this method
 *     (ADR-0005 §4.4). The refiner's `canonicalBySignature` map is supplied to this composite as a
 *     read-only lookup. `identify` then MAPS the a11y bucket through that lookup to its class's
 *     canonical identity.
 *
 * HARD INVARIANT (ADR-0005 §2.2): the canonical map only ever UNIONS buckets — `identify` can only
 * return the SAME a11y bucket or a (smaller-or-equal) canonical representative of its merge class,
 * NEVER a finer split. A bucket absent from the map (or no map at all) returns the raw a11y
 * identity — i.e. byte-for-byte E2 behaviour (refinement off / not yet computed).
 *
 * `identify` stays SYNCHRONOUS and NEVER-THROWS (the frozen `StateIdentityStrategy` contract).
 */
import type { StateIdentityInput, StateIdentityStrategy } from "../../ports/StateIdentityPort.js";
import type { StateIdentity } from "../state-graph.js";

/**
 * A read-only canonical-identity lookup: an a11y bucket signature → the canonical identity of its
 * E3 merge class. Produced post-hoc by `SamenessRefiner.refine(...)`
 * (`RefinementResult.canonicalBySignature`). When absent, the composite is pure E2 delegation.
 */
export type CanonicalIdentityMap = ReadonlyMap<StateIdentity, StateIdentity>;

export class CompositeStateIdentityStrategy implements StateIdentityStrategy {
  /**
   * @param _primary    the authoritative a11y-signature strategy (the coarse-bucket source).
   * @param _canonical  optional post-hoc merge-class lookup. Absent ⇒ exact E2 behaviour.
   */
  constructor(
    private readonly _primary: StateIdentityStrategy,
    private readonly _canonical?: CanonicalIdentityMap,
  ) {}

  /**
   * Compute the (optionally refined) identity for a screen — SYNCHRONOUS, never-throws.
   *
   * 1. Compute the authoritative a11y bucket via the primary strategy (E2, unchanged).
   * 2. If a canonical map is present and contains this bucket, return its class's canonical
   *    identity (a MERGE — never a split). Otherwise return the raw a11y bucket (E2 behaviour).
   */
  identify(input: StateIdentityInput): StateIdentity {
    const bucket = this._primary.identify(input);
    if (this._canonical === undefined) return bucket;
    return this._canonical.get(bucket) ?? bucket;
  }
}
