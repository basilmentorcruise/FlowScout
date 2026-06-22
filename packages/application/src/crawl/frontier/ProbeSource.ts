/**
 * ProbeSource — the extension-point interface for hidden-affordance probes (#35).
 *
 * The Frontier exposes `registerProbeSource(source: ProbeSource)` so #35 can
 * add probe strategies (scroll-reveal, swipe-reveal, overflow-menu, etc.) WITHOUT
 * editing the Frontier core (Open/Closed principle — ADR-0004 §8 item 5, R-4).
 *
 * Contract:
 * - `id` is a stable, unique identifier for the probe type (e.g. "scroll-reveal").
 *   If two sources share an id, the newer registration replaces the older (idempotent
 *   re-registration for test isolation).
 * - `generateCandidates` is called during frontier enumeration for each observed state.
 *   It must never throw; on error it returns an empty array (degrade gracefully, ADR-0004 §6).
 * - Probe candidates are reified `CandidateAction` values (Command pattern) — they flow
 *   through the normal tried/untried tracking and produce normal graph edges when acted upon.
 * - Port-only: no adapter/SDK imports permitted (T10/NFR1).
 */
import type { A11ySnapshot, CandidateAction } from "@flowscout/domain";

/**
 * ProbeSource — a pluggable candidate-action generator for hidden affordances.
 *
 * #35 (E2.5) implements:
 *   - ScrollRevealProbeSource   (supported: swipe up/down + re-snapshot)
 *   - SwipeRevealProbeSource    (supported: swipe left/right + re-snapshot)
 *   - OverflowMenuProbeSource   (supported: tap unlabeled overflow element)
 *   - LongPressProbeSource      (degraded: no-op + telemetry, port has no longPress primitive)
 */
export interface ProbeSource {
  /**
   * Stable identifier for this probe type.
   * Used for dedup/replacement on re-registration.
   */
  readonly id: string;

  /**
   * Generate probe candidate actions for the given state.
   *
   * @param stateId  The current state identity string (for probe-specific filtering).
   * @param snapshot The current a11y snapshot (for element-based probe targeting).
   * @returns        Candidate actions to include in the frontier for this state.
   *                 Returns an empty array on error (never throws).
   */
  generateCandidates(stateId: string, snapshot: A11ySnapshot): Promise<readonly CandidateAction[]>;
}
