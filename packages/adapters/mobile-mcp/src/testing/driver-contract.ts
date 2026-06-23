/**
 * Parameterised contract-test suite for MobileDriverPort + SimulatorLifecycle.
 *
 * This is the single source of conformance every concrete driver implementation
 * (FakeMobileDriver now; real capability modules #14/#15/#16 later) must pass.
 *
 * ADR-0003 refactors this file into THREE per-capability section runners plus a
 * thin aggregator (`runDriverContractSuite`) that preserves the Fake's existing
 * call site unchanged. The three runners are the new entry points for Wave-1 tickets:
 *   - runLifecycleContract  (#14 SimulatorLifecycleManager)
 *   - runDrivingContract    (#15 DeviceDriver)
 *   - runSnapshotContract   (#16 SnapshotManager)
 *
 * Usage (per-capability, for Wave-1 real adapters):
 *   import { runLifecycleContract } from '@flowscout/adapter-mobile-mcp/testing';
 *   runLifecycleContract({
 *     createLifecycle: () => new SimulatorLifecycleManager(fakeExec, cfg),
 *     fixtures: MY_LIFECYCLE_FIXTURES,
 *     errorClasses: MY_LIFECYCLE_ERROR_CLASSES,
 *   });
 *
 * Usage (full-driver aggregator, for the Fake):
 *   import { runDriverContractSuite, FAKE_CONTRACT_FIXTURES } from '@flowscout/adapter-mobile-mcp/testing';
 *   runDriverContractSuite({
 *     createDriver: () => new FakeMobileDriver(),
 *     fixtures: FAKE_CONTRACT_FIXTURES,
 *   });
 *
 * Design:
 *   - Depends only on domain port types (DIP: no concretions).
 *   - Both the driver factory and test fixtures are injected so the suite is
 *     fully reusable across the Fake and every real adapter without modification (OCP).
 *   - Error-class assertions use the injected `errorClasses` so a future adapter
 *     cannot accidentally pass on an incidental throw of the wrong type.
 *   - Security / error-conformance cases from the threat model (T1, T3, T8, T9)
 *     are first-class assertions, not optional extras.
 *   - Per-capability section runners do NOT call cross-capability lifecycle methods
 *     in beforeEach; "device existence" is provided by the adapter's own fake
 *     Exec/McpConnection keyed on fixtures.validUdid (ADR-0003 §1.2 R-A).
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

// ---------------------------------------------------------------------------
// Combined driver type (FullDriver) — used by the aggregator only
// ---------------------------------------------------------------------------

/** A combined driver type exercising both ports. Used by the thin aggregator. */
export type FullDriver = MobileDriverPort & SimulatorLifecycle;

/** Factory function injected by callers so the suite tests any implementation. */
export type DriverFactory = () => FullDriver;

// ---------------------------------------------------------------------------
// Per-capability partial types (ISP — each runner targets one capability)
// ---------------------------------------------------------------------------

/**
 * The lifecycle subset of SimulatorLifecycle + the listDevices method from MobileDriverPort.
 * boot / install / launch / shutdown / listDevices — what #14 implements.
 */
export type SimulatorLifecyclePartial = Pick<
  SimulatorLifecycle,
  "bootSimulator" | "installApp" | "launchApp" | "shutdownSimulator"
> &
  Pick<MobileDriverPort, "listDevices">;

/**
 * The driving subset of MobileDriverPort.
 * a11y / screenshot / tap / typeText / swipe — what #15 implements.
 */
export type MobileDriverDrivingPartial = Pick<
  MobileDriverPort,
  "snapshotAccessibilityTree" | "screenshot" | "tap" | "typeText" | "swipe"
>;

/**
 * The snapshot subset of SimulatorLifecycle.
 * takeSnapshot / resetToSnapshot — what #16 implements.
 */
export type SnapshotPartial = Pick<SimulatorLifecycle, "takeSnapshot" | "resetToSnapshot">;

// ---------------------------------------------------------------------------
// Per-capability factory types
// ---------------------------------------------------------------------------

/** Factory that returns only the lifecycle capability (boot/install/launch/shutdown/listDevices). */
export type LifecycleFactory = () => SimulatorLifecyclePartial;

/** Factory that returns only the driving capability (a11y/screenshot/tap/typeText/swipe). */
export type DrivingFactory = () => MobileDriverDrivingPartial;

/** Factory that returns only the snapshot capability (takeSnapshot/resetToSnapshot). */
export type SnapshotFactory = () => SnapshotPartial;

// ---------------------------------------------------------------------------
// ErrorClasses — injected so assertions are adapter-specific, not hardcoded
// ---------------------------------------------------------------------------

/**
 * Constructor type compatible with `toBeInstanceOf`.
 * Using `new (...args: never[]) => Error` keeps it concrete-class-agnostic.
 */
export type ErrorConstructor = new (...args: never[]) => Error;

/**
 * Per-capability error classes for the lifecycle capability (#14).
 * ISP: a lifecycle adapter declares only the error classes its methods throw.
 */
export interface LifecycleErrorClasses {
  /**
   * Thrown when an operation targets a UDID the adapter does not recognise.
   * (e.g. DeviceNotFoundError for a real adapter, UnknownDeviceError for the Fake).
   */
  unknownDevice: ErrorConstructor;
  /**
   * Thrown when an input value fails allowlist / format validation (T1/T2).
   */
  invalidInput: ErrorConstructor;
}

/**
 * Per-capability error classes for the driving capability (#15).
 * ISP: a driving adapter declares only the error classes its methods throw.
 */
