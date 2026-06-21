/**
 * health/index.ts — real implementation barrel for the health/readiness capability.
 *
 * #17 (E1.6 — Health/readiness checks) OWNS AND REPLACES this file.
 * The stub (`HealthStub`) shipped by #12 is removed; this file re-exports the real
 * `HealthReadiness` class under the alias `HealthStub` so `capabilities.ts` (which is
 * FROZEN by #12) continues to compile without any edits.
 *
 * Alias rationale: `capabilities.ts` imports `{ HealthStub }` from `../health/index.js`.
 * We preserve that import name by re-exporting `HealthReadiness` as `HealthStub`.
 * Any caller that imported `HealthStub` now gets the real implementation transparently.
 *
 * Public surface for callers who want the richer types directly:
 *   - `HealthReadiness`          — the capability class
 *   - `DetailedReadinessResult`  — the discriminated union
 *   - `HealthReadinessConfig`    — the config slice
 *   - `DEFAULT_HEALTH_CONFIG`    — sensible production defaults
 *   - `HealthCheckTerminalError` — error class for terminal failures
 */

export { HealthReadiness } from "./HealthReadiness.js";
export { HealthReadiness as HealthStub } from "./HealthReadiness.js";
export { DEFAULT_HEALTH_CONFIG } from "./HealthReadiness.js";

export type {
  DetailedReadinessResult,
  ReadinessReady,
  ReadinessNotReady,
  ReadinessTimedOut,
  ReadinessTerminal,
  HealthReadinessConfig,
  NowFn,
  SleepFn,
} from "./readiness-result.js";

export { HealthCheckTerminalError } from "./readiness-result.js";
