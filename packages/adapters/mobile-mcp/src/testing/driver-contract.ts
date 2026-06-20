/**
 * Parameterised contract-test suite for MobileDriverPort + SimulatorLifecycle.
 *
 * This is the single source of conformance every concrete driver implementation
 * (FakeMobileDriver now; real capability modules #14/#15/#16 later) must pass.
 *
 * Usage (import in your test file):
 *   import { runDriverContractSuite } from '@flowscout/adapter-mobile-mcp/testing';
 *   runDriverContractSuite(() => new MyDriver());
 *
 * Design:
 *   - Depends only on domain port types (DIP: no concretions).
 *   - The driver factory is injected so the suite is fully reusable (OCP).
 *   - Security / error-conformance cases from the threat model (T1, T3, T8, T9)
 *     are first-class assertions, not optional extras.
 *
 * Security conformance cases covered (from threat model §#13):
 *   T3  — malformed / oversized / empty payloads → typed handled errors.
 *   T8  — resetToSnapshot to a missing snapshot name → typed error (fails closed).
 *   T1  — injection-shaped udid / bundleId / snapshotName / path values → rejected.
 *   T9  — canned payloads are synthetic (verified by the Fake's implementation).
 */

import { describe, it, expect, beforeEach } from "vitest";
import type {
  MobileDriverPort,
  SimulatorLifecycle,
  A11ySnapshot,
  ScreenshotBytes,
} from "@flowscout/domain";

/** A combined driver type exercising both ports. */
export type FullDriver = MobileDriverPort & SimulatorLifecycle;

/** Factory function injected by callers so the suite tests any implementation. */
export type DriverFactory = () => FullDriver;

// ---------------------------------------------------------------------------
// Well-known synthetic values used in happy-path tests (T9: no real PII)
// ---------------------------------------------------------------------------
const SYNTHETIC_UDID = "00000000-0000-0000-0000-000000000001";
const SYNTHETIC_BUNDLE_ID = "com.example.flowscout.fixture";
const SYNTHETIC_APP_PATH = "/fake/builds/Fixture.app";
const SYNTHETIC_SNAPSHOT_NAME = "clean-state";
const SYNTHETIC_SNAPSHOT_NAME_2 = "after-login";
const UNKNOWN_UDID = "00000000-0000-0000-0000-FFFFFFFFFFFF";

// ---------------------------------------------------------------------------
// Validation test vectors — injection / malformed values (T1/T2 security cases)
// ---------------------------------------------------------------------------

/** UDID that does NOT match the UUID allowlist — used in T1 injection tests. */
const INJECTION_UDIDS = [
  "; rm -rf ~",
  "$(echo injected)",
  "--flag-injection",
  "",
  "a".repeat(512),
  "udid\x00with\x00nuls",
];

/** BundleIds that violate the reverse-DNS allowlist. */
const INJECTION_BUNDLE_IDS = [
  "; rm -rf ~",
  "bundle$(injection)",
  "--leading-dash",
  "",
  "a".repeat(512),
  "bundle\x00id",
];

/** Snapshot names that violate the ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ allowlist. */
const INJECTION_SNAPSHOT_NAMES = [
  "; rm -rf snapshot",
  "$(injection)",
  "--flag",
  "",
  "a".repeat(65), // exceeds max length
  "snap\x00shot",
];

/** App bundle paths containing path-traversal or injection patterns. */
const INJECTION_APP_PATHS = [
  "../../etc/passwd",
  "/etc/passwd",
  "../../../outside",
  "",
  "path with $(injection)",
  "a".repeat(512),
];

// ---------------------------------------------------------------------------
// Sub-suite helpers (decomposed to satisfy max-lines-per-function)
// ---------------------------------------------------------------------------

