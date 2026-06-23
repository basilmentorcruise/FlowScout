/**
 * Hidden-affordance probe sources — E2.5 (#35).
 *
 * Public API for the `probes/` subtree:
 *
 *   - ScrollRevealProbeSource  — swipe up/down to reveal off-screen controls (SUPPORTED).
 *   - SwipeRevealProbeSource   — swipe left/right to reveal row actions/drawers (SUPPORTED).
 *   - OverflowMenuProbeSource  — tap unlabeled overflow/more buttons (SUPPORTED).
 *   - LongPressProbeSource     — no-op + telemetry (driver has no longPress — ADR-0004 R-1).
 *
 * `registerHiddenAffordanceProbes(frontier)` is the entry point called by
 * `defaultCollaborators()` (a minimal body edit in `collaborators.ts`) to wire all
 * four probe sources into the Frontier's extension point without touching the Frontier
 * core or the frozen `StartCrawlRun` shell.
 *
 * Port-only: no adapter/SDK imports (T10/NFR1).
 */
export { ScrollRevealProbeSource } from "./ScrollRevealProbeSource.js";
export { SwipeRevealProbeSource } from "./SwipeRevealProbeSource.js";
export { OverflowMenuProbeSource } from "./OverflowMenuProbeSource.js";
export { LongPressProbeSource } from "./LongPressProbeSource.js";
export type {
  LongProbeTelemetry,
  TelemetryCallback,
  LongPressProbeOptions,
} from "./LongPressProbeSource.js";

import type { Frontier } from "../Frontier.js";
import { ScrollRevealProbeSource } from "./ScrollRevealProbeSource.js";
import { SwipeRevealProbeSource } from "./SwipeRevealProbeSource.js";
import { OverflowMenuProbeSource } from "./OverflowMenuProbeSource.js";
import { LongPressProbeSource } from "./LongPressProbeSource.js";

/**
 * Register all hidden-affordance probe sources on the given Frontier instance.
 *
 * Called by `defaultCollaborators()` (a minimal, sanctioned body edit in
 * `collaborators.ts`). Does NOT edit `Frontier.ts` core or the frozen
 * `StartCrawlRun.ts` / `collaborators.ts` interface/signature (ADR-0004 §8 item 5).
 *
 * Registration is idempotent: re-calling this function with the same Frontier replaces
 * each source (same id) rather than duplicating it (Frontier.registerProbeSource contract).
 *
 * @param frontier The Frontier instance to register probes on (constructed by defaultCollaborators).
 */
export function registerHiddenAffordanceProbes(frontier: Frontier): void {
  frontier.registerProbeSource(new ScrollRevealProbeSource());
  frontier.registerProbeSource(new SwipeRevealProbeSource());
  frontier.registerProbeSource(new OverflowMenuProbeSource());
  frontier.registerProbeSource(new LongPressProbeSource());
}
