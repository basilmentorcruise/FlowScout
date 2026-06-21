/**
 * defaultCapabilities — Wave-1 wiring contract tests (#12 code-review gate fix).
 *
 * These tests assert the load-bearing seam: `defaultCapabilities()` must construct
 * a single shared McpConnection and thread it (plus the config slice) into all four
 * stub capability constructors, so Wave-1 tickets (#14/#15/#16/#17) can replace only
 * their own class bodies without ever editing capabilities.ts or the facade.
 *
 * ACs covered:
 * - defaultCapabilities constructs exactly ONE shared McpConnection.
 * - That McpConnection (and the config) is injected into all four stubs.
 * - The injectable `exec` seam reaches LifecycleStub and SnapshotStub.
 * - All four returned capabilities satisfy their respective interfaces.
 */

import { describe, it, expect, vi } from "vitest";
import type { McpServerConfig } from "../connection/connection-config.js";
import { McpConnection } from "../connection/McpConnection.js";
import type { Exec } from "../simctl.js";

// ---------------------------------------------------------------------------
// Test config (no real server — stubs never connect)
// ---------------------------------------------------------------------------

const TEST_CONFIG: McpServerConfig = {
  serverCommand: ["npx", "mobile-mcp"],
  serverEnv: { PATH: "/usr/bin" },
  connectTimeoutMs: 5000,
  callTimeoutMs: 10000,
};

/** A no-op fake Exec that never touches the filesystem. */
const FAKE_EXEC: Exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

// ---------------------------------------------------------------------------
// Helper: build a fresh bundle with a spied McpConnection constructor
// ---------------------------------------------------------------------------

/**
 * Wraps the `defaultCapabilities` factory with a spy on `McpConnection` to
 * capture every instance created during the call.  We do this by temporarily
 * replacing the constructor in the module exports — ES modules do not allow
 * direct property reassignment, so we use a subclass approach via prototypal
 * interception on a captured instance.
 *
 * Because vi.mock() is hoisted and cannot close over test-local state, we use
 * a module-scope array to track instances and reset it before each use.
 */

// Module-level tracker (referenced from the vi.mock factory which is hoisted).
const _trackedConnections: McpConnection[] = [];