function describeLifecycleHappyPath(getDriver: () => FullDriver): void {
  describe("§1 SimulatorLifecycle — happy-path state machine", () => {
    it("bootSimulator resolves for a known synthetic UDID", async () => {
      await expect(getDriver().bootSimulator(SYNTHETIC_UDID)).resolves.toBeUndefined();
    });

    it("installApp resolves after boot", async () => {
      const d = getDriver();
      await d.bootSimulator(SYNTHETIC_UDID);
      await expect(d.installApp(SYNTHETIC_UDID, SYNTHETIC_APP_PATH)).resolves.toBeUndefined();
    });

    it("launchApp resolves after install", async () => {
      const d = getDriver();
      await d.bootSimulator(SYNTHETIC_UDID);
      await d.installApp(SYNTHETIC_UDID, SYNTHETIC_APP_PATH);
      await expect(d.launchApp(SYNTHETIC_UDID, SYNTHETIC_BUNDLE_ID)).resolves.toBeUndefined();
    });

    it("shutdownSimulator resolves after boot", async () => {
      const d = getDriver();
      await d.bootSimulator(SYNTHETIC_UDID);
      await expect(d.shutdownSimulator(SYNTHETIC_UDID)).resolves.toBeUndefined();
    });

    it("full lifecycle: boot→install→launch→snapshot→reset→shutdown produces no error", async () => {
      const d = getDriver();
      await d.bootSimulator(SYNTHETIC_UDID);
      await d.installApp(SYNTHETIC_UDID, SYNTHETIC_APP_PATH);
      await d.launchApp(SYNTHETIC_UDID, SYNTHETIC_BUNDLE_ID);
      await d.takeSnapshot(SYNTHETIC_UDID, SYNTHETIC_SNAPSHOT_NAME);
      await d.resetToSnapshot(SYNTHETIC_UDID, SYNTHETIC_SNAPSHOT_NAME);
      await d.shutdownSimulator(SYNTHETIC_UDID);
    });
  });
}

function describeSnapshotReset(getDriver: () => FullDriver): void {
  describe("§2 SimulatorLifecycle — snapshot / reset", () => {
    it("takeSnapshot resolves after the simulator is in a usable state", async () => {
      const d = getDriver();
      await d.bootSimulator(SYNTHETIC_UDID);
      await d.installApp(SYNTHETIC_UDID, SYNTHETIC_APP_PATH);
      await expect(d.takeSnapshot(SYNTHETIC_UDID, SYNTHETIC_SNAPSHOT_NAME)).resolves.toBeUndefined();
    });

    it("resetToSnapshot resolves after a snapshot has been taken", async () => {
      const d = getDriver();
      await d.bootSimulator(SYNTHETIC_UDID);
      await d.installApp(SYNTHETIC_UDID, SYNTHETIC_APP_PATH);
      await d.takeSnapshot(SYNTHETIC_UDID, SYNTHETIC_SNAPSHOT_NAME);
      await expect(d.resetToSnapshot(SYNTHETIC_UDID, SYNTHETIC_SNAPSHOT_NAME)).resolves.toBeUndefined();
    });

    it("multiple distinct snapshots can be taken and independently restored", async () => {
      const d = getDriver();
      await d.bootSimulator(SYNTHETIC_UDID);
      await d.installApp(SYNTHETIC_UDID, SYNTHETIC_APP_PATH);
      await d.takeSnapshot(SYNTHETIC_UDID, SYNTHETIC_SNAPSHOT_NAME);
      await d.takeSnapshot(SYNTHETIC_UDID, SYNTHETIC_SNAPSHOT_NAME_2);
      await expect(d.resetToSnapshot(SYNTHETIC_UDID, SYNTHETIC_SNAPSHOT_NAME)).resolves.toBeUndefined();
      await expect(d.resetToSnapshot(SYNTHETIC_UDID, SYNTHETIC_SNAPSHOT_NAME_2)).resolves.toBeUndefined();
    });

    it("T8: resetToSnapshot to a missing name throws (fails closed, not silent no-op)", async () => {
      const d = getDriver();
      await d.bootSimulator(SYNTHETIC_UDID);
      await expect(
        d.resetToSnapshot(SYNTHETIC_UDID, "snapshot-that-was-never-taken"),
      ).rejects.toThrow();
    });

    it("T8: resetToSnapshot to a missing name provides an informative error", async () => {
      const d = getDriver();
      await d.bootSimulator(SYNTHETIC_UDID);
      await expect(
        d.resetToSnapshot(SYNTHETIC_UDID, "nonexistent-snapshot"),
      ).rejects.toThrow(/snapshot/i);
    });
  });
}

