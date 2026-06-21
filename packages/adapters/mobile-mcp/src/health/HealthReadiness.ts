/**
 * HealthReadiness.ts — real implementation of HealthCapability (ADR-0002 §5/#17).
 *
 * E1.6 — Health / readiness checks.
 *
 * Implements `checkReadiness(bundleId?)` with:
 *   1. MCP reachability: `listTools()` — if this fails terminally, the MCP server is down.
 *   2. WebDriverAgent probe: calls a lightweight driving tool (`mobile_get_screen_size`)
 *      that exercises WDA. If the tool is absent in the tool list, WDA is considered not ready.
 *   3. App launched (optional): calls `mobile_list_apps` with a bundleId to detect if the
 *      target app is in the foreground (only when a bundleId is provided).
 *   4. Bounded polling: retries every `pollIntervalMs` until `readinessTimeoutMs` elapses,
 *      then resolves with a `timed-out` result — never hangs (T3 / AC5).
 *
 * Design (ADR-0002 §2.1, §5/#17):
 *   - SRP: HealthReadiness owns ONLY the readiness check; no lifecycle, no driving.
 *   - DIP: depends on McpConnection (injected abstraction), not the SDK directly.
 *   - OCP: new probe signals can be added by extending the probe helper methods.
 *   - No magic numbers: all timeouts/intervals come from HealthReadinessConfig.
 *   - NowFn + SleepFn injected for deterministic tests (no real timers needed in tests).
 *
 * Security (#17 MUSTs from threat model):
 *   T3 — bounded polling; every probe capped by probeTimeoutMs; no indefinite hang.
 *   T5 — error messages name cause category ONLY; no secrets/config leaked in strings.
 *   T7 — verifies the adapter-spawned server/WDA, not any arbitrary responder
 *         (probes go through the injected McpConnection which owns the spawned transport).
 *
 * Result type (adapter-local per ADR-0002 §5):
 *   `DetailedReadinessResult` is a discriminated union (readiness-result.ts).
 *   It satisfies the flat `ReadinessResult` interface in capabilities.ts structurally
 *   (every variant has `mcpReachable`, `wdaUp`, `appLaunched`), so HealthReadiness
 *   implements `HealthCapability` via covariant return type without editing capabilities.ts.
 */

import type { HealthCapability } from "../connection/capabilities.js";
import type { McpConnection } from "../connection/McpConnection.js";
import type { McpServerConfig } from "../connection/connection-config.js";
import { McpNotConnectedError, McpToolError } from "../connection/errors.js";
import type {
  DetailedReadinessResult,
  HealthReadinessConfig,
  NowFn,
  SleepFn,
} from "./readiness-result.js";

// ---------------------------------------------------------------------------
// MCP tool names used for probing
// ---------------------------------------------------------------------------

/**
 * Lightweight tool that exercises WDA by returning the screen dimensions.
 * Calling it proves WDA is attached and responsive without triggering UI interaction.
 */
const TOOL_WDA_PROBE = "mobile_get_screen_size";

/**
 * Tool used to enumerate running apps — used to detect whether a specific bundleId
 * is in the foreground. Returns a list of installed/running apps with their bundle ids.
 */
const TOOL_LIST_APPS = "mobile_list_apps";

// ---------------------------------------------------------------------------
// Default HealthReadinessConfig — sensible production defaults (no magic numbers:
// all are exposed so the composition root can override them from env/config).
// ---------------------------------------------------------------------------

export const DEFAULT_HEALTH_CONFIG: HealthReadinessConfig = {
  readinessTimeoutMs: 30_000, // 30 s total poll budget
  pollIntervalMs: 1_000,      // retry every 1 s
  probeTimeoutMs: 5_000,      // 5 s per individual probe
};

// ---------------------------------------------------------------------------
// HealthReadiness
// ---------------------------------------------------------------------------

/**
 * Real implementation of HealthCapability (replaces HealthStub from #12).
 *
 * Constructor follows the Wave-1 seam contract (ADR-0002 §2.3):
 *   - receives the shared McpConnection (injected — DIP)
 *   - receives the McpServerConfig (for the probeTimeoutMs slice)
 *   - receives an optional HealthReadinessConfig override (for poll bounds)
 *   - receives optional NowFn and SleepFn for deterministic test control
 *
 * The class name is exported; the constructor is intentionally broad so Wave-1
 * tests can inject fakes without touching capabilities.ts or the facade.
 */
export class HealthReadiness implements HealthCapability {
  private readonly healthConfig: HealthReadinessConfig;
  private readonly now: NowFn;
  private readonly sleep: SleepFn;