export interface DrivingErrorClasses {
  /**
   * Thrown when an operation targets a UDID the adapter does not recognise.
   * (e.g. DeviceNotFoundError for a real adapter, UnknownDeviceError for the Fake).
   */
  unknownDevice: ErrorConstructor;
  /**
   * Thrown when an input value fails allowlist / format validation (T1/T2).
   */
  invalidInput: ErrorConstructor;
}

/**
 * Per-capability error classes for the snapshot capability (#16).
 * ISP: includes snapshotNotFound that only the snapshot capability needs to declare.
 */
export interface SnapshotErrorClasses {
  /**
   * Thrown when an operation targets a UDID the adapter does not recognise.
   * Per ADR-0003 §2: device validation precedes snapshot registry lookup for ALL operations.
   */
  unknownDevice: ErrorConstructor;
  /**
   * Thrown when an input value fails allowlist / format validation (T1).
   */
  invalidInput: ErrorConstructor;
  /**
   * Thrown when resetToSnapshot is called with a KNOWN udid but an UNKNOWN snapshot name.
   * (T8 fail-closed requirement — only reachable when device exists but snapshot name never taken.)
   */
  snapshotNotFound: ErrorConstructor;
}

/**
 * Combined error classes for the full-driver aggregator (kept for backward compatibility).
 * Maps down to the three per-capability bundles inside runDriverContractSuite.
 */
export interface ContractErrorClasses {
  /**
   * Thrown when an operation targets a UDID that this adapter does not know
   * (e.g. UnknownDeviceError for the Fake, DeviceNotFoundError for a real adapter).
   */
  unknownDevice: ErrorConstructor;

  /**
   * Thrown when an input value fails allowlist / format validation
   * (e.g. InvalidInputError, ValidationError). Covers T1/T2 injection cases.
   */
  invalidInput: ErrorConstructor;

  /**
   * Thrown when resetToSnapshot is called for a snapshot name that was never
   * taken on this driver instance (T8 fail-closed requirement).
   */
  snapshotNotFound: ErrorConstructor;
}

// ---------------------------------------------------------------------------
// Per-capability fixture types
// ---------------------------------------------------------------------------

/**
 * Fixture slice for the lifecycle section runner.
 * Holds only the values that lifecycle sections need.
 */
export interface LifecycleFixtures {
  /** A UDID the adapter recognises as a valid, pre-existing device. */
  validUdid: string;
  /** A bundle identifier valid for the adapter's allowlist. */
  validBundleId: string;
  /** An app bundle path the adapter accepts for installApp. */
  installablePath: string;
  /** A UDID the adapter will NOT recognise — used to assert unknownDevice error. */
  unknownUdid: string;
  /** Injection-shaped UDID values that must be rejected (falls back to defaults). */
  injectionUdids?: readonly string[];
  /** Injection-shaped bundle ID values that must be rejected (falls back to defaults). */
  injectionBundleIds?: readonly string[];
  /** Injection-shaped app paths that must be rejected by installApp (falls back to defaults). */
  injectionAppPaths?: readonly string[];
}

/**
 * Fixture slice for the driving section runner.
 * Holds only the values that driving sections need.
 * The factory's fake McpConnection/Exec is responsible for making validUdid "observable".
 */
export interface DrivingFixtures {
  /** A UDID the adapter (via its fake McpConnection) treats as observable. */
  validUdid: string;
  /** A UDID the adapter will NOT recognise — used to assert unknownDevice error. */
  unknownUdid: string;
  /** Injection-shaped UDID values that must be rejected (falls back to defaults). */
  injectionUdids?: readonly string[];
}

/**
 * Fixture slice for the snapshot section runner.
 * Holds only the values that snapshot sections need.
 * The factory's fake Exec is responsible for making validUdid "exist".
 */
export interface SnapshotFixtures {
  /** A UDID the adapter (via its fake Exec) treats as existing. */
  validUdid: string;
  /** A snapshot name used in the happy-path take/reset tests. */
  knownSnapshotName: string;
  /** A second distinct snapshot name for the multi-snapshot independence test. */
  knownSnapshotName2: string;
  /** A UDID the adapter will NOT recognise — used to assert unknownDevice error. */
  unknownUdid: string;
  /** Injection-shaped snapshot names that must be rejected (falls back to defaults). */
  injectionSnapshotNames?: readonly string[];
}

// ---------------------------------------------------------------------------
// ContractFixtures — full combined fixture (used by the aggregator / Fake)
// ---------------------------------------------------------------------------

/**
 * Adapter-specific fixture values injected into the contract suite.
 *
 * The Fake supplies Fake-appropriate values (e.g. `/fake/builds/…`).
 * A real MobileMcpDriver adapter supplies its own (real simulator UDID, real path).
 * This decoupling means the suite itself is **unchanged** across adapters (OCP).
 */
export interface ContractFixtures {
  /**
   * A UDID that the driver under test will recognise as a valid, pre-existing device.
   * For the Fake: DEFAULT_FAKE_UDID.  For a real adapter: a booted simulator UDID.
   */
  validUdid: string;

  /**
   * A bundle identifier that is valid for the adapter's allowlist.
   * For the Fake: "com.example.flowscout.fixture".
   */
  validBundleId: string;

  /**
   * An app bundle path that the adapter will accept for `installApp`.
   * For the Fake: "/fake/builds/Fixture.app".
   * For a real adapter: path to an actual .app on disk.
   */
  installablePath: string;

  /**
   * A snapshot name used in the happy-path snapshot / reset tests.
   * Must satisfy the adapter's name allowlist (^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$).
   */
  knownSnapshotName: string;

  /**
   * A second distinct snapshot name for the multi-snapshot independence test.
   */
  knownSnapshotName2: string;

