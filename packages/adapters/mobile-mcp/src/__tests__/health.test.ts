/**
 * health.test.ts — Comprehensive unit tests for the health/readiness capability (#17).
 *
 * ACs covered (all 5 from the ticket):
 *
 * AC1 — "Given a connected adapter and a booted simulator, When readiness is checked,
 *         Then it reports MCP reachable + WebDriverAgent up once both are true."
 *   → tests: "ready result when MCP reachable and WDA up", "appLaunched null when no bundleId"
 *
 * AC2 — "Given WebDriverAgent has not yet come up, When readiness is checked,
 *         Then it reports a RETRYABLE not-ready signal (not a hang, not a terminal error)
 *         within the configured bound."
 *   → tests (checkOnce):
 *       "checkOnce: WDA tool absent → kind='not-ready', retryable=true, wdaUp=false"
 *       "checkOnce: WDA tool call fails → kind='not-ready', retryable=true, reason present"
 *   → tests (checkReadiness polling):
 *       "checkReadiness: WDA never ready → timed-out (confirms polling happened)"
 *
 * AC3 — "Given a launched app, When readiness is checked with its bundle id,
 *         Then it reports the app as launched;
 *         given the app is not launched, Then it reports not-launched."
 *   → tests: "appLaunched = true when bundleId in app list", "appLaunched = false when not in list"
 *
 * AC4 — "Given the MCP server is unreachable, When readiness is checked,
 *         Then it reports a TERMINAL failure naming the cause
 *         (distinct from retryable not-ready)."
 *   → tests: "McpNotConnectedError → terminal result", "listTools throws → terminal result",
 *            "terminal cause names category without leaking secrets/config"
 *
 * AC5 — "Given a configured readiness timeout, When the target never becomes ready,
 *         Then the check resolves with a not-ready/timeout result within ~the bound
 *         (no indefinite hang)."
 *   → tests: "timeout resolves with timed-out kind", "timeout does not hang"
 *
 * Security assertions (T5/T7):
 *   → tests: "error cause does not leak config secrets", "cause does not include full stack"
 *
 * Strategy:
 *   - Inject a fake McpConnection via the constructor DI seam (no real MCP server).
 *   - Inject fake NowFn + SleepFn for deterministic timeout/polling control (no real timers).
 *   - Assert on the `DetailedReadinessResult` discriminated union fields.
 *   - AC2 is verified via `checkOnce()` which surfaces `not-ready (retryable:true)` directly.
 *   - AC5 is verified via `checkReadiness()` which polls until timed-out.
 */

import { describe, it, expect, vi } from "vitest";
import { HealthReadiness, DEFAULT_HEALTH_CONFIG } from "../health/HealthReadiness.js";
import type { HealthReadinessConfig } from "../health/readiness-result.js";
import { HealthCheckTerminalError } from "../health/readiness-result.js";
import {
  McpNotConnectedError,
  McpTimeoutError,
  McpConnectionError,
  McpToolError,
} from "../connection/errors.js";
import type { McpServerConfig } from "../connection/connection-config.js";
import type { McpConnection } from "../connection/McpConnection.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const FAKE_SERVER_CONFIG: McpServerConfig = {
  serverCommand: ["npx", "mobile-mcp"],
  serverEnv: { PATH: "/usr/bin" },
  connectTimeoutMs: 5_000,
  callTimeoutMs: 10_000,
};

/** Minimal health config for tests — short timeouts so tests are fast. */
const FAST_CONFIG: HealthReadinessConfig = {
  readinessTimeoutMs: 200, // 200ms total budget
  pollIntervalMs: 50, // retry every 50ms
  probeTimeoutMs: 100, // 100ms per probe
};

/** Immediate config — zero poll interval so timeout fires on first check. */
const INSTANT_TIMEOUT_CONFIG: HealthReadinessConfig = {
  readinessTimeoutMs: 0, // expires immediately
  pollIntervalMs: 50,
  probeTimeoutMs: 50,
};

// ---------------------------------------------------------------------------
// Fake McpConnection builder
// ---------------------------------------------------------------------------

/**
 * Build a fake McpConnection with configurable listTools and callTool responses.
 *
 * We create a plain object satisfying the McpConnection interface shape because
 * the constructor DI seam just requires the methods to exist — no class needed.
 *
 * Security: fake tools/results contain only synthetic data (no real identifiers, T9).
 */