  constructor(
    private readonly connection: McpConnection,
    // _serverConfig is the Wave-1 seam arg (probeTimeoutMs is taken from healthConfig instead).
    // Kept as part of the constructor signature per ADR-0002 §2.3 contract.
    _serverConfig: McpServerConfig,
    healthConfig?: Partial<HealthReadinessConfig>,
    now: NowFn = Date.now,
    sleep: SleepFn = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  ) {
    this.healthConfig = { ...DEFAULT_HEALTH_CONFIG, ...healthConfig };
    this.now = now;
    this.sleep = sleep;
  }

  // ---------------------------------------------------------------------------
  // Public API — implements HealthCapability (covariant return type)
  // ---------------------------------------------------------------------------

  /**
   * Check readiness with bounded polling.
   *
   * Polls until:
   *   a) the adapter-spawned MCP server + WDA are ready (optionally app launched), OR
   *   b) the configured `readinessTimeoutMs` elapses → resolves with `timed-out`, OR
   *   c) a terminal (non-retryable) error occurs → resolves with `terminal`.
   *
   * @param bundleId - optional app bundle id; when provided, also probes app-launched.
   *                   Callers pass the target app's bundleId here (the HealthCapability
   *                   interface exposes a single optional string parameter).
   */
  checkReadiness(bundleId?: string): Promise<DetailedReadinessResult> {
    return this.pollUntilReady(bundleId);
  }

  // ---------------------------------------------------------------------------
  // Polling loop (bounded — satisfies T3/AC5)
  // ---------------------------------------------------------------------------

  private async pollUntilReady(bundleId?: string): Promise<DetailedReadinessResult> {
    const { readinessTimeoutMs, pollIntervalMs } = this.healthConfig;
    const startMs = this.now();

    // Track the last probe outcome so that a timeout result can carry forward the
    // most-recent mcpReachable/wdaUp state (informational — not a secret).
    let lastMcpReachable = false;
    let lastWdaUp = false;

    for (;;) {
      const elapsedMs = this.now() - startMs;

      // Timeout check — resolve (not throw) with timed-out signal (AC5).
      if (elapsedMs >= readinessTimeoutMs) {
        return buildTimedOut(lastMcpReachable, lastWdaUp, elapsedMs);
      }

      const probe = await this.probeOnce(bundleId);

      if (probe.kind === "ready" || probe.kind === "terminal") {
        return probe;
      }

      // probe.kind === "not-ready" → retryable; update last-known state and wait.
      lastMcpReachable = probe.mcpReachable;
      lastWdaUp = probe.wdaUp;

      // Guard: if the remaining budget is exhausted, return timed-out now.
      const remaining = readinessTimeoutMs - (this.now() - startMs);
      if (remaining <= 0) {
        return buildTimedOut(lastMcpReachable, lastWdaUp, this.now() - startMs);
      }

      // Sleep for the configured interval (or remaining budget, whichever is shorter).
      await this.sleep(Math.min(pollIntervalMs, remaining));
    }
  }

  // ---------------------------------------------------------------------------
  // Single probe: MCP reachability (Step 1 of 3)
  // ---------------------------------------------------------------------------