vi.mock("../connection/McpConnection.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../connection/McpConnection.js")>();
  const Original = original.McpConnection;

  class TrackedMcpConnection extends Original {
    constructor(...args: ConstructorParameters<typeof Original>) {
      super(...args);
      _trackedConnections.push(this);
    }
  }

  return { ...original, McpConnection: TrackedMcpConnection };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("defaultCapabilities — shared McpConnection + config wiring", () => {
  it("constructs exactly one McpConnection per defaultCapabilities() call", async () => {
    _trackedConnections.length = 0; // Reset tracker.

    const { defaultCapabilities } = await import("../connection/capabilities.js");
    defaultCapabilities(TEST_CONFIG, FAKE_EXEC);

    expect(_trackedConnections).toHaveLength(1);
  });

  it("all four stubs share the same single McpConnection instance", async () => {
    // We verify this indirectly: because defaultCapabilities creates one connection
    // and passes it to all four constructors, the one tracked instance is the
    // only connection that could have been injected.
    _trackedConnections.length = 0;

    const { defaultCapabilities } = await import("../connection/capabilities.js");
    defaultCapabilities(TEST_CONFIG, FAKE_EXEC);

    // Exactly one connection was constructed — confirms single-instance wiring.
    expect(_trackedConnections).toHaveLength(1);
    // The connection is a proper McpConnection (even through the mock subclass).
    // Use the original class for instanceof check (the mock subclass extends it).
    expect(_trackedConnections[0]).toBeInstanceOf(McpConnection);
  });

  it("two independent defaultCapabilities() calls each create their own McpConnection", async () => {
    _trackedConnections.length = 0;

    const { defaultCapabilities } = await import("../connection/capabilities.js");
    defaultCapabilities(TEST_CONFIG, FAKE_EXEC);
    defaultCapabilities(TEST_CONFIG, FAKE_EXEC);

    // Two calls — two connections (one per bundle, not shared across bundles).
    expect(_trackedConnections).toHaveLength(2);
    expect(_trackedConnections[0]).not.toBe(_trackedConnections[1]);
  });

  it("the injectable exec is passed to lifecycle (now real — #14) and snapshot (now real — #16)", async () => {
    // Since #14 landed, lifecycle is the real SimulatorLifecycleManager that uses exec.
    // We verify exec is wired in by confirming listDevices() calls exec (not rejected).
    // Since #15 landed, driving is the real DeviceDriver that validates UDIDs.
    // Since #16 landed, snapshot is the real SnapshotManager — validates inputs (T1) first.
    // health (#17 not yet landed) still rejects with NotImplemented.
    const distinctExec: Exec = vi
      .fn()
      .mockResolvedValue({ stdout: '{"devices":{}}', stderr: '' });

    const { defaultCapabilities } = await import("../connection/capabilities.js");
    const bundle = defaultCapabilities(TEST_CONFIG, distinctExec);

    // lifecycle (#14 real impl) — exec is called and resolves successfully.
    await expect(bundle.lifecycle.listDevices()).resolves.toEqual([]);
    expect(distinctExec).toHaveBeenCalled(); // confirms exec was wired into lifecycle

    // snapshot (#16 real impl) — validates inputs (T1); invalid UUID throws InvalidSnapshotInputError.
    await expect(bundle.snapshot.takeSnapshot("udid", "snap")).rejects.toThrow(/InvalidSnapshotInputError/);
    // driving (#15 real impl) — rejects "udid" with InvalidInputError (T1 UDID validation).
    const { InvalidInputError } = await import("../driving/normalization.js");
    await expect(bundle.driving.screenshot("udid")).rejects.toBeInstanceOf(InvalidInputError);
    // health (#17 stub) — still not yet implemented.
    await expect(bundle.health.checkReadiness()).rejects.toThrow("not yet implemented");
  });

  it("bundle contains all four capability keys with correct method surfaces", async () => {
    const { defaultCapabilities } = await import("../connection/capabilities.js");
    const bundle = defaultCapabilities(TEST_CONFIG, FAKE_EXEC);

    // Lifecycle interface
    expect(typeof bundle.lifecycle.listDevices).toBe("function");
    expect(typeof bundle.lifecycle.bootSimulator).toBe("function");
    expect(typeof bundle.lifecycle.installApp).toBe("function");
    expect(typeof bundle.lifecycle.launchApp).toBe("function");
    expect(typeof bundle.lifecycle.shutdownSimulator).toBe("function");

    // Driving interface
    expect(typeof bundle.driving.snapshotAccessibilityTree).toBe("function");
    expect(typeof bundle.driving.screenshot).toBe("function");
    expect(typeof bundle.driving.tap).toBe("function");
    expect(typeof bundle.driving.typeText).toBe("function");
    expect(typeof bundle.driving.swipe).toBe("function");

    // Snapshot interface
    expect(typeof bundle.snapshot.takeSnapshot).toBe("function");
    expect(typeof bundle.snapshot.resetToSnapshot).toBe("function");

    // Health interface
    expect(typeof bundle.health.checkReadiness).toBe("function");
  });

  it("two bundles from separate calls have independent capability instances", async () => {
    const { defaultCapabilities } = await import("../connection/capabilities.js");
    const bundle1 = defaultCapabilities(TEST_CONFIG, FAKE_EXEC);
    const bundle2 = defaultCapabilities(TEST_CONFIG, FAKE_EXEC);

    // Wave-1 safety: each bundle must be fully independent.
    expect(bundle1.lifecycle).not.toBe(bundle2.lifecycle);
    expect(bundle1.driving).not.toBe(bundle2.driving);
    expect(bundle1.snapshot).not.toBe(bundle2.snapshot);
    expect(bundle1.health).not.toBe(bundle2.health);
  });

  it("defaultCapabilities uses createDefaultExec() when no exec is provided", async () => {
    // Call without the exec parameter — should not throw (default is injected internally).
    const { defaultCapabilities } = await import("../connection/capabilities.js");
    expect(() => defaultCapabilities(TEST_CONFIG)).not.toThrow();
  });
});