  /**
   * A UDID that this adapter will NOT recognise — used to assert the
   * `unknownDevice` error class is thrown.
   */
  unknownUdid: string;

  /**
   * Injection-shaped UDID values that must be rejected by this adapter.
   * Falls back to the built-in default vectors if not supplied.
   */
  injectionUdids?: readonly string[];

  /**
   * Injection-shaped bundle ID values that must be rejected.
   * Falls back to built-in defaults if not supplied.
   */
  injectionBundleIds?: readonly string[];

  /**
   * Injection-shaped snapshot names that must be rejected.
   * Falls back to built-in defaults if not supplied.
   */
  injectionSnapshotNames?: readonly string[];

  /**
   * Path values that must be rejected by `installApp` (traversal / injection).
   * Falls back to built-in defaults if not supplied.
   */
  injectionAppPaths?: readonly string[];

  /**
   * Error classes this adapter throws for each error category.
   * The suite uses `toBeInstanceOf` with these so incidental throws of the
   * wrong type cannot pass the conformance gate.
   */
  errorClasses: ContractErrorClasses;
}

// ---------------------------------------------------------------------------
// Options object passed to runDriverContractSuite
// ---------------------------------------------------------------------------

/**
 * Options for `runDriverContractSuite`.
 *
 * @example
 * ```ts
 * // In your adapter's contract test file:
 * import { runDriverContractSuite, FAKE_CONTRACT_FIXTURES } from '@flowscout/adapter-mobile-mcp/testing';
 * import { FakeMobileDriver } from '@flowscout/adapter-mobile-mcp/testing';
 *
 * runDriverContractSuite({
 *   createDriver: () => new FakeMobileDriver(),
 *   fixtures: FAKE_CONTRACT_FIXTURES,
 * });
 * ```
 */
export interface DriverContractSuiteOptions {
  /** Factory producing a fresh driver for each test group. */
  createDriver: DriverFactory;
  /** Adapter-specific fixture values and error classes. */
  fixtures: ContractFixtures;
}

// ---------------------------------------------------------------------------
// Default injection test vectors (used when the adapter does not override)
// ---------------------------------------------------------------------------

/** UDID that does NOT match the UUID allowlist — used in T1 injection tests. */
const DEFAULT_INJECTION_UDIDS: readonly string[] = [
  "; rm -rf ~",
  "$(echo injected)",
  "--flag-injection",
  "",
  "a".repeat(512),
  "udid\x00with\x00nuls",
];

/** BundleIds that violate the reverse-DNS allowlist. */
const DEFAULT_INJECTION_BUNDLE_IDS: readonly string[] = [
  "; rm -rf ~",
  "bundle$(injection)",
  "--leading-dash",
  "",
  "a".repeat(512),
  "bundle\x00id",
];

/** Snapshot names that violate the ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ allowlist. */
const DEFAULT_INJECTION_SNAPSHOT_NAMES: readonly string[] = [
  "; rm -rf snapshot",
  "$(injection)",
  "--flag",
  "",
  "a".repeat(65), // exceeds max length
  "snap\x00shot",
];

/** App bundle paths containing path-traversal or injection patterns. */
const DEFAULT_INJECTION_APP_PATHS: readonly string[] = [
  "../../etc/passwd",
  "/etc/passwd",
  "../../../outside",
  "",
  "path with $(injection)",
  "a".repeat(512),
];

// ---------------------------------------------------------------------------
// §1 — Lifecycle happy-path section
// ---------------------------------------------------------------------------

function describeLifecycleHappyPath(
  getLifecycle: () => SimulatorLifecyclePartial,
  fixtures: LifecycleFixtures,
): void {
  const { validUdid, validBundleId, installablePath } = fixtures;

  describe("§1 SimulatorLifecycle — happy-path state machine", () => {
    it("bootSimulator resolves for a known synthetic UDID", async () => {
      await expect(getLifecycle().bootSimulator(validUdid)).resolves.toBeUndefined();
    });

    it("installApp resolves after boot", async () => {
      const d = getLifecycle();
      await d.bootSimulator(validUdid);
      await expect(d.installApp(validUdid, installablePath)).resolves.toBeUndefined();
    });

    it("launchApp resolves after install", async () => {
      const d = getLifecycle();
      await d.bootSimulator(validUdid);
      await d.installApp(validUdid, installablePath);
      await expect(d.launchApp(validUdid, validBundleId)).resolves.toBeUndefined();
    });

    it("shutdownSimulator resolves after boot", async () => {
      const d = getLifecycle();
      await d.bootSimulator(validUdid);
      await expect(d.shutdownSimulator(validUdid)).resolves.toBeUndefined();
    });

    it("full lifecycle: boot→install→launch→shutdown produces no error", async () => {
      const d = getLifecycle();
      await d.bootSimulator(validUdid);
      await d.installApp(validUdid, installablePath);
      await d.launchApp(validUdid, validBundleId);
      await d.shutdownSimulator(validUdid);
    });
  });
}

// ---------------------------------------------------------------------------
// §2 — Snapshot / reset section (snapshot capability only)
// ---------------------------------------------------------------------------