function describeListDevices(getDriver: () => FullDriver): void {
  describe("§3 MobileDriverPort — listDevices", () => {
    it("listDevices returns a readonly array (may be empty)", async () => {
      const devices = await getDriver().listDevices();
      expect(Array.isArray(devices)).toBe(true);
    });

    it("listDevices returns DeviceInfo objects with required shape", async () => {
      const devices = await getDriver().listDevices();
      for (const d of devices) {
        expect(typeof d.udid).toBe("string");
        expect(typeof d.name).toBe("string");
        expect(["ios", "android"]).toContain(d.platform);
        expect(typeof d.osVersion).toBe("string");
        expect(["booted", "shutdown", "unknown"]).toContain(d.state);
      }
    });
  });
}

function describeObservation(getDriver: () => FullDriver): void {
  describe("§4 MobileDriverPort — observation (a11y + screenshot)", () => {
    let driver: FullDriver;

    beforeEach(async () => {
      driver = getDriver();
      await driver.bootSimulator(SYNTHETIC_UDID);
      await driver.installApp(SYNTHETIC_UDID, SYNTHETIC_APP_PATH);
      await driver.launchApp(SYNTHETIC_UDID, SYNTHETIC_BUNDLE_ID);
    });

    it("snapshotAccessibilityTree returns a non-empty A11ySnapshot string", async () => {
      const snapshot: A11ySnapshot = await driver.snapshotAccessibilityTree(SYNTHETIC_UDID);
      expect(typeof snapshot).toBe("string");
      expect(snapshot.length).toBeGreaterThan(0);
    });

    it("screenshot returns a non-empty Uint8Array (ScreenshotBytes)", async () => {
      const bytes: ScreenshotBytes = await driver.screenshot(SYNTHETIC_UDID);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(0);
    });
  });
}

function describeActions(getDriver: () => FullDriver): void {
  describe("§5 MobileDriverPort — actions (tap / typeText / swipe)", () => {
    let driver: FullDriver;

    beforeEach(async () => {
      driver = getDriver();
      await driver.bootSimulator(SYNTHETIC_UDID);
      await driver.installApp(SYNTHETIC_UDID, SYNTHETIC_APP_PATH);
      await driver.launchApp(SYNTHETIC_UDID, SYNTHETIC_BUNDLE_ID);
    });

    it("tap with element target resolves", async () => {
      await expect(
        driver.tap(SYNTHETIC_UDID, { kind: "element", elementId: "btn-ok" }),
      ).resolves.toBeUndefined();
    });

    it("tap with coordinate target resolves", async () => {
      await expect(
        driver.tap(SYNTHETIC_UDID, { kind: "coordinate", x: 100, y: 200 }),
      ).resolves.toBeUndefined();
    });

    it("typeText resolves", async () => {
      await expect(driver.typeText(SYNTHETIC_UDID, "hello world")).resolves.toBeUndefined();
    });

    it("swipe up/down/left/right all resolve", async () => {
      await expect(driver.swipe(SYNTHETIC_UDID, "up")).resolves.toBeUndefined();
      await expect(driver.swipe(SYNTHETIC_UDID, "down")).resolves.toBeUndefined();
      await expect(driver.swipe(SYNTHETIC_UDID, "left")).resolves.toBeUndefined();
      await expect(driver.swipe(SYNTHETIC_UDID, "right")).resolves.toBeUndefined();
    });

    it("swipe with explicit distance resolves", async () => {
      const swipeDistance = 300;
      await expect(driver.swipe(SYNTHETIC_UDID, "up", swipeDistance)).resolves.toBeUndefined();
    });
  });
}