  /**
   * Probe MCP reachability via listTools(). Returns the tool list on success.
   * On failure, returns a terminal result.
   *
   * Security (T5): catch blocks capture only the error category, not secrets.
   */
  private async probeMcp(): Promise<
    { ok: true; tools: readonly { name: string }[] } | { ok: false; terminal: DetailedReadinessResult }
  > {
    try {
      const tools = await this.withProbeTimeout(
        this.connection.listTools(),
        "MCP tool listing",
      );
      return { ok: true, tools };
    } catch (err) {
      if (err instanceof McpNotConnectedError) {
        return {
          ok: false,
          terminal: {
            kind: "terminal",
            mcpReachable: false,
            wdaUp: false,
            appLaunched: null,
            retryable: false,
            cause: "MCP server not connected — call connect() before checking readiness",
          },
        };
      }
      return {
        ok: false,
        terminal: {
          kind: "terminal",
          mcpReachable: false,
          wdaUp: false,
          appLaunched: null,
          retryable: false,
          cause: `MCP server unreachable: ${categorizeError(err)}`,
        },
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Single probe: WDA reachability (Step 2 of 3)
  // ---------------------------------------------------------------------------

  /**
   * Probe WebDriverAgent via the lightweight screen-size tool call.
   * Returns `true` if WDA responded, a retryable not-ready result otherwise.
   *
   * Security (T5): only error category is included in the reason string.
   */
  private async probeWda(): Promise<
    { ok: true } | { ok: false; notReady: DetailedReadinessResult }
  > {
    try {
      await this.withProbeTimeout(
        this.connection.callTool(TOOL_WDA_PROBE, {}),
        "WebDriverAgent probe",
      );
      return { ok: true };
    } catch (err) {
      const reason =
        err instanceof McpToolError
          ? "WebDriverAgent probe returned an error — WDA not yet ready"
          : `WebDriverAgent probe failed: ${categorizeError(err)}`;
      return {
        ok: false,
        notReady: {
          kind: "not-ready",
          mcpReachable: true,
          wdaUp: false,
          appLaunched: null,
          retryable: true,
          reason,
        },
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Single probe attempt: orchestrates Steps 1–3
  // ---------------------------------------------------------------------------

  /**
   * Attempt one readiness probe cycle (Steps 1–3).
   *
   * Returns:
   *   - `terminal`  : MCP server is unreachable (hard fail — no retry will help).
   *   - `not-ready` : MCP is up but WDA / app is not ready yet (retry is appropriate).
   *   - `ready`     : both MCP and WDA are up; appLaunched matches bundleId check.
   */
  private async probeOnce(bundleId?: string): Promise<DetailedReadinessResult> {
    // Step 1 — MCP reachability.
    const mcpResult = await this.probeMcp();
    if (!mcpResult.ok) {
      return mcpResult.terminal;
    }

    const { tools } = mcpResult;

    // Step 2 — WDA tool presence check (short-circuit before the call).
    if (!tools.some((t) => t.name === TOOL_WDA_PROBE)) {
      return {
        kind: "not-ready",
        mcpReachable: true,
        wdaUp: false,
        appLaunched: null,
        retryable: true,
        reason: "WebDriverAgent tool not yet available in tool list",
      };
    }

    // Step 2 continued — WDA probe call.
    const wdaResult = await this.probeWda();
    if (!wdaResult.ok) {
      return wdaResult.notReady;
    }

    // Step 3 — App launched check (optional).
    const appLaunched =
      bundleId !== undefined && bundleId.length > 0
        ? await this.probeAppLaunched(bundleId)
        : null;

    return {
      kind: "ready",
      mcpReachable: true,
      wdaUp: true,
      appLaunched,
      retryable: false,
    };
  }

  // ---------------------------------------------------------------------------
  // App-launched probe (Step 3 detail)
  // ---------------------------------------------------------------------------

  /**
   * Check whether the target bundleId app is launched / in the foreground.
   *
   * Calls `mobile_list_apps` and checks if the bundleId appears in the result.
   * Returns `true` if launched, `false` if not, `null` on probe error
   * (we do not fail the whole readiness check if the app-list call fails).
   *
   * Security (T5): bundleId is used only as a comparison value — never echoed in output.
   */
  private async probeAppLaunched(bundleId: string): Promise<boolean | null> {
    try {
      const result = await this.withProbeTimeout(
        this.connection.callTool(TOOL_LIST_APPS, {}),
        "app-launched probe",
      );
      return extractAppLaunched(result, bundleId);
    } catch {
      // If app-launch detection fails (tool absent, timeout, etc.), return null
      // (unknown) rather than failing the whole readiness result.
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Probe timeout helper — caps individual calls within the poll budget (T3)
  // ---------------------------------------------------------------------------

  /**
   * Wraps a promise with a per-probe timeout (from `probeTimeoutMs` config).
   * If the probe doesn't settle in time, the polling loop can still continue.
   */
  private withProbeTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    const { probeTimeoutMs } = this.healthConfig;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(`${label} probe timed out after ${String(probeTimeoutMs)}ms`),
        );
      }, probeTimeoutMs);

      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Private module-level helpers
// ---------------------------------------------------------------------------

/** Build a timed-out result carrying the last-known probe state. */
function buildTimedOut(
  mcpReachable: boolean,
  wdaUp: boolean,
  elapsedMs: number,
): DetailedReadinessResult {
  return {
    kind: "timed-out",
    mcpReachable,
    wdaUp,
    appLaunched: null,
    retryable: false,
    elapsedMs,
  };
}

/**
 * Return a safe, redacted error category string for use in result cause fields.
 * Never includes secret values, stack traces, or full config (T5).
 */
function categorizeError(err: unknown): string {
  if (err instanceof Error) {
    // Use the class name as the category (e.g. "McpTimeoutError", "Error").
    // Allowlist: only safe-to-surface error names are returned verbatim.
    const name: string = err.name;
    const safeNames = new Set(["McpTimeoutError", "McpConnectionError", "McpToolError", "Error"]);
    return safeNames.has(name) ? name : "connection error";
  }
  return "unknown error";
}

/**
 * Parse the `mobile_list_apps` tool result and check if `bundleId` appears.
 *
 * The tool returns an array of app objects with a `bundleId` string field.
 * If the response shape is unexpected, returns `null` (unknown — do not fail readiness).
 *
 * Security: bundleId is used only as a comparison value — never echoed into error output.
 */
function extractAppLaunched(result: unknown, bundleId: string): boolean | null {
  if (!Array.isArray(result)) {
    return null;
  }
  for (const app of result) {
    if (
      typeof app === "object" &&
      app !== null &&
      "bundleId" in app &&
      (app as Record<string, unknown>)["bundleId"] === bundleId
    ) {
      return true;
    }
  }
  return false;
}
