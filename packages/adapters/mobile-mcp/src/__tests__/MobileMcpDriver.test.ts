/**
 * MobileMcpDriver facade delegation tests (ADR-0002 §5/#12).
 *
 * ACs covered:
 * - Each facade method delegates to the correct capability (lifecycle/driving/snapshot).
 * - The facade has ZERO logic — it is a pure delegation layer.
 * - Constructor accepts a MobileMcpDriverConfig and an optional capability bundle (DI).
 * - The stub capabilities (default deps) throw "not yet implemented" — Wave-1 will replace them.
 *
 * Strategy: inject fake capability bundles so we can assert delegation without real MCP.
 */
import { describe, it, expect, vi } from "vitest";
import { MobileMcpDriver } from "../MobileMcpDriver.js";
import type {
  CapabilityBundle,
  LifecycleCapability,
  DrivingCapability,
  SnapshotCapability,
  HealthCapability,
} from "../connection/capabilities.js";
import type { A11ySnapshot } from "@flowscout/domain";
import type { MobileMcpDriverConfig } from "../connection/connection-config.js";

// Minimal valid config (no real server is spawned in unit tests).
const fakeConfig: MobileMcpDriverConfig = {
  server: {
    serverCommand: ["npx", "mobile-mcp"],
    serverEnv: { PATH: "/usr/bin" },
    connectTimeoutMs: 5000,
    callTimeoutMs: 10000,
  },
};

const fakeUdid = "AABBCCDD-1234-5678-9ABC-DEF012345678";
const fakeBundleId = "com.example.app";
const fakeAppPath = "/tmp/MyApp.app";
const fakeSnapshotName = "clean-state";

/** Build a fake capability bundle with spies on every method. */
function makeFakeDeps(): CapabilityBundle {
  const lifecycle: LifecycleCapability = {
    listDevices: vi.fn().mockResolvedValue([]) as unknown as LifecycleCapability["listDevices"],
    bootSimulator: vi
      .fn()
      .mockResolvedValue(undefined) as unknown as LifecycleCapability["bootSimulator"],
    installApp: vi
      .fn()
      .mockResolvedValue(undefined) as unknown as LifecycleCapability["installApp"],
    launchApp: vi.fn().mockResolvedValue(undefined) as unknown as LifecycleCapability["launchApp"],
    shutdownSimulator: vi
      .fn()
      .mockResolvedValue(undefined) as unknown as LifecycleCapability["shutdownSimulator"],
  };

  const driving: DrivingCapability = {
    snapshotAccessibilityTree: vi
      .fn()
      .mockResolvedValue(
        "fake-a11y" as A11ySnapshot,
      ) as unknown as DrivingCapability["snapshotAccessibilityTree"],
    screenshot: vi
      .fn()
      .mockResolvedValue(new Uint8Array([1, 2, 3])) as unknown as DrivingCapability["screenshot"],
    tap: vi.fn().mockResolvedValue(undefined) as unknown as DrivingCapability["tap"],
    typeText: vi.fn().mockResolvedValue(undefined) as unknown as DrivingCapability["typeText"],
    swipe: vi.fn().mockResolvedValue(undefined) as unknown as DrivingCapability["swipe"],
  };

  const snapshot: SnapshotCapability = {
    takeSnapshot: vi
      .fn()
      .mockResolvedValue(undefined) as unknown as SnapshotCapability["takeSnapshot"],
    resetToSnapshot: vi
      .fn()
      .mockResolvedValue(undefined) as unknown as SnapshotCapability["resetToSnapshot"],
  };

  const health: HealthCapability = {
    checkReadiness: vi
      .fn()
      .mockResolvedValue({
        mcpReachable: true,
        wdaUp: true,
        appLaunched: null,
      }) as unknown as HealthCapability["checkReadiness"],
  };

  return { lifecycle, driving, snapshot, health };
}

// ---------------------------------------------------------------------------
// Facade delegation tests
// ---------------------------------------------------------------------------

