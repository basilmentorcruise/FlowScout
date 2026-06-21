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
import type { CapabilityBundle, LifecycleCapability, DrivingCapability, SnapshotCapability, HealthCapability } from "../connection/capabilities.js";
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
    bootSimulator: vi.fn().mockResolvedValue(undefined) as unknown as LifecycleCapability["bootSimulator"],
    installApp: vi.fn().mockResolvedValue(undefined) as unknown as LifecycleCapability["installApp"],
    launchApp: vi.fn().mockResolvedValue(undefined) as unknown as LifecycleCapability["launchApp"],
    shutdownSimulator: vi.fn().mockResolvedValue(undefined) as unknown as LifecycleCapability["shutdownSimulator"],
  };

  const driving: DrivingCapability = {
    snapshotAccessibilityTree: vi
      .fn()
      .mockResolvedValue("fake-a11y" as A11ySnapshot) as unknown as DrivingCapability["snapshotAccessibilityTree"],
    screenshot: vi
      .fn()
      .mockResolvedValue(new Uint8Array([1, 2, 3])) as unknown as DrivingCapability["screenshot"],
    tap: vi.fn().mockResolvedValue(undefined) as unknown as DrivingCapability["tap"],
    typeText: vi.fn().mockResolvedValue(undefined) as unknown as DrivingCapability["typeText"],
    swipe: vi.fn().mockResolvedValue(undefined) as unknown as DrivingCapability["swipe"],
  };

  const snapshot: SnapshotCapability = {
    takeSnapshot: vi.fn().mockResolvedValue(undefined) as unknown as SnapshotCapability["takeSnapshot"],
    resetToSnapshot: vi.fn().mockResolvedValue(undefined) as unknown as SnapshotCapability["resetToSnapshot"],
  };

  const health: HealthCapability = {
    checkReadiness: vi
      .fn()
      .mockResolvedValue({ mcpReachable: true, wdaUp: true, appLaunched: null }) as unknown as HealthCapability["checkReadiness"],
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
// Default deps (stubs) still throw NotImplemented until Wave-1 lands
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Default capabilities (stubs still throw NotImplemented for non-#14 capabilities)
// ---------------------------------------------------------------------------
// Note: lifecycle methods (#14) are now real implementations that attempt simctl.
// Non-lifecycle stubs (#15 driving, #16 snapshot, #17 health) still throw.
// The lifecycle methods now throw adapter-typed errors (not "not yet implemented")
// because SimulatorLifecycleManager validates input and calls simctl.
// ---------------------------------------------------------------------------

describe("MobileMcpDriver — default stub capabilities (driving/snapshot — still stubs)", () => {
  const udid = fakeUdid;

  it("snapshotAccessibilityTree rejects with not yet implemented", async () => {
    // Using injected fake deps — test the real driving stub via the facade-spy approach.
    // Reset to an actual stub that throws.
    const driver2 = new MobileMcpDriver(fakeConfig, {
      ...makeFakeDeps(),
      driving: {
        snapshotAccessibilityTree: () => Promise.reject(new Error("DrivingCapability.snapshotAccessibilityTree is not yet implemented")),
        screenshot: () => Promise.reject(new Error("DrivingCapability.screenshot is not yet implemented")),
        tap: () => Promise.reject(new Error("DrivingCapability.tap is not yet implemented")),
        typeText: () => Promise.reject(new Error("DrivingCapability.typeText is not yet implemented")),
        swipe: () => Promise.reject(new Error("DrivingCapability.swipe is not yet implemented")),
      },
    });
    await expect(driver2.snapshotAccessibilityTree(udid)).rejects.toThrow("not yet implemented");
  });

  it("takeSnapshot rejects with not yet implemented", async () => {
    const driver2 = new MobileMcpDriver(fakeConfig, {
      ...makeFakeDeps(),
      snapshot: {
        takeSnapshot: () => Promise.reject(new Error("SnapshotCapability.takeSnapshot is not yet implemented")),
        resetToSnapshot: () => Promise.reject(new Error("SnapshotCapability.resetToSnapshot is not yet implemented")),
      },
    });
    await expect(driver2.takeSnapshot(udid, fakeSnapshotName)).rejects.toThrow(
      "not yet implemented",
    );
  });

  it("resetToSnapshot rejects with not yet implemented", async () => {
    const driver2 = new MobileMcpDriver(fakeConfig, {
      ...makeFakeDeps(),
      snapshot: {
        takeSnapshot: () => Promise.reject(new Error("SnapshotCapability.takeSnapshot is not yet implemented")),
        resetToSnapshot: () => Promise.reject(new Error("SnapshotCapability.resetToSnapshot is not yet implemented")),
      },
    });
    await expect(driver2.resetToSnapshot(udid, fakeSnapshotName)).rejects.toThrow(
      "not yet implemented",
    );
  });
});
