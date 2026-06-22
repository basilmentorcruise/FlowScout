/**
 * StateIdentityPort — the strategy port for computing a stable screen identity.
 *
 * E2 default: A11ySignatureStrategy (normalized a11y-tree structural signature, SHA-256).
 * E3 composable additions: screenEmbedding + semanticLabel (additive, not yet active).
 *
 * The strategy is injected via DI; the crawl loop (#31/#34) never imports a concrete impl.
 */
import type { A11ySnapshot } from "./MobileDriverPort.js";
import type { Platform, StateIdentity } from "../models/state-graph.js";

/** Full input bag for state-identity computation. E2 uses a11ySnapshot only. */
export interface StateIdentityInput {
  /** Mandatory. The accessibility-tree snapshot at the observed screen. */
  readonly a11ySnapshot: A11ySnapshot;
  /** Additive, E3-supplied. Optional screen embedding vector (ignored by default impl). */
  readonly screenEmbedding?: readonly number[];
  /** Additive, E3-supplied. Optional semantic label (ignored by default impl). */
  readonly semanticLabel?: string;
  /** Target platform — may influence node-role normalisation in future strategies. */
  readonly platform: Platform;
}

/**
 * StateIdentityStrategy — the Strategy port.
 *
 * Contract:
 * - Deterministic: identical input → identical output on every call.
 * - Robust: never throws on any input; empty/malformed → degraded identity.
 * - Volatile-content tolerant: dynamic content (timestamps, counters, list rows)
 *   must not fork identity for structurally-identical screens.
 */
export interface StateIdentityStrategy {
  /**
   * Compute a stable identity for the given screen input.
   * Must never throw — returns a degraded identity on empty/malformed input.
   */
  identify(input: StateIdentityInput): StateIdentity;
}