function describeSnapshotReset(
  getSnapshot: () => SnapshotPartial,
  fixtures: SnapshotFixtures,
  errorClasses: SnapshotErrorClasses,
): void {
  const { validUdid, knownSnapshotName, knownSnapshotName2 } = fixtures;
  const { snapshotNotFound } = errorClasses;

  describe("§2 SnapshotCapability — snapshot / reset", () => {
    it("takeSnapshot resolves for a valid device udid and snapshot name", async () => {
      await expect(
        getSnapshot().takeSnapshot(validUdid, knownSnapshotName),
      ).resolves.toBeUndefined();
    });

    it("resetToSnapshot resolves after a snapshot has been taken", async () => {
      const d = getSnapshot();
      await d.takeSnapshot(validUdid, knownSnapshotName);
      await expect(d.resetToSnapshot(validUdid, knownSnapshotName)).resolves.toBeUndefined();
    });

    it("multiple distinct snapshots can be taken and independently restored", async () => {
      const d = getSnapshot();
      await d.takeSnapshot(validUdid, knownSnapshotName);
      await d.takeSnapshot(validUdid, knownSnapshotName2);
      await expect(d.resetToSnapshot(validUdid, knownSnapshotName)).resolves.toBeUndefined();
      await expect(d.resetToSnapshot(validUdid, knownSnapshotName2)).resolves.toBeUndefined();
    });

    it("T8: resetToSnapshot to a missing name throws SnapshotNotFoundError (fails closed)", async () => {
      await expect(
        getSnapshot().resetToSnapshot(validUdid, "snapshot-that-was-never-taken"),
      ).rejects.toBeInstanceOf(snapshotNotFound);
    });

    it("T8: resetToSnapshot to a missing name provides an informative error mentioning 'snapshot'", async () => {
      const err = await getSnapshot()
        .resetToSnapshot(validUdid, "nonexistent-snapshot")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(snapshotNotFound);
      expect((err as Error).message).toMatch(/snapshot/i);
    });
  });
}

// ---------------------------------------------------------------------------
// §3 — listDevices section (lifecycle capability)
// ---------------------------------------------------------------------------