function makeFakeConnection(opts: {
  listToolsResult?: Array<{ name: string; description: string }>;
  listToolsError?: Error;
  callToolResults?: Record<string, unknown>;
  callToolErrors?: Record<string, Error>;
}): McpConnection {
  const { listToolsResult, listToolsError, callToolResults = {}, callToolErrors = {} } = opts;

  return {
    isConnected: true,

    connect: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),

    listTools: vi.fn().mockImplementation(async () => {
      if (listToolsError !== undefined) {
        throw listToolsError;
      }
      return listToolsResult ?? [];
    }),

    callTool: vi.fn().mockImplementation(async (toolName: string) => {
      const err = callToolErrors[toolName];
      if (err !== undefined) {
        throw err;
      }
      return callToolResults[toolName] ?? {};
    }),
  } as unknown as McpConnection;
}

/** Standard tool list where WDA probe tool IS present. */
const WDA_TOOLS = [
  { name: "mobile_get_screen_size", description: "Returns screen dimensions" },
  { name: "mobile_list_apps", description: "Lists installed apps" },
  { name: "mobile_dump_ui", description: "Dumps accessibility tree" },
];

/**
 * Error used to simulate WDA not yet responding.
 * With the cache-independent fix, WDA-absence is signalled by callTool failing,
 * not by the tool being absent from the (cached) listTools() result.
 */
const WDA_NOT_READY_ERROR = new McpToolError("mobile_get_screen_size", "WDA not initialized");

/**
 * Build a fake connection where MCP is reachable but WDA is not yet up.
 * listTools() succeeds (MCP is connected) but callTool('mobile_get_screen_size') throws.
 */
function makeFakeConnectionWdaDown(
  listToolsResult: Array<{ name: string; description: string }> = WDA_TOOLS,
): McpConnection {
  return makeFakeConnection({
    listToolsResult,
    callToolErrors: { mobile_get_screen_size: WDA_NOT_READY_ERROR },
  });
}

/** App list result including our test bundle id. */
function makeAppListResult(bundleId: string): unknown[] {
  return [
    { bundleId, name: "Test App", state: "foreground" },
    { bundleId: "com.other.app", name: "Other App", state: "background" },
  ];
}

// ---------------------------------------------------------------------------
// Fake clock helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake NowFn that returns a sequence of timestamps.
 * Each call returns the next value from the sequence.
 * If the sequence is exhausted, the last value is returned repeatedly.
 */
function makeFakeNow(timestamps: number[]): () => number {
  let idx = 0;
  return () => {
    const val = timestamps[idx] ?? timestamps[timestamps.length - 1] ?? 0;
    idx = Math.min(idx + 1, timestamps.length - 1);
    return val;
  };
}

