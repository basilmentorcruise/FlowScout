/**
 * Contract test: runs the shared driver-contract suite against FakeMobileDriver.
 *
 * This file is the "wire the suite to the fake" entry point for ticket #13.
 * Tickets #14/#15/#16 create their own *.<capability>.contract.test.ts files
 * that import `runDriverContractSuite` and wire it to the real adapter slices.
 *
 * Covers all ACs from issue #13:
 *   AC1 — every port method passes contract assertions with no simulator/MCP.
 *   AC2 — state transitions (boot→install→launch→tap→snapshot→reset) observable.
 *   AC3 — resetToSnapshot with unknown name throws (T8 fail-closed).
 *   AC4 — unknown UDID throws typed error.
 *   AC5 — suite is parameterised; here it is pointed at FakeMobileDriver.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  FakeMobileDriver,
  DEFAULT_FAKE_UDID,
  UnknownDeviceError,
  SnapshotNotFoundError,
  InvalidInputError,
  runDriverContractSuite,
} from "../testing/index.js";

// ---------------------------------------------------------------------------
// Synthetic constants (no magic numbers in tests per ADR-0001 §6)
// ---------------------------------------------------------------------------
const TAP_X = 42;
const TAP_Y = 99;
const SWIPE_DISTANCE = 150;
const EXPECTED_ACTION_COUNT_3 = 3;
const EXPECTED_ACTION_COUNT_2 = 2;
const EXTRA_UDID = "00000000-0000-0000-0000-000000000002";
const APP_PATH = "/fake/builds/Fixture.app";
const BUNDLE_ID = "com.example.flowscout.fixture";

// ---------------------------------------------------------------------------
// §0 — Wire the shared contract suite against FakeMobileDriver
// ---------------------------------------------------------------------------

runDriverContractSuite(() => new FakeMobileDriver());

// ---------------------------------------------------------------------------
// §1 — FakeMobileDriver-specific: action recording
// ---------------------------------------------------------------------------

function bootedDriver(): Promise<FakeMobileDriver> {
  const d = new FakeMobileDriver();
  return d
    .bootSimulator(DEFAULT_FAKE_UDID)
    .then(() => d.installApp(DEFAULT_FAKE_UDID, APP_PATH))
    .then(() => d.launchApp(DEFAULT_FAKE_UDID, BUNDLE_ID))
    .then(() => d);
}

describe("FakeMobileDriver — action recording", () => {
  let driver: FakeMobileDriver;

  beforeEach(async () => {
    driver = await bootedDriver();
  });

  it("records tap with element target", async () => {
    await driver.tap(DEFAULT_FAKE_UDID, { kind: "element", elementId: "btn-ok" });
    expect(driver.recordedActions).toHaveLength(1);
    const action = driver.recordedActions[0];
    expect(action?.kind).toBe("tap");
    if (action?.kind === "tap") {
      expect(action.target).toEqual({ kind: "element", elementId: "btn-ok" });
    }
  });

  it("records tap with coordinate target", async () => {
    await driver.tap(DEFAULT_FAKE_UDID, { kind: "coordinate", x: TAP_X, y: TAP_Y });
    expect(driver.recordedActions).toHaveLength(1);
    const action = driver.recordedActions[0];
    if (action?.kind === "tap") {
      expect(action.target).toEqual({ kind: "coordinate", x: TAP_X, y: TAP_Y });
    }
  });

  it("records typeText WITHOUT storing the text (T5 no-log)", async () => {
    await driver.typeText(DEFAULT_FAKE_UDID, "super-secret-password");
    const action = driver.recordedActions[0];
    expect(action?.kind).toBe("typeText");
    expect(JSON.stringify(action)).not.toContain("super-secret-password");
  });

  it("records swipe with direction and no distance", async () => {
    await driver.swipe(DEFAULT_FAKE_UDID, "up");
    const action = driver.recordedActions[0];
    expect(action?.kind).toBe("swipe");
    if (action?.kind === "swipe") {
      expect(action.direction).toBe("up");
      expect(action.distance).toBeUndefined();
    }
  });

  it("records swipe with distance", async () => {
    await driver.swipe(DEFAULT_FAKE_UDID, "down", SWIPE_DISTANCE);
    const action = driver.recordedActions[0];
    if (action?.kind === "swipe") expect(action.distance).toBe(SWIPE_DISTANCE);
  });

  it("accumulates multiple actions in order", async () => {
    await driver.tap(DEFAULT_FAKE_UDID, { kind: "coordinate", x: 1, y: 1 });
    await driver.typeText(DEFAULT_FAKE_UDID, "text");
    await driver.swipe(DEFAULT_FAKE_UDID, "left");
    expect(driver.recordedActions).toHaveLength(EXPECTED_ACTION_COUNT_3);
    expect(driver.recordedActions[0]?.kind).toBe("tap");
    expect(driver.recordedActions[1]?.kind).toBe("typeText");
    expect(driver.recordedActions[EXPECTED_ACTION_COUNT_2]?.kind).toBe("swipe");
  });
});

// ---------------------------------------------------------------------------
// §2 — FakeMobileDriver-specific: typed error classes
// ---------------------------------------------------------------------------

describe("FakeMobileDriver — typed error classes", () => {
  let driver: FakeMobileDriver;

  beforeEach(() => {
    driver = new FakeMobileDriver();
  });

  it("bootSimulator with unknown UDID throws UnknownDeviceError", async () => {
    await expect(
      driver.bootSimulator("00000000-0000-0000-0000-FFFFFFFFFFFF"),
    ).rejects.toBeInstanceOf(UnknownDeviceError);
  });

  it("resetToSnapshot with missing name throws SnapshotNotFoundError (T8)", async () => {
    await driver.bootSimulator(DEFAULT_FAKE_UDID);
    await expect(
      driver.resetToSnapshot(DEFAULT_FAKE_UDID, "never-taken"),
    ).rejects.toBeInstanceOf(SnapshotNotFoundError);
  });

  it("bootSimulator with injection UDID throws InvalidInputError (T1)", async () => {
    await expect(driver.bootSimulator("; rm -rf ~")).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("launchApp with injection bundleId throws InvalidInputError (T1)", async () => {
    await driver.bootSimulator(DEFAULT_FAKE_UDID);
    await driver.installApp(DEFAULT_FAKE_UDID, APP_PATH);
    await expect(
      driver.launchApp(DEFAULT_FAKE_UDID, "; rm -rf ~"),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("takeSnapshot with injection name throws InvalidInputError (T1)", async () => {
    await driver.bootSimulator(DEFAULT_FAKE_UDID);
    await expect(
      driver.takeSnapshot(DEFAULT_FAKE_UDID, "$(injection)"),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("installApp with traversal path throws InvalidInputError (T2)", async () => {
    await driver.bootSimulator(DEFAULT_FAKE_UDID);
    await expect(
      driver.installApp(DEFAULT_FAKE_UDID, "../../etc/passwd"),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("SnapshotNotFoundError message mentions 'snapshot' (T8 informative error)", async () => {
    await driver.bootSimulator(DEFAULT_FAKE_UDID);
    const err = await driver
      .resetToSnapshot(DEFAULT_FAKE_UDID, "never-taken")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapshotNotFoundError);
    expect((err as SnapshotNotFoundError).message).toMatch(/snapshot/i);
  });
});

// ---------------------------------------------------------------------------
// §3 — FakeMobileDriver-specific: registerDevice + multi-device
// ---------------------------------------------------------------------------

describe("FakeMobileDriver — registerDevice", () => {
  it("allows registering extra synthetic devices and using them", async () => {
    const d = new FakeMobileDriver();
    d.registerDevice(EXTRA_UDID, "Extra Synthetic iPhone", "17.5");
    await d.bootSimulator(EXTRA_UDID);
    await d.installApp(EXTRA_UDID, APP_PATH);
    await d.launchApp(EXTRA_UDID, BUNDLE_ID);
    const snap = await d.snapshotAccessibilityTree(EXTRA_UDID);
    expect(snap.length).toBeGreaterThan(0);
  });

  it("listDevices returns all registered devices", async () => {
    const d = new FakeMobileDriver();
    d.registerDevice(EXTRA_UDID, "Extra Device", "17.0");
    const devices = await d.listDevices();
    expect(devices.length).toBe(EXPECTED_ACTION_COUNT_2);
    const udids = devices.map((dev) => dev.udid);
    expect(udids).toContain(DEFAULT_FAKE_UDID);
    expect(udids).toContain(EXTRA_UDID);
  });
});

// ---------------------------------------------------------------------------
// §4 — FakeMobileDriver-specific: listDevices state transitions
// ---------------------------------------------------------------------------

describe("FakeMobileDriver — listDevices state reflection", () => {
  it("device is 'shutdown' before boot", async () => {
    const d = new FakeMobileDriver();
    const devices = await d.listDevices();
    expect(devices.find((dev) => dev.udid === DEFAULT_FAKE_UDID)?.state).toBe("shutdown");
  });

  it("device is 'booted' after bootSimulator", async () => {
    const d = new FakeMobileDriver();
    await d.bootSimulator(DEFAULT_FAKE_UDID);
    const devices = await d.listDevices();
    expect(devices.find((dev) => dev.udid === DEFAULT_FAKE_UDID)?.state).toBe("booted");
  });

  it("device is 'shutdown' after shutdownSimulator", async () => {
    const d = new FakeMobileDriver();
    await d.bootSimulator(DEFAULT_FAKE_UDID);
    await d.shutdownSimulator(DEFAULT_FAKE_UDID);
    const devices = await d.listDevices();
    expect(devices.find((dev) => dev.udid === DEFAULT_FAKE_UDID)?.state).toBe("shutdown");
  });

  it("all devices have platform 'ios'", async () => {
    const devices = await new FakeMobileDriver().listDevices();
    for (const d of devices) expect(d.platform).toBe("ios");
  });
});

// ---------------------------------------------------------------------------
// §5 — Full state-machine exercise (AC2 from the ticket)
// ---------------------------------------------------------------------------

describe("FakeMobileDriver — full state-machine AC2 exercise", () => {
  it("boot→install→launch→observe→tap→snapshot→reset→shutdown is consistent", async () => {
    const d = await bootedDriver();

    const a11y = await d.snapshotAccessibilityTree(DEFAULT_FAKE_UDID);
    expect(a11y).toBeTruthy();
    expect((await d.screenshot(DEFAULT_FAKE_UDID)).length).toBeGreaterThan(0);

    await d.tap(DEFAULT_FAKE_UDID, { kind: "element", elementId: "btn-ok" });
    await d.typeText(DEFAULT_FAKE_UDID, "synthetic-input"); // text not stored
    await d.swipe(DEFAULT_FAKE_UDID, "up");

    expect(d.recordedActions).toHaveLength(EXPECTED_ACTION_COUNT_3);

    await d.takeSnapshot(DEFAULT_FAKE_UDID, "post-login");
    await d.resetToSnapshot(DEFAULT_FAKE_UDID, "post-login");
    await d.shutdownSimulator(DEFAULT_FAKE_UDID);

    const devices = await d.listDevices();
    expect(devices.find((dev) => dev.udid === DEFAULT_FAKE_UDID)?.state).toBe("shutdown");
  });
});