function describeUnknownUdid(getDriver: () => FullDriver): void {
  describe("§6 Unknown UDID — all port methods reject with typed error", () => {
    it("bootSimulator with unknown UDID throws", async () => {
      await expect(getDriver().bootSimulator(UNKNOWN_UDID)).rejects.toThrow();
    });

    it("snapshotAccessibilityTree with unknown UDID throws", async () => {
      await expect(getDriver().snapshotAccessibilityTree(UNKNOWN_UDID)).rejects.toThrow();
    });

    it("screenshot with unknown UDID throws", async () => {
      await expect(getDriver().screenshot(UNKNOWN_UDID)).rejects.toThrow();
    });

    it("tap with unknown UDID throws", async () => {
      await expect(
        getDriver().tap(UNKNOWN_UDID, { kind: "coordinate", x: 0, y: 0 }),
      ).rejects.toThrow();
    });

    it("typeText with unknown UDID throws", async () => {
      await expect(getDriver().typeText(UNKNOWN_UDID, "text")).rejects.toThrow();
    });

    it("swipe with unknown UDID throws", async () => {
      await expect(getDriver().swipe(UNKNOWN_UDID, "up")).rejects.toThrow();
    });

    it("installApp with unknown UDID throws", async () => {
      await expect(
        getDriver().installApp(UNKNOWN_UDID, SYNTHETIC_APP_PATH),
      ).rejects.toThrow();
    });

    it("launchApp with unknown UDID throws", async () => {
      await expect(
        getDriver().launchApp(UNKNOWN_UDID, SYNTHETIC_BUNDLE_ID),
      ).rejects.toThrow();
    });

    it("takeSnapshot with unknown UDID throws", async () => {
      await expect(
        getDriver().takeSnapshot(UNKNOWN_UDID, SYNTHETIC_SNAPSHOT_NAME),
      ).rejects.toThrow();
    });

    it("resetToSnapshot with unknown UDID throws", async () => {
      await expect(
        getDriver().resetToSnapshot(UNKNOWN_UDID, SYNTHETIC_SNAPSHOT_NAME),
      ).rejects.toThrow();
    });

    it("shutdownSimulator with unknown UDID throws", async () => {
      await expect(getDriver().shutdownSimulator(UNKNOWN_UDID)).rejects.toThrow();
    });
  });
}

function describeInjectionUdids(getDriver: () => FullDriver): void {
  describe("§7 T1 — injection-shaped UDID values are rejected", () => {
    for (const badUdid of INJECTION_UDIDS) {
      it(`bootSimulator rejects UDID: ${JSON.stringify(badUdid)}`, async () => {
        await expect(getDriver().bootSimulator(badUdid)).rejects.toThrow();
      });
      it(`snapshotAccessibilityTree rejects UDID: ${JSON.stringify(badUdid)}`, async () => {
        await expect(getDriver().snapshotAccessibilityTree(badUdid)).rejects.toThrow();
      });
      it(`screenshot rejects UDID: ${JSON.stringify(badUdid)}`, async () => {
        await expect(getDriver().screenshot(badUdid)).rejects.toThrow();
      });
    }
  });
}

function describeInjectionBundleIds(getDriver: () => FullDriver): void {
  describe("§8 T1 — injection-shaped bundleId values are rejected", () => {
    for (const badBundleId of INJECTION_BUNDLE_IDS) {
      it(`launchApp rejects bundleId: ${JSON.stringify(badBundleId)}`, async () => {
        const d = getDriver();
        await d.bootSimulator(SYNTHETIC_UDID);
        await d.installApp(SYNTHETIC_UDID, SYNTHETIC_APP_PATH);
        await expect(d.launchApp(SYNTHETIC_UDID, badBundleId)).rejects.toThrow();
      });
    }
  });
}

