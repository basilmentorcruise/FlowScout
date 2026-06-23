/**
 * CrawlRunSafety — no-production guard config (#37 / E2.7).
 *
 * Supplies the composition root with a config-driven non-production target control (T4).
 * The engine asserts this before starting the destructive crawl loop:
 *   - If `nonProduction` is false or the `target` is on a production allowlist → abort.
 *
 * This is an APPLICATION-local value object (not a domain type) to avoid a domain change.
 * The actual non-production values come from config/env at the composition root; the engine
 * just enforces the invariant.
 *
 * Port-only: no adapter/SDK imports (T10/NFR1).
 */

// ── CrawlRunSafety ─────────────────────────────────────────────────────────────

/**
 * CrawlRunSafety — config-driven non-production target control.
 *
 * Fields:
 *   - `target`: the UDID or bundle identifier the engine will drive.
 *   - `nonProduction`: must be explicitly `true`; if false/undefined → abort (T4 mitigation 2).
 *
 * The composition root constructs this from env/config. The engine never reads env directly.
 */
export interface CrawlRunSafety {
  /** The UDID or bundle target the engine will drive (used for abort-message context). */
  readonly target: string;
  /**
   * Must be explicitly true to allow the crawl to proceed.
   * False / absent → engine aborts with a CrawlErrorEvent and does not start the loop.
   * This is the documented, config-driven guard against accidental production targeting (T4).
   */
  readonly nonProduction: boolean;
}