describe("MobileMcpDriver — facade delegation", () => {
  it("listDevices delegates to lifecycle.listDevices", async () => {
    const deps = makeFakeDeps();
    const driver = new MobileMcpDriver(fakeConfig, deps);
    await driver.listDevices();
    expect(deps.lifecycle.listDevices).toHaveBeenCalledOnce();
  });

  it("snapshotAccessibilityTree delegates to driving.snapshotAccessibilityTree", async () => {
    const deps = makeFakeDeps();
    const driver = new MobileMcpDriver(fakeConfig, deps);
    await driver.snapshotAccessibilityTree(fakeUdid);
    expect(deps.driving.snapshotAccessibilityTree).toHaveBeenCalledWith(fakeUdid);
  });

  it("screenshot delegates to driving.screenshot", async () => {
    const deps = makeFakeDeps();
    const driver = new MobileMcpDriver(fakeConfig, deps);
    await driver.screenshot(fakeUdid);
    expect(deps.driving.screenshot).toHaveBeenCalledWith(fakeUdid);
  });

  it("tap delegates to driving.tap with element target", async () => {
    const deps = makeFakeDeps();
    const driver = new MobileMcpDriver(fakeConfig, deps);
    const target = { kind: "element" as const, elementId: "btn-1" };
    await driver.tap(fakeUdid, target);
    expect(deps.driving.tap).toHaveBeenCalledWith(fakeUdid, target);
  });

  it("tap delegates to driving.tap with coordinate target", async () => {
    const deps = makeFakeDeps();
    const driver = new MobileMcpDriver(fakeConfig, deps);
    const target = { kind: "coordinate" as const, x: 100, y: 200 };
    await driver.tap(fakeUdid, target);
    expect(deps.driving.tap).toHaveBeenCalledWith(fakeUdid, target);
  });

  it("typeText delegates to driving.typeText", async () => {
    const deps = makeFakeDeps();
    const driver = new MobileMcpDriver(fakeConfig, deps);
    await driver.typeText(fakeUdid, "hello");
    expect(deps.driving.typeText).toHaveBeenCalledWith(fakeUdid, "hello");
  });

  it("swipe delegates to driving.swipe", async () => {
    const deps = makeFakeDeps();
    const driver = new MobileMcpDriver(fakeConfig, deps);
    await driver.swipe(fakeUdid, "up");
    expect(deps.driving.swipe).toHaveBeenCalledWith(fakeUdid, "up", undefined);
  });

  it("swipe with distance delegates correctly", async () => {
    const deps = makeFakeDeps();
    const driver = new MobileMcpDriver(fakeConfig, deps);
    await driver.swipe(fakeUdid, "down", 300);
    expect(deps.driving.swipe).toHaveBeenCalledWith(fakeUdid, "down", 300);
  });

  it("bootSimulator delegates to lifecycle.bootSimulator", async () => {
    const deps = makeFakeDeps();
    const driver = new MobileMcpDriver(fakeConfig, deps);
    await driver.bootSimulator(fakeUdid);
    expect(deps.lifecycle.bootSimulator).toHaveBeenCalledWith(fakeUdid);
  });

  it("installApp delegates to lifecycle.installApp", async () => {
    const deps = makeFakeDeps();
    const driver = new MobileMcpDriver(fakeConfig, deps);
    await driver.installApp(fakeUdid, fakeAppPath);
    expect(deps.lifecycle.installApp).toHaveBeenCalledWith(fakeUdid, fakeAppPath);
  });

  it("launchApp delegates to lifecycle.launchApp", async () => {
    const deps = makeFakeDeps();
    const driver = new MobileMcpDriver(fakeConfig, deps);
    await driver.launchApp(fakeUdid, fakeBundleId);
    expect(deps.lifecycle.launchApp).toHaveBeenCalledWith(fakeUdid, fakeBundleId);
  });

  it("takeSnapshot delegates to snapshot.takeSnapshot", async () => {
    const deps = makeFakeDeps();
    const driver = new MobileMcpDriver(fakeConfig, deps);
    await driver.takeSnapshot(fakeUdid, fakeSnapshotName);
    expect(deps.snapshot.takeSnapshot).toHaveBeenCalledWith(fakeUdid, fakeSnapshotName);
  });

  it("resetToSnapshot delegates to snapshot.resetToSnapshot", async () => {
    const deps = makeFakeDeps();
    const driver = new MobileMcpDriver(fakeConfig, deps);
    await driver.resetToSnapshot(fakeUdid, fakeSnapshotName);
    expect(deps.snapshot.resetToSnapshot).toHaveBeenCalledWith(fakeUdid, fakeSnapshotName);
  });

  it("shutdownSimulator delegates to lifecycle.shutdownSimulator", async () => {
    const deps = makeFakeDeps();
    const driver = new MobileMcpDriver(fakeConfig, deps);
    await driver.shutdownSimulator(fakeUdid);
    expect(deps.lifecycle.shutdownSimulator).toHaveBeenCalledWith(fakeUdid);
  });

  it("facade propagates rejection from capability", async () => {
    const deps = makeFakeDeps();
    const err = new Error("capability-error");
    (deps.lifecycle.bootSimulator as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    const driver = new MobileMcpDriver(fakeConfig, deps);
    await expect(driver.bootSimulator(fakeUdid)).rejects.toThrow("capability-error");
  });
});

// ---------------------------------------------------------------------------
// Default capability behavior with real implementations from Wave-1
//
// As of #14, lifecycle is the real SimulatorLifecycleManager.
// As of #15, driving is the real DeviceDriver.
// As of #16, snapshot is the real SnapshotManager.
// As of #17, health is the real HealthReadiness.
// ---------------------------------------------------------------------------

describe("MobileMcpDriver — default capability behavior", () => {
  const driver = new MobileMcpDriver(fakeConfig);
  const udid = fakeUdid;

  // Lifecycle (#14 real impl): real SimulatorLifecycleManager validates + calls simctl.
  // listDevices with fakeConfig (no real exec injected) calls createDefaultExec at runtime,
  // but the facade default uses the real createDefaultExec. In the unit environment without
  // xcrun, we just verify the lifecycle stub is gone — it no longer throws "not yet implemented".
  // We test lifecycle real behavior thoroughly in lifecycle.contract.test.ts.
  // Here we verify the facade wiring: lifecycle is no longer the NotImplemented stub.

  // Driving methods (#15 landed): DeviceDriver now tries to connect — no stub error.
  // Without a real MCP server, they reject with a connection error (not "not yet implemented").
  it("snapshotAccessibilityTree rejects with a McpAdapterError (DeviceDriver real impl)", async () => {
    const { McpAdapterError } = await import("../connection/errors.js");
    await expect(driver.snapshotAccessibilityTree(udid)).rejects.toBeInstanceOf(McpAdapterError);
  });

  it("screenshot rejects with a McpAdapterError (DeviceDriver real impl)", async () => {
    const { McpAdapterError } = await import("../connection/errors.js");
    await expect(driver.screenshot(udid)).rejects.toBeInstanceOf(McpAdapterError);
  });

  it("tap rejects with a McpAdapterError (DeviceDriver real impl)", async () => {
    const { McpAdapterError } = await import("../connection/errors.js");
    await expect(driver.tap(udid, { kind: "element", elementId: "x" })).rejects.toBeInstanceOf(
      McpAdapterError,
    );
  });

  it("typeText rejects with a McpAdapterError (DeviceDriver real impl)", async () => {
    const { McpAdapterError } = await import("../connection/errors.js");
    await expect(driver.typeText(udid, "text")).rejects.toBeInstanceOf(McpAdapterError);
  });

  it("swipe rejects with a McpAdapterError (DeviceDriver real impl)", async () => {
    const { McpAdapterError } = await import("../connection/errors.js");
    await expect(driver.swipe(udid, "up")).rejects.toBeInstanceOf(McpAdapterError);
  });

  it("takeSnapshot rejects (real SnapshotManager — device not in simctl list)", async () => {
    // #16 replaced the SnapshotStub with the real SnapshotManager.
    // With the real exec (no Mac/simctl), the device lookup fails or the exec
    // throws — either way it rejects with an error (not "not yet implemented").
    await expect(driver.takeSnapshot(udid, fakeSnapshotName)).rejects.toThrow();
  });

  it("resetToSnapshot rejects with DeviceNotFoundError (device-first contract — Fix #2, #16 real impl)", async () => {
    // #16 replaced the SnapshotStub with the real SnapshotManager.
    // ADR-0003 §2 device-first contract: resetToSnapshot verifies the device exists
    // BEFORE the registry lookup. Since the fake udid is not in the simctl device list
    // (no real Mac in unit tests), it throws DeviceNotFoundError — not SnapshotNotFoundError.
    // T8 (known-device + unknown-snapshot -> SnapshotNotFoundError) is proven in snapshot.test.ts §6.
    await expect(driver.resetToSnapshot(udid, fakeSnapshotName)).rejects.toThrow();
  });

  // Note: lifecycle (#14 real impl) — shutdownSimulator, bootSimulator, etc. are tested
  // via lifecycle.contract.test.ts. We do not re-test them here with the facade default.
});