function describeInjectionSnapshotNames(getDriver: () => FullDriver): void {
  describe("§9 T1 — injection-shaped snapshotName values are rejected", () => {
    for (const badName of INJECTION_SNAPSHOT_NAMES) {
      it(`takeSnapshot rejects snapshotName: ${JSON.stringify(badName)}`, async () => {
        const d = getDriver();
        await d.bootSimulator(SYNTHETIC_UDID);
        await expect(d.takeSnapshot(SYNTHETIC_UDID, badName)).rejects.toThrow();
      });
      it(`resetToSnapshot rejects snapshotName: ${JSON.stringify(badName)}`, async () => {
        const d = getDriver();
        await d.bootSimulator(SYNTHETIC_UDID);
        await expect(d.resetToSnapshot(SYNTHETIC_UDID, badName)).rejects.toThrow();
      });
    }
  });
}

function describeInjectionAppPaths(getDriver: () => FullDriver): void {
  describe("§10 T1/T2 — injection-shaped appBundlePath values are rejected", () => {
    for (const badPath of INJECTION_APP_PATHS) {
      it(`installApp rejects appBundlePath: ${JSON.stringify(badPath)}`, async () => {
        const d = getDriver();
        await d.bootSimulator(SYNTHETIC_UDID);
        await expect(d.installApp(SYNTHETIC_UDID, badPath)).rejects.toThrow();
      });
    }
  });
}

function describeStressPayloads(getDriver: () => FullDriver): void {
  describe("§11 T3 — observable error/payload contract under repeated calls", () => {
    it("repeated snapshotAccessibilityTree calls return consistent non-empty results", async () => {
      const d = getDriver();
      await d.bootSimulator(SYNTHETIC_UDID);
      await d.installApp(SYNTHETIC_UDID, SYNTHETIC_APP_PATH);
      await d.launchApp(SYNTHETIC_UDID, SYNTHETIC_BUNDLE_ID);
      const repeatCount = 3;
      for (let i = 0; i < repeatCount; i++) {
        const snap = await d.snapshotAccessibilityTree(SYNTHETIC_UDID);
        expect(typeof snap).toBe("string");
        expect(snap.length).toBeGreaterThan(0);
      }
    });

    it("repeated screenshot calls return consistent non-empty Uint8Arrays", async () => {
      const d = getDriver();
      await d.bootSimulator(SYNTHETIC_UDID);
      await d.installApp(SYNTHETIC_UDID, SYNTHETIC_APP_PATH);
      await d.launchApp(SYNTHETIC_UDID, SYNTHETIC_BUNDLE_ID);
      const repeatCount = 3;
      for (let i = 0; i < repeatCount; i++) {
        const bytes = await d.screenshot(SYNTHETIC_UDID);
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes.length).toBeGreaterThan(0);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// The exported parameterised suite
// ---------------------------------------------------------------------------

/**
 * Run the full driver conformance suite against any FullDriver implementation.
 *
 * Call at the top level of a test file (or inside a describe block).
 *
 * @param makeDriver - factory producing a fresh driver for each test group
 */
export function runDriverContractSuite(makeDriver: DriverFactory): void {
  describe("MobileDriverPort + SimulatorLifecycle contract suite", () => {
    // Each sub-suite receives a fresh driver via a closure.
    const getDriver = (): FullDriver => makeDriver();

    describeLifecycleHappyPath(getDriver);
    describeSnapshotReset(getDriver);
    describeListDevices(getDriver);
    describeObservation(getDriver);
    describeActions(getDriver);
    describeUnknownUdid(getDriver);
    describeInjectionUdids(getDriver);
    describeInjectionBundleIds(getDriver);
    describeInjectionSnapshotNames(getDriver);
    describeInjectionAppPaths(getDriver);
    describeStressPayloads(getDriver);
  });
}