function describeListDevices(getLifecycle: () => SimulatorLifecyclePartial): void {
  describe("§3 LifecycleCapability — listDevices", () => {
    it("listDevices returns a readonly array (may be empty)", async () => {
      const devices = await getLifecycle().listDevices();
      expect(Array.isArray(devices)).toBe(true);
    });

    it("listDevices returns DeviceInfo objects with required shape", async () => {
      const devices = await getLifecycle().listDevices();
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

// ---------------------------------------------------------------------------
// §4 — Observation section (driving capability)
// ---------------------------------------------------------------------------

function describeObservation(
  getDriving: () => MobileDriverDrivingPartial,
  fixtures: DrivingFixtures,
): void {
  const { validUdid } = fixtures;

  describe("§4 DrivingCapability — observation (a11y + screenshot)", () => {
    // No cross-capability lifecycle calls here (ADR-0003 §1.2 R-A).
    // The driving factory's fake McpConnection makes validUdid observable.
    let driver: MobileDriverDrivingPartial;

    beforeEach(() => {
      driver = getDriving();
    });

    it("snapshotAccessibilityTree returns a non-empty A11ySnapshot string", async () => {
      const snapshot: A11ySnapshot = await driver.snapshotAccessibilityTree(validUdid);
      expect(typeof snapshot).toBe("string");
      expect(snapshot.length).toBeGreaterThan(0);
    });

    it("screenshot returns a non-empty Uint8Array (ScreenshotBytes)", async () => {
      const bytes: ScreenshotBytes = await driver.screenshot(validUdid);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(0);
    });
  });
}

// ---------------------------------------------------------------------------
// §5 — Actions section (driving capability)
// ---------------------------------------------------------------------------

function describeActions(
  getDriving: () => MobileDriverDrivingPartial,
  fixtures: DrivingFixtures,
): void {
  const { validUdid } = fixtures;

  describe("§5 DrivingCapability — actions (tap / typeText / swipe)", () => {
    // No cross-capability lifecycle calls here (ADR-0003 §1.2 R-A).
    // The driving factory's fake McpConnection makes validUdid observable.
    let driver: MobileDriverDrivingPartial;

    beforeEach(() => {
      driver = getDriving();
    });

    it("tap with element target resolves", async () => {
      await expect(
        driver.tap(validUdid, { kind: "element", elementId: "btn-ok" }),
      ).resolves.toBeUndefined();
    });

    it("tap with coordinate target resolves", async () => {
      await expect(
        driver.tap(validUdid, { kind: "coordinate", x: 100, y: 200 }),
      ).resolves.toBeUndefined();
    });

    it("typeText resolves", async () => {
      await expect(driver.typeText(validUdid, "hello world")).resolves.toBeUndefined();
    });

    it("swipe up/down/left/right all resolve", async () => {
      await expect(driver.swipe(validUdid, "up")).resolves.toBeUndefined();
      await expect(driver.swipe(validUdid, "down")).resolves.toBeUndefined();
      await expect(driver.swipe(validUdid, "left")).resolves.toBeUndefined();
      await expect(driver.swipe(validUdid, "right")).resolves.toBeUndefined();
    });

    it("swipe with explicit distance resolves", async () => {
      const swipeDistance = 300;
      await expect(driver.swipe(validUdid, "up", swipeDistance)).resolves.toBeUndefined();
    });
  });
}

// ---------------------------------------------------------------------------
// §6 — Unknown UDID sections (split per capability — ADR-0003 §1.2)
// ---------------------------------------------------------------------------

function describeUnknownUdidLifecycle(
  getLifecycle: () => SimulatorLifecyclePartial,
  fixtures: LifecycleFixtures,
  errorClasses: LifecycleErrorClasses,
): void {
  const { unknownUdid, validBundleId, installablePath } = fixtures;
  const { unknownDevice } = errorClasses;

  describe("§6(lifecycle) Unknown UDID — lifecycle methods reject with typed UnknownDevice error", () => {
    it("bootSimulator with unknown UDID throws UnknownDeviceError", async () => {
      await expect(getLifecycle().bootSimulator(unknownUdid)).rejects.toBeInstanceOf(unknownDevice);
    });

    it("installApp with unknown UDID throws UnknownDeviceError", async () => {
      await expect(getLifecycle().installApp(unknownUdid, installablePath)).rejects.toBeInstanceOf(
        unknownDevice,
      );
    });

    it("launchApp with unknown UDID throws UnknownDeviceError", async () => {
      await expect(getLifecycle().launchApp(unknownUdid, validBundleId)).rejects.toBeInstanceOf(
        unknownDevice,
      );
    });

    it("shutdownSimulator with unknown UDID throws UnknownDeviceError", async () => {
      await expect(getLifecycle().shutdownSimulator(unknownUdid)).rejects.toBeInstanceOf(
        unknownDevice,
      );
    });
  });
}

function describeUnknownUdidDriving(
  getDriving: () => MobileDriverDrivingPartial,
  fixtures: DrivingFixtures,
  errorClasses: DrivingErrorClasses,
): void {
  const { unknownUdid } = fixtures;
  const { unknownDevice } = errorClasses;

  describe("§6(driving) Unknown UDID — driving methods reject with typed UnknownDevice error", () => {
    it("snapshotAccessibilityTree with unknown UDID throws UnknownDeviceError", async () => {
      await expect(getDriving().snapshotAccessibilityTree(unknownUdid)).rejects.toBeInstanceOf(
        unknownDevice,
      );
    });

    it("screenshot with unknown UDID throws UnknownDeviceError", async () => {
      await expect(getDriving().screenshot(unknownUdid)).rejects.toBeInstanceOf(unknownDevice);
    });

    it("tap with unknown UDID throws UnknownDeviceError", async () => {
      await expect(
        getDriving().tap(unknownUdid, { kind: "coordinate", x: 0, y: 0 }),
      ).rejects.toBeInstanceOf(unknownDevice);
    });

    it("typeText with unknown UDID throws UnknownDeviceError", async () => {
      await expect(getDriving().typeText(unknownUdid, "text")).rejects.toBeInstanceOf(
        unknownDevice,
      );
    });

    it("swipe with unknown UDID throws UnknownDeviceError", async () => {
      await expect(getDriving().swipe(unknownUdid, "up")).rejects.toBeInstanceOf(unknownDevice);
    });
  });
}

function describeUnknownUdidSnapshot(
  getSnapshot: () => SnapshotPartial,
  fixtures: SnapshotFixtures,
  errorClasses: SnapshotErrorClasses,
): void {
  const { unknownUdid, knownSnapshotName } = fixtures;
  const { unknownDevice } = errorClasses;

  describe("§6(snapshot) Unknown UDID — snapshot methods reject with typed UnknownDevice error", () => {
    // ADR-0003 §2: device validation precedes snapshot registry lookup for BOTH operations.
    it("takeSnapshot with unknown UDID throws UnknownDeviceError", async () => {
      await expect(
        getSnapshot().takeSnapshot(unknownUdid, knownSnapshotName),
      ).rejects.toBeInstanceOf(unknownDevice);
    });

    it("resetToSnapshot with unknown UDID throws UnknownDeviceError (device-first — ADR-0003 §2)", async () => {
      await expect(
        getSnapshot().resetToSnapshot(unknownUdid, knownSnapshotName),
      ).rejects.toBeInstanceOf(unknownDevice);
    });
  });
}

// ---------------------------------------------------------------------------
// §7 — Injection UDID sections (split per capability)
// ---------------------------------------------------------------------------

function describeInjectionUdidsLifecycle(
  getLifecycle: () => SimulatorLifecyclePartial,
  fixtures: LifecycleFixtures,
  errorClasses: LifecycleErrorClasses,
): void {
  const badUdids = fixtures.injectionUdids ?? DEFAULT_INJECTION_UDIDS;
  const { invalidInput } = errorClasses;

  describe("§7(lifecycle) T1 — injection-shaped UDID values are rejected with InvalidInput error", () => {
    for (const badUdid of badUdids) {
      it(`bootSimulator rejects UDID: ${JSON.stringify(badUdid)}`, async () => {
        await expect(getLifecycle().bootSimulator(badUdid)).rejects.toBeInstanceOf(invalidInput);
      });
    }
  });
}

function describeInjectionUdidsDriving(
  getDriving: () => MobileDriverDrivingPartial,
  fixtures: DrivingFixtures,
  errorClasses: DrivingErrorClasses,
): void {
  const badUdids = fixtures.injectionUdids ?? DEFAULT_INJECTION_UDIDS;
  const { invalidInput } = errorClasses;

  describe("§7(driving) T1 — injection-shaped UDID values are rejected with InvalidInput error", () => {
    for (const badUdid of badUdids) {
      it(`snapshotAccessibilityTree rejects UDID: ${JSON.stringify(badUdid)}`, async () => {
        await expect(getDriving().snapshotAccessibilityTree(badUdid)).rejects.toBeInstanceOf(
          invalidInput,
        );
      });
      it(`screenshot rejects UDID: ${JSON.stringify(badUdid)}`, async () => {
        await expect(getDriving().screenshot(badUdid)).rejects.toBeInstanceOf(invalidInput);
      });
      it(`tap rejects UDID: ${JSON.stringify(badUdid)}`, async () => {
        await expect(
          getDriving().tap(badUdid, { kind: "coordinate", x: 0, y: 0 }),
        ).rejects.toBeInstanceOf(invalidInput);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// §8 — Injection bundleIds section (lifecycle capability)
// ---------------------------------------------------------------------------

function describeInjectionBundleIds(
  getLifecycle: () => SimulatorLifecyclePartial,
  fixtures: LifecycleFixtures,
  errorClasses: LifecycleErrorClasses,
): void {
  const { validUdid, installablePath } = fixtures;
  const badBundleIds = fixtures.injectionBundleIds ?? DEFAULT_INJECTION_BUNDLE_IDS;
  const { invalidInput } = errorClasses;

  describe("§8 T1 — injection-shaped bundleId values are rejected with InvalidInput error", () => {
    for (const badBundleId of badBundleIds) {
      it(`launchApp rejects bundleId: ${JSON.stringify(badBundleId)}`, async () => {
        const d = getLifecycle();
        await d.bootSimulator(validUdid);
        await d.installApp(validUdid, installablePath);
        await expect(d.launchApp(validUdid, badBundleId)).rejects.toBeInstanceOf(invalidInput);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// §9 — Injection snapshot names section (snapshot capability)
// ---------------------------------------------------------------------------

function describeInjectionSnapshotNames(
  getSnapshot: () => SnapshotPartial,
  fixtures: SnapshotFixtures,
  errorClasses: SnapshotErrorClasses,
): void {
  const { validUdid } = fixtures;
  const badNames = fixtures.injectionSnapshotNames ?? DEFAULT_INJECTION_SNAPSHOT_NAMES;
  const { invalidInput } = errorClasses;

  describe("§9 T1 — injection-shaped snapshotName values are rejected with InvalidInput error", () => {
    for (const badName of badNames) {
      it(`takeSnapshot rejects snapshotName: ${JSON.stringify(badName)}`, async () => {
        await expect(getSnapshot().takeSnapshot(validUdid, badName)).rejects.toBeInstanceOf(
          invalidInput,
        );
      });
      it(`resetToSnapshot rejects snapshotName: ${JSON.stringify(badName)}`, async () => {
        await expect(getSnapshot().resetToSnapshot(validUdid, badName)).rejects.toBeInstanceOf(
          invalidInput,
        );
      });
    }
  });
}

// ---------------------------------------------------------------------------
// §10 — Injection app paths section (lifecycle capability)
// ---------------------------------------------------------------------------

function describeInjectionAppPaths(
  getLifecycle: () => SimulatorLifecyclePartial,
  fixtures: LifecycleFixtures,
  errorClasses: LifecycleErrorClasses,
): void {
  const { validUdid } = fixtures;
  const badPaths = fixtures.injectionAppPaths ?? DEFAULT_INJECTION_APP_PATHS;
  const { invalidInput } = errorClasses;

  describe("§10 T1/T2 — injection-shaped appBundlePath values are rejected with InvalidInput error", () => {
    for (const badPath of badPaths) {
      it(`installApp rejects appBundlePath: ${JSON.stringify(badPath)}`, async () => {
        const d = getLifecycle();
        await d.bootSimulator(validUdid);
        await expect(d.installApp(validUdid, badPath)).rejects.toBeInstanceOf(invalidInput);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// §11 — Stress / repeat payloads section (driving capability)
// ---------------------------------------------------------------------------

function describeStressPayloads(
  getDriving: () => MobileDriverDrivingPartial,
  fixtures: DrivingFixtures,
): void {
  const { validUdid } = fixtures;

  describe("§11 T3 — observable error/payload contract under repeated calls", () => {
    // No cross-capability lifecycle calls here (ADR-0003 §1.2 R-A).
    // The driving factory's fake McpConnection makes validUdid observable.
    it("repeated snapshotAccessibilityTree calls return consistent non-empty results", async () => {
      const d = getDriving();
      const repeatCount = 3;
      for (let i = 0; i < repeatCount; i++) {
        const snap = await d.snapshotAccessibilityTree(validUdid);
        expect(typeof snap).toBe("string");
        expect(snap.length).toBeGreaterThan(0);
      }
    });

    it("repeated screenshot calls return consistent non-empty Uint8Arrays", async () => {
      const d = getDriving();
      const repeatCount = 3;
      for (let i = 0; i < repeatCount; i++) {
        const bytes = await d.screenshot(validUdid);
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes.length).toBeGreaterThan(0);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Per-capability section runners (ADR-0003 §1.1 — the new public API)
// ---------------------------------------------------------------------------

/**
 * Run the lifecycle conformance sections against any SimulatorLifecyclePartial implementation.
 *
 * Covers: §1 happy-path · §3 listDevices · §6(lifecycle) unknown-UDID ·
 *         §7(lifecycle) injection UDIDs · §8 injection bundleIds · §10 injection appPaths.
 *
 * The `createLifecycle` factory must return an instance whose fake Exec/McpConnection
 * makes `fixtures.validUdid` a recognised device and `fixtures.unknownUdid` unrecognised.
 * No cross-capability lifecycle setup is performed inside this runner (ADR-0003 §1.2 R-A).
 *
 * @example
 * ```ts
 * runLifecycleContract({
 *   createLifecycle: () => new SimulatorLifecycleManager(fakeExec, cfg),
 *   fixtures: { validUdid: 'some-uuid', unknownUdid: '...', validBundleId: '...', installablePath: '...' },
 *   errorClasses: { unknownDevice: DeviceNotFoundError, invalidInput: LifecycleInputError },
 * });
 * ```
 */
export function runLifecycleContract(opts: {
  createLifecycle: LifecycleFactory;
  fixtures: LifecycleFixtures;
  errorClasses: LifecycleErrorClasses;
}): void {
  const { createLifecycle, fixtures, errorClasses } = opts;
  const getLifecycle = (): SimulatorLifecyclePartial => createLifecycle();

  describe("SimulatorLifecycle contract suite", () => {
    describeLifecycleHappyPath(getLifecycle, fixtures);
    describeListDevices(getLifecycle);
    describeUnknownUdidLifecycle(getLifecycle, fixtures, errorClasses);
    describeInjectionUdidsLifecycle(getLifecycle, fixtures, errorClasses);
    describeInjectionBundleIds(getLifecycle, fixtures, errorClasses);
    describeInjectionAppPaths(getLifecycle, fixtures, errorClasses);
  });
}

/**
 * Run the driving conformance sections against any MobileDriverDrivingPartial implementation.
 *
 * Covers: §4 observation · §5 actions · §6(driving) unknown-UDID ·
 *         §7(driving) injection UDIDs · §11 stress/repeat payloads.
 *
 * The `createDriving` factory must return an instance whose fake McpConnection
 * makes `fixtures.validUdid` observable. No lifecycle calls (bootSimulator, etc.)
 * are performed inside this runner (ADR-0003 §1.2 R-A).
 *
 * @example
 * ```ts
 * runDrivingContract({
 *   createDriving: () => new DeviceDriver(fakeMcpConnection, cfg),
 *   fixtures: { validUdid: 'some-uuid', unknownUdid: '...' },
 *   errorClasses: { unknownDevice: DeviceNotFoundError, invalidInput: DrivingInputError },
 * });
 * ```
 */
export function runDrivingContract(opts: {
  createDriving: DrivingFactory;
  fixtures: DrivingFixtures;
  errorClasses: DrivingErrorClasses;
}): void {
  const { createDriving, fixtures, errorClasses } = opts;
  const getDriving = (): MobileDriverDrivingPartial => createDriving();

  describe("MobileDriverDriving contract suite", () => {
    describeObservation(getDriving, fixtures);
    describeActions(getDriving, fixtures);
    describeUnknownUdidDriving(getDriving, fixtures, errorClasses);
    describeInjectionUdidsDriving(getDriving, fixtures, errorClasses);
    describeStressPayloads(getDriving, fixtures);
  });
}

/**
 * Run the snapshot conformance sections against any SnapshotPartial implementation.
 *
 * Covers: §2 snapshot/reset · §6(snapshot) unknown-UDID (both take+reset throw unknownDevice
 * per ADR-0003 §2 device-first contract) · §9 injection snapshot names.
 *
 * The `createSnapshot` factory must return an instance whose fake Exec makes
 * `fixtures.validUdid` an existing device. No lifecycle calls are performed inside
 * this runner (ADR-0003 §1.2 R-A).
 *
 * @example
 * ```ts
 * runSnapshotContract({
 *   createSnapshot: () => new SnapshotManager(fakeExec, cfg),
 *   fixtures: { validUdid: 'some-uuid', knownSnapshotName: 'clean', knownSnapshotName2: 'step2', unknownUdid: '...' },
 *   errorClasses: { unknownDevice: DeviceNotFoundError, invalidInput: InvalidSnapshotInputError, snapshotNotFound: SnapshotNotFoundError },
 * });
 * ```
 */
export function runSnapshotContract(opts: {
  createSnapshot: SnapshotFactory;
  fixtures: SnapshotFixtures;
  errorClasses: SnapshotErrorClasses;
}): void {
  const { createSnapshot, fixtures, errorClasses } = opts;
  const getSnapshot = (): SnapshotPartial => createSnapshot();

  describe("SnapshotCapability contract suite", () => {
    describeSnapshotReset(getSnapshot, fixtures, errorClasses);
    describeUnknownUdidSnapshot(getSnapshot, fixtures, errorClasses);
    describeInjectionSnapshotNames(getSnapshot, fixtures, errorClasses);
  });
}

// ---------------------------------------------------------------------------
// Aggregator helpers (extracted to satisfy max-lines-per-function)
// ---------------------------------------------------------------------------

/** Derive the LifecycleFixtures slice from a combined ContractFixtures. */
function deriveLifecycleFixtures(fixtures: ContractFixtures): LifecycleFixtures {
  return {
    validUdid: fixtures.validUdid,
    validBundleId: fixtures.validBundleId,
    installablePath: fixtures.installablePath,
    unknownUdid: fixtures.unknownUdid,
    // Conditional spread satisfies exactOptionalPropertyTypes.
    ...(fixtures.injectionUdids !== undefined && { injectionUdids: fixtures.injectionUdids }),
    ...(fixtures.injectionBundleIds !== undefined && {
      injectionBundleIds: fixtures.injectionBundleIds,
    }),
    ...(fixtures.injectionAppPaths !== undefined && {
      injectionAppPaths: fixtures.injectionAppPaths,
    }),
  };
}

/** Derive the DrivingFixtures slice from a combined ContractFixtures. */
function deriveDrivingFixtures(fixtures: ContractFixtures): DrivingFixtures {
  return {
    validUdid: fixtures.validUdid,
    unknownUdid: fixtures.unknownUdid,
    ...(fixtures.injectionUdids !== undefined && { injectionUdids: fixtures.injectionUdids }),
  };
}

/** Derive the SnapshotFixtures slice from a combined ContractFixtures. */
function deriveSnapshotFixtures(fixtures: ContractFixtures): SnapshotFixtures {
  return {
    validUdid: fixtures.validUdid,
    knownSnapshotName: fixtures.knownSnapshotName,
    knownSnapshotName2: fixtures.knownSnapshotName2,
    unknownUdid: fixtures.unknownUdid,
    ...(fixtures.injectionSnapshotNames !== undefined && {
      injectionSnapshotNames: fixtures.injectionSnapshotNames,
    }),
  };
}

/**
 * Build a LifecycleFactory that delegates to a FullDriver, exposing only the lifecycle partial.
 */
function buildLifecycleFactory(createDriver: DriverFactory): LifecycleFactory {
  return () => {
    const d = createDriver();
    return {
      bootSimulator: (udid) => d.bootSimulator(udid),
      installApp: (udid, path) => d.installApp(udid, path),
      launchApp: (udid, bundleId) => d.launchApp(udid, bundleId),
      shutdownSimulator: (udid) => d.shutdownSimulator(udid),
      listDevices: () => d.listDevices(),
    };
  };
}

/**
 * Build a SnapshotFactory that delegates to a FullDriver.
 * Sets up boot+install inside the factory closure so the Fake's state machine is satisfied
 * without calling lifecycle methods inside the section runner (ADR-0003 §1.2 R-A).
 * Real snapshot adapters (#16) use a fake Exec that treats validUdid as existing, so
 * their factory does not need this setup.
 */
function buildSnapshotFactory(
  createDriver: DriverFactory,
  fixtures: ContractFixtures,
): SnapshotFactory {
  return () => {
    const d = createDriver();
    const setupDone = d
      .bootSimulator(fixtures.validUdid)
      .then(() => d.installApp(fixtures.validUdid, fixtures.installablePath));
    return {
      takeSnapshot: async (udid, name) => {
        await setupDone;
        return d.takeSnapshot(udid, name);
      },
      resetToSnapshot: async (udid, name) => {
        await setupDone;
        return d.resetToSnapshot(udid, name);
      },
    };
  };
}

/**
 * Build a DrivingFactory that delegates to a FullDriver.
 * Sets up boot+install+launch inside the factory closure so the Fake's state machine is
 * satisfied without calling lifecycle methods inside the section runner (ADR-0003 §1.2 R-A).
 */
function buildDrivingFactory(
  createDriver: DriverFactory,
  fixtures: ContractFixtures,
): DrivingFactory {
  return () => {
    const d = createDriver();
    const setupDone = d
      .bootSimulator(fixtures.validUdid)
      .then(() => d.installApp(fixtures.validUdid, fixtures.installablePath))
      .then(() => d.launchApp(fixtures.validUdid, fixtures.validBundleId));
    return {
      snapshotAccessibilityTree: async (udid) => {
        await setupDone;
        return d.snapshotAccessibilityTree(udid);
      },
      screenshot: async (udid) => {
        await setupDone;
        return d.screenshot(udid);
      },
      tap: async (udid, target) => {
        await setupDone;
        return d.tap(udid, target);
      },
      typeText: async (udid, text) => {
        await setupDone;
        return d.typeText(udid, text);
      },
      swipe: async (udid, dir, dist) => {
        await setupDone;
        return d.swipe(udid, dir, dist);
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Full-driver aggregator (thin wrapper — preserves the Fake's call site)
// ---------------------------------------------------------------------------

/**
 * Run the full driver conformance suite against any FullDriver implementation.
 *
 * This is the RETAINED thin aggregator per ADR-0003 §1.1. It destructures the
 * FullDriver into the three capability partials and delegates to the three
 * per-capability section runners. The Fake's existing call site
 * (`fake-driver.contract.test.ts`) continues to work unchanged.
 *
 * For new real adapters implementing a single capability, use the targeted runner
 * instead (runLifecycleContract / runDrivingContract / runSnapshotContract).
 *
 * @param options.createDriver - factory producing a fresh FullDriver for each test group
 * @param options.fixtures     - adapter-specific fixture values and error classes
 *
 * @example
 * ```ts
 * // In your adapter's contract test file:
 * import { runDriverContractSuite, FAKE_CONTRACT_FIXTURES } from '@flowscout/adapter-mobile-mcp/testing';
 * import { FakeMobileDriver } from '@flowscout/adapter-mobile-mcp/testing';
 *
 * runDriverContractSuite({
 *   createDriver: () => new FakeMobileDriver(),
 *   fixtures: FAKE_CONTRACT_FIXTURES,
 * });
 * ```
 */
export function runDriverContractSuite(options: DriverContractSuiteOptions): void {
  const { createDriver, fixtures } = options;
  const { errorClasses } = fixtures;

  const lifecycleErrorClasses: LifecycleErrorClasses = {
    unknownDevice: errorClasses.unknownDevice,
    invalidInput: errorClasses.invalidInput,
  };
  const drivingErrorClasses: DrivingErrorClasses = {
    unknownDevice: errorClasses.unknownDevice,
    invalidInput: errorClasses.invalidInput,
  };
  const snapshotErrorClasses: SnapshotErrorClasses = {
    unknownDevice: errorClasses.unknownDevice,
    invalidInput: errorClasses.invalidInput,
    snapshotNotFound: errorClasses.snapshotNotFound,
  };

  describe("MobileDriverPort + SimulatorLifecycle contract suite", () => {
    runLifecycleContract({
      createLifecycle: buildLifecycleFactory(createDriver),
      fixtures: deriveLifecycleFixtures(fixtures),
      errorClasses: lifecycleErrorClasses,
    });

    runSnapshotContract({
      createSnapshot: buildSnapshotFactory(createDriver, fixtures),
      fixtures: deriveSnapshotFixtures(fixtures),
      errorClasses: snapshotErrorClasses,
    });

    runDrivingContract({
      createDriving: buildDrivingFactory(createDriver, fixtures),
      fixtures: deriveDrivingFixtures(fixtures),
      errorClasses: drivingErrorClasses,
    });
  });
}
