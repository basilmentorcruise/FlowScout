/**
 * readiness-result.ts — Discriminated union for the health/readiness capability.
 *
 * Owned by #17 (E1.6 — Health/readiness checks). Adapter-local: never exported to the
 * domain port (ADR-0002 §5/#17 guidance; the arch/security review confirmed this stays
 * adapter-local). If the engine later needs it, promote via a follow-up ADR.
 *
 * Design goals:
 * - Every variant carries `mcpReachable`, `wdaUp`, and `appLaunched` so the union is a
 *   structural subtype of the flat `ReadinessResult` in `capabilities.ts` — HealthReadiness
 *   can implement `HealthCapability` with covariant return type without editing the frozen file.
 * - `retryable` discriminates "try again" from "give up", letting callers decide quickly.
 * - Error/timeout messages name the cause WITHOUT echoing secret config values (T5/ADR-0002 §5).
 *
 * Security (T5, T7):
 * - `cause` fields carry only the error *category* string — never full config, env, or secrets.
 * - `HealthCheckTerminalError` wraps the root cause for logging but its message is redacted.
 */

import { McpAdapterError } from "../connection/errors.js";

// ---------------------------------------------------------------------------
// Variant types (structural sub-variants of ReadinessResult from capabilities.ts)
// ---------------------------------------------------------------------------

/**
 * Both MCP server and WebDriverAgent are ready.
 * `appLaunched` is true/false when a bundleId was provided; null when no bundleId was checked.
 */
export interface ReadinessReady {
  readonly kind: "ready";
  readonly mcpReachable: true;
  readonly wdaUp: true;
  readonly appLaunched: boolean | null;
  readonly retryable: false;
}

/**
 * Not yet ready — caller may retry after `pollIntervalMs`.
 * Either WDA is still coming up, or the app has not been reported as launched yet.
 * The MCP server itself IS reachable (otherwise it would be TERMINAL).
 */
export interface ReadinessNotReady {
  readonly kind: "not-ready";
  readonly mcpReachable: true;
  readonly wdaUp: boolean;
  readonly appLaunched: null;
  readonly retryable: true;
  /** Human-readable reason (no secret leakage). */
  readonly reason: string;
}

/**
 * Polling timed out — the target did not become ready within the configured bound.
 * Resolves (does not throw) so the caller can distinguish timeout from terminal error.
 * `elapsedMs` is the total time spent polling (informational, no config secret).
 */
export interface ReadinessTimedOut {
  readonly kind: "timed-out";
  readonly mcpReachable: boolean;
  readonly wdaUp: boolean;
  readonly appLaunched: null;
  readonly retryable: false;
  /** Elapsed polling duration in ms (informational — safe to surface to operator). */
  readonly elapsedMs: number;
}

/**
 * Terminal failure — the MCP server itself is unreachable (hard error, no retry will help).
 * Distinct from RETRYABLE "WDA not yet up" so callers fail fast without wasting poll budget.
 * `cause` names the error category only — no secrets (T5).
 */
export interface ReadinessTerminal {
  readonly kind: "terminal";
  readonly mcpReachable: false;
  readonly wdaUp: false;
  readonly appLaunched: null;
  readonly retryable: false;
  /** Error category string — redacted, no secret values (T5). */
  readonly cause: string;
}

/**
 * Discriminated union — the full set of outcomes from a readiness check.
 *
 * Every variant satisfies the flat `ReadinessResult` interface in `capabilities.ts`
 * (structural subtyping: all three required fields are present on each variant).
 * This lets `HealthReadiness` implement `HealthCapability` via covariant return type.
 */
export type DetailedReadinessResult =
  | ReadinessReady
  | ReadinessNotReady
  | ReadinessTimedOut
  | ReadinessTerminal;

// ---------------------------------------------------------------------------
// Terminal error class — thrown on hard non-retryable failures
// ---------------------------------------------------------------------------

/**
 * Thrown as the root error type when MCP is unreachable with a terminal, non-retryable cause.
 * Extends McpAdapterError so callers that catch the base type still work (DRY).
 * Message names the cause category only — never leaks secrets or full env (T5).
 *
 * Note: `HealthReadiness.checkReadiness()` returns a `ReadinessTerminal` result rather
 * than throwing, so this error class is available for internal detection/wrapping only
 * and for callers who prefer exception semantics.
 */
export class HealthCheckTerminalError extends McpAdapterError {
  constructor(cause: string, rootCause?: unknown) {
    super(`Health check terminal failure: ${cause}`, rootCause);
    this.name = "HealthCheckTerminalError";
  }
}

// ---------------------------------------------------------------------------
// Configuration slice for the health module
// ---------------------------------------------------------------------------

/**
 * Configuration for bounded polling/timeout — no magic numbers (ADR-0001 §6, T3).
 * All values injected from the composition root; HealthReadiness never hardcodes them.
 */
export interface HealthReadinessConfig {
  /**
   * Maximum total time (ms) to poll before returning a `timed-out` result.
   * Bounding this prevents indefinite hangs (T3 / AC5 — must not hang).
   */
  readonly readinessTimeoutMs: number;

  /**
   * Interval (ms) between consecutive poll attempts.
   * Should be less than `readinessTimeoutMs` to allow at least one retry.
   */
  readonly pollIntervalMs: number;

  /**
   * Per-probe call timeout (ms) — caps a single tool call so a hung WDA does not
   * exhaust the entire readiness budget on one attempt. Should be less than
   * `readinessTimeoutMs`.
   */
  readonly probeTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// Clock abstraction — injectable for deterministic test control
// ---------------------------------------------------------------------------

/**
 * Injectable clock: returns the current monotonic millisecond value.
 * In production: `Date.now`. In tests: a fake that steps on demand.
 * Injecting `now` makes the timeout logic fully deterministic (no real sleeps in tests).
 */
export type NowFn = () => number;

/**
 * Injectable sleep: waits `ms` milliseconds then resolves.
 * In production: `(ms) => new Promise(r => setTimeout(r, ms))`.
 * In tests: a no-op `() => Promise.resolve()` to avoid real delays.
 */
export type SleepFn = (ms: number) => Promise<void>;