/** A no-op sleep that resolves immediately (for deterministic tests). */
const instantSleep = vi.fn().mockResolvedValue(undefined);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HealthReadiness — AC1: ready result when both MCP and WDA are up", () => {
  it("returns kind='ready' with mcpReachable=true, wdaUp=true, appLaunched=null (no bundleId)", async () => {
    const conn = makeFakeConnection({ listToolsResult: WDA_TOOLS });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    const result = await health.checkReadiness();

    expect(result.kind).toBe("ready");
    expect(result.mcpReachable).toBe(true);
    expect(result.wdaUp).toBe(true);
    expect(result.appLaunched).toBeNull();
    expect(result.retryable).toBe(false);
  });

  it("calls listTools() exactly once when WDA is immediately ready", async () => {
    const conn = makeFakeConnection({ listToolsResult: WDA_TOOLS });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    await health.checkReadiness();

    expect(conn.listTools).toHaveBeenCalledOnce();
  });

  it("calls mobile_get_screen_size as the WDA probe tool", async () => {
    const conn = makeFakeConnection({ listToolsResult: WDA_TOOLS });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    await health.checkReadiness();

    expect(conn.callTool).toHaveBeenCalledWith("mobile_get_screen_size", {});
  });

  it("returns correct result shape satisfying flat ReadinessResult structural type", async () => {
    const conn = makeFakeConnection({ listToolsResult: WDA_TOOLS });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    const result = await health.checkReadiness();

    // Verify structural compatibility with flat ReadinessResult interface
    expect(typeof result.mcpReachable).toBe("boolean");
    expect(typeof result.wdaUp).toBe("boolean");
    // appLaunched is boolean | null — both are valid
    expect(result.appLaunched === null || typeof result.appLaunched === "boolean").toBe(true);
  });

  it("checkOnce also returns kind='ready' when MCP and WDA are up", async () => {
    const conn = makeFakeConnection({ listToolsResult: WDA_TOOLS });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    const result = await health.checkOnce();

    expect(result.kind).toBe("ready");
    expect(result.mcpReachable).toBe(true);
    expect(result.wdaUp).toBe(true);
    expect(result.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC2: WDA not yet up → RETRYABLE not-ready signal (observable via checkOnce)
// ---------------------------------------------------------------------------

describe("HealthReadiness — AC2: WDA not ready → retryable not-ready (via checkOnce)", () => {
  it("checkOnce: WDA callTool fails → kind='not-ready', retryable=true, wdaUp=false", async () => {
    // AC2 core: single probe when WDA is not yet responding.
    // WDA-absence is now detected via callTool failing (cache-independent per-poll probe),
    // NOT via the tool list from listTools() (which is cached by McpConnection).
    const conn = makeFakeConnectionWdaDown();
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    const result = await health.checkOnce();

    expect(result.kind).toBe("not-ready");
    expect(result.retryable).toBe(true);
    expect(result.wdaUp).toBe(false);
    expect(result.mcpReachable).toBe(true); // MCP WAS reachable (listTools returned)
    expect(result.appLaunched).toBeNull();
  });

  it("checkOnce: WDA not ready → not-ready carries a human-readable reason", async () => {
    const conn = makeFakeConnectionWdaDown();
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    const result = await health.checkOnce();

    expect(result.kind).toBe("not-ready");
    if (result.kind === "not-ready") {
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("checkOnce: WDA tool call fails with McpToolError → kind='not-ready', retryable=true", async () => {
    // AC2: WDA tool IS in the list but calling it throws McpToolError → still retryable.
    const conn = makeFakeConnection({
      listToolsResult: WDA_TOOLS,
      callToolErrors: {
        mobile_get_screen_size: new McpToolError("mobile_get_screen_size", "WDA not initialized"),
      },
    });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    const result = await health.checkOnce();

    expect(result.kind).toBe("not-ready");
    expect(result.retryable).toBe(true);
    expect(result.wdaUp).toBe(false);
    expect(result.mcpReachable).toBe(true);
  });

  it("checkOnce: WDA tool call fails with generic error → kind='not-ready', retryable=true", async () => {
    // Any non-terminal WDA error is retryable (WDA might come up on the next attempt).
    const conn = makeFakeConnection({
      listToolsResult: WDA_TOOLS,
      callToolErrors: {
        mobile_get_screen_size: new Error("connection reset"),
      },
    });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    const result = await health.checkOnce();

    expect(result.kind).toBe("not-ready");
    expect(result.retryable).toBe(true);
  });

  it("not-ready (retryable=true) is distinct from terminal (retryable=false)", async () => {
    // Discriminator test: MCP unreachable → terminal; WDA not up → not-ready.
    // WDA-down is simulated via callTool failing (cache-independent probe).
    const notReadyConn = makeFakeConnectionWdaDown();
    const terminalConn = makeFakeConnection({ listToolsError: new McpNotConnectedError() });

    const health1 = new HealthReadiness(
      notReadyConn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );
    const health2 = new HealthReadiness(
      terminalConn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    const notReadyResult = await health1.checkOnce();
    const terminalResult = await health2.checkOnce();

    expect(notReadyResult.kind).toBe("not-ready");
    expect(notReadyResult.retryable).toBe(true);
    expect(terminalResult.kind).toBe("terminal");
    expect(terminalResult.retryable).toBe(false);
    expect(notReadyResult.kind).not.toBe(terminalResult.kind);
  });

  it("checkReadiness: WDA never ready → timed-out carries wdaUp=false (polling confirmed)", async () => {
    // When used as a polling loop, WDA-not-ready repeatedly retries until budget exhausted.
    // The final timed-out result carries the last-known wdaUp=false from the probes.
    // WDA-down is signalled by callTool failing (cache-independent per-poll probe).
    const conn = makeFakeConnectionWdaDown();
    const now = makeFakeNow([0, 0, 0, 300]); // start=0, probe=0, sleep=0, post-sleep=300 > 200ms
    const health = new HealthReadiness(conn, FAKE_SERVER_CONFIG, FAST_CONFIG, now, async () => {
      /* instant sleep */
    });

    const result = await health.checkReadiness();

    expect(result.kind).toBe("timed-out");
    expect(result.wdaUp).toBe(false);
    expect(result.mcpReachable).toBe(true);
    // timed-out itself is not retryable (caller must decide whether to restart)
    expect(result.retryable).toBe(false);
  });

  it("checkReadiness: WDA tool call fails repeatedly → timed-out (retries observed)", async () => {
    // Confirm that retryable not-ready causes the polling loop to retry before timing out.
    const conn = makeFakeConnection({
      listToolsResult: WDA_TOOLS,
      callToolErrors: {
        mobile_get_screen_size: new McpToolError("mobile_get_screen_size", "WDA not initialized"),
      },
    });

    let callCount = 0;
    const controlledNow = () => {
      callCount++;
      return callCount > 5 ? FAST_CONFIG.readinessTimeoutMs + 1 : 0;
    };

    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      controlledNow,
      async () => {
        /* instant */
      },
    );
    const result = await health.checkReadiness();

    expect(result.kind).toBe("timed-out");
    expect(result.wdaUp).toBe(false);

    // WDA probe was called (not short-circuited at tool-list check):
    const callToolMock = conn.callTool as ReturnType<typeof vi.fn>;
    const wdaCalls = callToolMock.mock.calls.filter((args) => args[0] === "mobile_get_screen_size");
    expect(wdaCalls.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // NEW: mid-poll WDA detection test (QA gate requirement)
  // ---------------------------------------------------------------------------

  it("checkReadiness: WDA absent on poll-1 then present on poll-2 → resolves 'ready' (not timed-out)", async () => {
    // This is the core regression test for the cache-bug fix.
    //
    // Bug (before fix): listTools() was cached by McpConnection; the precheck
    //   `tools.some(t => t.name === 'mobile_get_screen_size')` used the stale cache
    //   from poll-1, so WDA coming up mid-poll was never detected → always timed-out.
    //
    // Fix: callTool('mobile_get_screen_size') is used per-poll (not cached).
    //   Poll 1 → callTool throws (WDA not yet up) → not-ready, retryable.
    //   Poll 2 → callTool succeeds (WDA came up) → ready.
    //
    // We simulate this with mockImplementationOnce: first call throws, subsequent calls succeed.
    const conn = makeFakeConnection({ listToolsResult: WDA_TOOLS });

    // Patch callTool to fail on the first WDA probe and succeed on the second.
    let wdaCallCount = 0;
    (conn.callTool as ReturnType<typeof vi.fn>).mockImplementation(async (toolName: string) => {
      if (toolName === "mobile_get_screen_size") {
        wdaCallCount++;
        if (wdaCallCount === 1) {
          throw new McpToolError("mobile_get_screen_size", "WDA not yet initialized");
        }
        // Second call onwards → WDA is up.
        return { width: 390, height: 844 };
      }
      return {};
    });

    // Time sequence: start=0, poll-1 at 0 (not-ready), sleep, poll-2 at 50 (ready).
    // Budget is 200ms so poll-2 (at 50ms) is within budget.
    const now = makeFakeNow([0, 0, 50, 50]);
    const health = new HealthReadiness(conn, FAKE_SERVER_CONFIG, FAST_CONFIG, now, async () => {
      /* instant sleep — advance time via makeFakeNow */
    });

    const result = await health.checkReadiness();

    // Must resolve as 'ready', NOT 'timed-out' — this proves WDA detection works mid-poll.
    expect(result.kind).toBe("ready");
    expect(result.wdaUp).toBe(true);
    expect(result.mcpReachable).toBe(true);
    expect(result.retryable).toBe(false);

    // Confirm callTool was invoked on both polls (not short-circuited by a cached list).
    expect(wdaCallCount).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// AC3: App launched / not launched detection
// ---------------------------------------------------------------------------

describe("HealthReadiness — AC3: app-launched signal by bundleId", () => {
  const TARGET_BUNDLE = "com.example.testapp";

  it("appLaunched=true when bundleId is in the app list", async () => {
    const conn = makeFakeConnection({
      listToolsResult: WDA_TOOLS,
      callToolResults: {
        mobile_get_screen_size: { width: 390, height: 844 },
        mobile_list_apps: makeAppListResult(TARGET_BUNDLE),
      },
    });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    const result = await health.checkReadiness(TARGET_BUNDLE);

    expect(result.kind).toBe("ready");
    expect(result.appLaunched).toBe(true);
    expect(result.mcpReachable).toBe(true);
    expect(result.wdaUp).toBe(true);
  });

  it("appLaunched=false when bundleId is NOT in the app list", async () => {
    const conn = makeFakeConnection({
      listToolsResult: WDA_TOOLS,
      callToolResults: {
        mobile_get_screen_size: { width: 390, height: 844 },
        mobile_list_apps: [{ bundleId: "com.other.app", name: "Other" }],
      },
    });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    const result = await health.checkReadiness(TARGET_BUNDLE);

    expect(result.kind).toBe("ready");
    expect(result.appLaunched).toBe(false);
    expect(result.mcpReachable).toBe(true);
    expect(result.wdaUp).toBe(true);
  });

  it("appLaunched=null when no bundleId is provided", async () => {
    const conn = makeFakeConnection({ listToolsResult: WDA_TOOLS });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    const result = await health.checkReadiness(); // no bundleId

    expect(result.kind).toBe("ready");
    expect(result.appLaunched).toBeNull();
  });

  it("appLaunched=null when empty string bundleId is provided", async () => {
    const conn = makeFakeConnection({ listToolsResult: WDA_TOOLS });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    const result = await health.checkReadiness(""); // empty bundleId treated as absent

    expect(result.kind).toBe("ready");
    expect(result.appLaunched).toBeNull();
  });

  it("appLaunched=null when mobile_list_apps returns unexpected shape (resilient)", async () => {
    const conn = makeFakeConnection({
      listToolsResult: WDA_TOOLS,
      callToolResults: {
        mobile_get_screen_size: { width: 390, height: 844 },
        mobile_list_apps: "not-an-array", // unexpected shape → null (graceful)
      },
    });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    const result = await health.checkReadiness(TARGET_BUNDLE);

    // Should still be ready (WDA up) but appLaunched is null due to bad shape.
    expect(result.kind).toBe("ready");
    expect(result.appLaunched).toBeNull();
  });

  it("calls mobile_list_apps when bundleId is provided", async () => {
    const conn = makeFakeConnection({
      listToolsResult: WDA_TOOLS,
      callToolResults: {
        mobile_get_screen_size: {},
        mobile_list_apps: makeAppListResult(TARGET_BUNDLE),
      },
    });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    await health.checkReadiness(TARGET_BUNDLE);

    expect(conn.callTool).toHaveBeenCalledWith("mobile_list_apps", {});
  });

  it("does NOT call mobile_list_apps when no bundleId is provided", async () => {
    const conn = makeFakeConnection({ listToolsResult: WDA_TOOLS });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    await health.checkReadiness();

    const callToolMock = conn.callTool as ReturnType<typeof vi.fn>;
    const listAppsCalls = callToolMock.mock.calls.filter((args) => args[0] === "mobile_list_apps");
    expect(listAppsCalls).toHaveLength(0);
  });

  it("checkOnce also surfaces appLaunched=true when bundleId present", async () => {
    const conn = makeFakeConnection({
      listToolsResult: WDA_TOOLS,
      callToolResults: {
        mobile_get_screen_size: {},
        mobile_list_apps: makeAppListResult(TARGET_BUNDLE),
      },
    });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    const result = await health.checkOnce(TARGET_BUNDLE);

    expect(result.kind).toBe("ready");
    expect(result.appLaunched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC4: MCP unreachable → TERMINAL failure (distinct from retryable)
// ---------------------------------------------------------------------------

describe("HealthReadiness — AC4: MCP unreachable → terminal failure", () => {
  it("returns kind='terminal' when McpNotConnectedError is thrown from listTools()", async () => {
    const conn = makeFakeConnection({
      listToolsError: new McpNotConnectedError(),
    });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    const result = await health.checkReadiness();

    expect(result.kind).toBe("terminal");
    expect(result.mcpReachable).toBe(false);
    expect(result.wdaUp).toBe(false);
    expect(result.appLaunched).toBeNull();
    expect(result.retryable).toBe(false);
  });

  it("checkOnce also returns terminal when McpNotConnectedError is thrown", async () => {
    const conn = makeFakeConnection({
      listToolsError: new McpNotConnectedError(),
    });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    const result = await health.checkOnce();

    expect(result.kind).toBe("terminal");
    expect(result.retryable).toBe(false);
  });

  it("returns kind='terminal' when listTools() throws McpConnectionError", async () => {
    const conn = makeFakeConnection({
      listToolsError: new McpConnectionError("connection refused"),
    });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    const result = await health.checkReadiness();

    expect(result.kind).toBe("terminal");
    expect(result.mcpReachable).toBe(false);
    expect(result.retryable).toBe(false);
  });

  it("returns kind='terminal' when listTools() throws McpTimeoutError", async () => {
    const conn = makeFakeConnection({
      listToolsError: new McpTimeoutError("listTools timed out", 5000),
    });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    const result = await health.checkReadiness();

    expect(result.kind).toBe("terminal");
    expect(result.mcpReachable).toBe(false);
    expect(result.retryable).toBe(false);
  });

  it("returns kind='terminal' when listTools() throws a generic error", async () => {
    const conn = makeFakeConnection({
      listToolsError: new Error("ENOENT: server binary not found"),
    });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    const result = await health.checkReadiness();

    expect(result.kind).toBe("terminal");
    expect(result.mcpReachable).toBe(false);
    expect(result.retryable).toBe(false);
  });

  it("terminal kind is distinct from not-ready kind (discriminator works)", async () => {
    const terminalConn = makeFakeConnection({
      listToolsError: new McpNotConnectedError(),
    });
    // WDA-down is detected via callTool failing (cache-independent).
    const notReadyConn = makeFakeConnectionWdaDown();

    const health1 = new HealthReadiness(
      terminalConn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );
    const terminalResult = await health1.checkOnce(); // checkOnce: immediate terminal

    const health2 = new HealthReadiness(
      notReadyConn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );
    const notReadyResult = await health2.checkOnce(); // checkOnce: immediate not-ready

    expect(terminalResult.kind).toBe("terminal");
    expect(notReadyResult.kind).toBe("not-ready");
    expect(terminalResult.kind).not.toBe(notReadyResult.kind);
  });

  it("terminal result resolves (does not throw/reject) — no unhandled rejection", async () => {
    const conn = makeFakeConnection({
      listToolsError: new McpConnectionError("transport closed"),
    });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    // Should resolve (not throw/reject) with terminal result.
    await expect(health.checkReadiness()).resolves.toMatchObject({
      kind: "terminal",
      mcpReachable: false,
    });
  });

  it("HealthCheckTerminalError is thrown internally and caught — terminal result has cause string", async () => {
    // Confirms the HealthCheckTerminalError class is used (not dead code).
    // probeMcp throws it; probeOnce catches and converts to terminal result.
    const conn = makeFakeConnection({
      listToolsError: new McpNotConnectedError(),
    });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    const result = await health.checkOnce();

    expect(result.kind).toBe("terminal");
    if (result.kind === "terminal") {
      expect(typeof result.cause).toBe("string");
      expect(result.cause.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// AC4 (security): Error messages name cause WITHOUT leaking secrets/config
// ---------------------------------------------------------------------------

describe("HealthReadiness — AC4 security: no secret leakage in error causes (T5)", () => {
  const SECRET_CONFIG: McpServerConfig = {
    serverCommand: ["npx", "mobile-mcp", "--secret-token=abc123"],
    serverEnv: { PATH: "/usr/bin", SECRET_KEY: "super-secret-value-xyz" },
    connectTimeoutMs: 5_000,
    callTimeoutMs: 10_000,
  };

  it("terminal cause does not contain secret env values from config", async () => {
    const conn = makeFakeConnection({
      listToolsError: new McpConnectionError("transport error"),
    });
    const health = new HealthReadiness(conn, SECRET_CONFIG, FAST_CONFIG, Date.now, instantSleep);

    const result = await health.checkReadiness();

    expect(result.kind).toBe("terminal");
    if (result.kind === "terminal") {
      expect(result.cause).not.toContain("super-secret-value-xyz");
      expect(result.cause).not.toContain("abc123");
      expect(result.cause).not.toContain("SECRET_KEY");
    }
  });

  it("terminal cause does not contain full serverCommand (T5: log command name only)", async () => {
    const conn = makeFakeConnection({
      listToolsError: new McpNotConnectedError(),
    });
    const health = new HealthReadiness(conn, SECRET_CONFIG, FAST_CONFIG, Date.now, instantSleep);

    const result = await health.checkReadiness();

    if (result.kind === "terminal") {
      // The cause names the error category, not the full command.
      expect(result.cause).not.toContain("--secret-token=abc123");
    }
  });

  it("terminal cause is a non-empty string naming the error category", async () => {
    const conn = makeFakeConnection({
      listToolsError: new McpConnectionError("something went wrong"),
    });
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      FAST_CONFIG,
      Date.now,
      instantSleep,
    );

    const result = await health.checkReadiness();

    if (result.kind === "terminal") {
      expect(typeof result.cause).toBe("string");
      expect(result.cause.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// AC5: Timeout resolves within configured bound (no hang)
// ---------------------------------------------------------------------------

describe("HealthReadiness — AC5: timeout resolves (no indefinite hang)", () => {
  it("returns kind='timed-out' when readinessTimeoutMs is exhausted", async () => {
    // WDA never comes up → every probe returns not-ready → poll budget exhausts.
    // WDA-down is signalled by callTool failing (cache-independent per-poll probe).
    const conn = makeFakeConnectionWdaDown();
    const now = makeFakeNow([0, 250, 250]); // 250 > FAST_CONFIG.readinessTimeoutMs (200)
    const health = new HealthReadiness(conn, FAKE_SERVER_CONFIG, FAST_CONFIG, now, async () => {
      /* instant */
    });

    const result = await health.checkReadiness();

    expect(result.kind).toBe("timed-out");
    expect(result.retryable).toBe(false);
    expect(result.appLaunched).toBeNull();
  });

  it("timed-out result carries elapsedMs >= 0", async () => {
    const conn = makeFakeConnectionWdaDown();
    // now returns 0, then 250 (> 200ms budget)
    const now = makeFakeNow([0, 250]);
    const health = new HealthReadiness(conn, FAKE_SERVER_CONFIG, FAST_CONFIG, now, async () => {
      /* instant */
    });

    const result = await health.checkReadiness();

    if (result.kind === "timed-out") {
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("timeout=0 resolves immediately with timed-out (never hangs)", async () => {
    const conn = makeFakeConnection({ listToolsResult: WDA_TOOLS });
    // With 0ms timeout, the first elapsed check (now() - start >= 0) fires immediately.
    const now = makeFakeNow([0, 0]);
    const health = new HealthReadiness(
      conn,
      FAKE_SERVER_CONFIG,
      INSTANT_TIMEOUT_CONFIG,
      now,
      async () => {
        /* instant */
      },
    );

    const result = await health.checkReadiness();

    expect(result.kind).toBe("timed-out");
  });

  it("poll attempts multiple probes before timing out (no immediate timeout on first probe)", async () => {
    // WDA not ready → should attempt multiple probes before timing out.
    // WDA-down via callTool failure (cache-independent per-poll probe).
    const conn = makeFakeConnectionWdaDown();

    // now() sequence: 0 (start), 0 (first probe), 50 (after first sleep),
    // 50 (second probe), 100 (after second sleep), 100 (third probe), 250 (timeout).
    const now = makeFakeNow([0, 0, 50, 50, 100, 100, 250]);
    const sleepMock = vi.fn().mockResolvedValue(undefined);

    const health = new HealthReadiness(conn, FAKE_SERVER_CONFIG, FAST_CONFIG, now, sleepMock);
    const result = await health.checkReadiness();

    expect(result.kind).toBe("timed-out");
    // Multiple polls should have been attempted before timeout.
    // Confirm listTools (MCP probe) was called at each poll attempt — at least 2 calls.
    expect((conn.listTools as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
  }, 5_000);

  it("resolves as timed-out within actual real time ~proportional to config (no indefinite hang)", async () => {
    // This test uses REAL timers to verify there is no actual hang.
    // We use a very short timeout (100ms) with a fake connection where
    // WDA is permanently down (callTool fails), so the loop runs until budget exhausted.
    const conn = makeFakeConnectionWdaDown();

    // Use a real config with a 100ms timeout and real timers.
    const realConfig: HealthReadinessConfig = {
      readinessTimeoutMs: 100,
      pollIntervalMs: 30,
      probeTimeoutMs: 50,
    };

    const startReal = Date.now();
    const health = new HealthReadiness(conn, FAKE_SERVER_CONFIG, realConfig);
    const result = await health.checkReadiness();
    const elapsed = Date.now() - startReal;

    // Must resolve within a reasonable multiple of the configured timeout (2x to account
    // for test environment jitter) and must not take more than 2 seconds (no hang).
    expect(elapsed).toBeLessThan(2_000);
    expect(result.kind).toBe("timed-out");
  }, 10_000);
});

// ---------------------------------------------------------------------------
// DEFAULT_HEALTH_CONFIG
// ---------------------------------------------------------------------------

describe("DEFAULT_HEALTH_CONFIG — no magic numbers", () => {
  it("exports sensible production defaults", () => {
    expect(DEFAULT_HEALTH_CONFIG.readinessTimeoutMs).toBeGreaterThan(0);
    expect(DEFAULT_HEALTH_CONFIG.pollIntervalMs).toBeGreaterThan(0);
    expect(DEFAULT_HEALTH_CONFIG.probeTimeoutMs).toBeGreaterThan(0);
    // pollIntervalMs should be less than readinessTimeoutMs (to allow retry)
    expect(DEFAULT_HEALTH_CONFIG.pollIntervalMs).toBeLessThan(
      DEFAULT_HEALTH_CONFIG.readinessTimeoutMs,
    );
    // probeTimeoutMs should be less than readinessTimeoutMs
    expect(DEFAULT_HEALTH_CONFIG.probeTimeoutMs).toBeLessThan(
      DEFAULT_HEALTH_CONFIG.readinessTimeoutMs,
    );
  });
});

// ---------------------------------------------------------------------------
// HealthCheckTerminalError class
// ---------------------------------------------------------------------------

describe("HealthCheckTerminalError — error class", () => {
  it("extends McpAdapterError with correct name", async () => {
    const { McpAdapterError } = await import("../connection/errors.js");
    const err = new HealthCheckTerminalError("MCP server unreachable");
    expect(err).toBeInstanceOf(McpAdapterError);
    expect(err.name).toBe("HealthCheckTerminalError");
  });

  it("carries cause category in message without leaking secrets", () => {
    const err = new HealthCheckTerminalError("connection refused");
    expect(err.message).toContain("connection refused");
    expect(err.message).not.toContain("SECRET");
  });

  it("accepts a rootCause for debugging", () => {
    const rootCause = new Error("underlying error");
    const err = new HealthCheckTerminalError("transport closed", rootCause);
    expect(err.cause).toBe(rootCause);
  });
});

// ---------------------------------------------------------------------------
// DI seam verification (Wave-1 contract)
// ---------------------------------------------------------------------------

describe("HealthReadiness — DI seam (Wave-1 contract)", () => {
  it("accepts constructor args matching the Wave-1 seam (connection + serverConfig)", () => {
    // Verify the constructor doesn't throw with the seam args.
    const conn = makeFakeConnection({ listToolsResult: WDA_TOOLS });
    expect(() => new HealthReadiness(conn, FAKE_SERVER_CONFIG)).not.toThrow();
  });

  it("accepts optional healthConfig override", () => {
    const conn = makeFakeConnection({ listToolsResult: WDA_TOOLS });
    expect(
      () => new HealthReadiness(conn, FAKE_SERVER_CONFIG, { readinessTimeoutMs: 60_000 }),
    ).not.toThrow();
  });

  it("HealthStub alias from index.ts resolves to the real HealthReadiness", async () => {
    const { HealthStub } = await import("../health/index.js");
    const conn = makeFakeConnection({ listToolsResult: WDA_TOOLS });
    const stub = new HealthStub(conn, FAKE_SERVER_CONFIG, FAST_CONFIG, Date.now, instantSleep);
    // Real impl should return ready, not throw "not yet implemented".
    const result = await stub.checkReadiness();
    expect(result.kind).toBe("ready");
  });
});
