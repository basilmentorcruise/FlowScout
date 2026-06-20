/**
 * Parameterised contract-test suite for MobileDriverPort + SimulatorLifecycle.
 *
 * This is the single source of conformance every concrete driver implementation
 * (FakeMobileDriver now; real capability modules #14/#15/#16 later) must pass.
 *
 * Usage (import in your test file):
 *   import { runDriverContractSuite, FAKE_CONTRACT_FIXTURES } from '@flowscout/adapter-mobile-mcp/testing';
 *   runDriverContractSuite({
 *     createDriver: () => new MyDriver(),
 *     fixtures: MY_ADAPTER_FIXTURES,   // supply adapter-specific fixtures
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
// ErrorClasses — injected so assertions are adapter-specific, not hardcoded
// ---------------------------------------------------------------------------

/**
 * Constructor type compatible with `toBeInstanceOf`.
 * Using `new (...args: never[]) => Error` keeps it concrete-class-agnostic.
 */
export type ErrorConstructor = new (...args: never[]) => Error;

/**
 * Error classes injected alongside fixtures so the suite can assert
 * `toBeInstanceOf(SomeError)` without knowing the adapter's concrete error types.
 *
 * Each real adapter (and the Fake) supplies its own error classes; the contract
 * guarantees the correct *category* is thrown even as the class name differs.
 */
export interface ContractErrorClasses {
  /**
   * Thrown when an operation targets a UDID that this adapter does not know
   * (e.g. UnknownDeviceError for the Fake, DeviceNotFoundError for a real adapter).
   */
  unknownDevice: ErrorConstructor;

  /**
   * Thrown when an input value fails allowlist / format validation
   * (e.g. InvalidInputError, ValidationError).  Covers T1/T2 injection cases.
   */
  invalidInput: ErrorConstructor;

  /**
   * Thrown when resetToSnapshot is called for a snapshot name that was never
   * taken on this driver instance (T8 fail-closed requirement).
   */
  snapshotNotFound: ErrorConstructor;
}

// ---------------------------------------------------------------------------
// ContractFixtures — the adapter-specific values the suite plugs into tests
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
// Sub-suite helpers (decomposed to satisfy max-lines-per-function)
// ---------------------------------------------------------------------------

function describeLifecycleHappyPath(
  getDriver: () => FullDriver,
  fixtures: ContractFixtures,
): void {
  const { validUdid, validBundleId, installablePath } = fixtures;

  describe("§1 SimulatorLifecycle — happy-path state machine", () => {
    it("bootSimulator resolves for a known synthetic UDID", async () => {
      await expect(getDriver().bootSimulator(validUdid)).resolves.toBeUndefined();
    });

    it("installApp resolves after boot", async () => {
      const d = getDriver();
      await d.bootSimulator(validUdid);
      await expect(d.installApp(validUdid, installablePath)).resolves.toBeUndefined();
    });

    it("launchApp resolves after install", async () => {
      const d = getDriver();
      await d.bootSimulator(validUdid);
      await d.installApp(validUdid, installablePath);
      await expect(d.launchApp(validUdid, validBundleId)).resolves.toBeUndefined();
    });

    it("shutdownSimulator resolves after boot", async () => {
      const d = getDriver();
      await d.bootSimulator(validUdid);
      await expect(d.shutdownSimulator(validUdid)).resolves.toBeUndefined();
    });

    it("full lifecycle: boot→install→launch→snapshot→reset→shutdown produces no error", async () => {
      const { knownSnapshotName } = fixtures;
      const d = getDriver();
      await d.bootSimulator(validUdid);
      await d.installApp(validUdid, installablePath);
      await d.launchApp(validUdid, validBundleId);
      await d.takeSnapshot(validUdid, knownSnapshotName);
      await d.resetToSnapshot(validUdid, knownSnapshotName);
      await d.shutdownSimulator(validUdid);
    });
  });
}

function describeSnapshotReset(
  getDriver: () => FullDriver,
  fixtures: ContractFixtures,
): void {
  const { validUdid, validBundleId, installablePath, knownSnapshotName, knownSnapshotName2 } =
    fixtures;
  const { snapshotNotFound } = fixtures.errorClasses;

  describe("§2 SimulatorLifecycle — snapshot / reset", () => {
    it("takeSnapshot resolves after the simulator is in a usable state", async () => {
      const d = getDriver();
      await d.bootSimulator(validUdid);
      await d.installApp(validUdid, installablePath);
      await expect(d.takeSnapshot(validUdid, knownSnapshotName)).resolves.toBeUndefined();
    });

    it("resetToSnapshot resolves after a snapshot has been taken", async () => {
      const d = getDriver();
      await d.bootSimulator(validUdid);
      await d.installApp(validUdid, installablePath);
      await d.takeSnapshot(validUdid, knownSnapshotName);
      await expect(d.resetToSnapshot(validUdid, knownSnapshotName)).resolves.toBeUndefined();
    });

    it("multiple distinct snapshots can be taken and independently restored", async () => {
      const d = getDriver();
      await d.bootSimulator(validUdid);
      await d.installApp(validUdid, installablePath);
      await d.takeSnapshot(validUdid, knownSnapshotName);
      await d.takeSnapshot(validUdid, knownSnapshotName2);
      await expect(d.resetToSnapshot(validUdid, knownSnapshotName)).resolves.toBeUndefined();
      await expect(d.resetToSnapshot(validUdid, knownSnapshotName2)).resolves.toBeUndefined();
    });

    it("T8: resetToSnapshot to a missing name throws SnapshotNotFoundError (fails closed)", async () => {
      const d = getDriver();
      await d.bootSimulator(validUdid);
      await expect(
        d.resetToSnapshot(validUdid, "snapshot-that-was-never-taken"),
      ).rejects.toBeInstanceOf(snapshotNotFound);
    });

    it("T8: resetToSnapshot to a missing name provides an informative error mentioning 'snapshot'", async () => {
      const d = getDriver();
      await d.bootSimulator(validUdid);
      const err = await d
        .resetToSnapshot(validUdid, "nonexistent-snapshot")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(snapshotNotFound);
      expect((err as Error).message).toMatch(/snapshot/i);
    });

    it("T8: launchApp with valid bundleId after install resolves (sanity)", async () => {
      const d = getDriver();
      await d.bootSimulator(validUdid);
      await d.installApp(validUdid, installablePath);
      await expect(d.launchApp(validUdid, validBundleId)).resolves.toBeUndefined();
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

function describeObservation(
  getDriver: () => FullDriver,
  fixtures: ContractFixtures,
): void {
  const { validUdid, validBundleId, installablePath } = fixtures;

  describe("§4 MobileDriverPort — observation (a11y + screenshot)", () => {
    let driver: FullDriver;

    beforeEach(async () => {
      driver = getDriver();
      await driver.bootSimulator(validUdid);
      await driver.installApp(validUdid, installablePath);
      await driver.launchApp(validUdid, validBundleId);
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

function describeActions(
  getDriver: () => FullDriver,
  fixtures: ContractFixtures,
): void {
  const { validUdid, validBundleId, installablePath } = fixtures;

  describe("§5 MobileDriverPort — actions (tap / typeText / swipe)", () => {
    let driver: FullDriver;

    beforeEach(async () => {
      driver = getDriver();
      await driver.bootSimulator(validUdid);
      await driver.installApp(validUdid, installablePath);
      await driver.launchApp(validUdid, validBundleId);
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

function describeUnknownUdid(
  getDriver: () => FullDriver,
  fixtures: ContractFixtures,
): void {
  const { unknownUdid, validBundleId, knownSnapshotName, installablePath } = fixtures;
  const { unknownDevice } = fixtures.errorClasses;

  describe("§6 Unknown UDID — all port methods reject with typed UnknownDevice error", () => {
    it("bootSimulator with unknown UDID throws UnknownDeviceError", async () => {
      await expect(getDriver().bootSimulator(unknownUdid)).rejects.toBeInstanceOf(unknownDevice);
    });

    it("snapshotAccessibilityTree with unknown UDID throws UnknownDeviceError", async () => {
      await expect(
        getDriver().snapshotAccessibilityTree(unknownUdid),
      ).rejects.toBeInstanceOf(unknownDevice);
    });

    it("screenshot with unknown UDID throws UnknownDeviceError", async () => {
      await expect(getDriver().screenshot(unknownUdid)).rejects.toBeInstanceOf(unknownDevice);
    });

    it("tap with unknown UDID throws UnknownDeviceError", async () => {
      await expect(
        getDriver().tap(unknownUdid, { kind: "coordinate", x: 0, y: 0 }),
      ).rejects.toBeInstanceOf(unknownDevice);
    });

    it("typeText with unknown UDID throws UnknownDeviceError", async () => {
      await expect(
        getDriver().typeText(unknownUdid, "text"),
      ).rejects.toBeInstanceOf(unknownDevice);
    });

    it("swipe with unknown UDID throws UnknownDeviceError", async () => {
      await expect(getDriver().swipe(unknownUdid, "up")).rejects.toBeInstanceOf(unknownDevice);
    });

    it("installApp with unknown UDID throws UnknownDeviceError", async () => {
      await expect(
        getDriver().installApp(unknownUdid, installablePath),
      ).rejects.toBeInstanceOf(unknownDevice);
    });

    it("launchApp with unknown UDID throws UnknownDeviceError", async () => {
      await expect(
        getDriver().launchApp(unknownUdid, validBundleId),
      ).rejects.toBeInstanceOf(unknownDevice);
    });

    it("takeSnapshot with unknown UDID throws UnknownDeviceError", async () => {
      await expect(
        getDriver().takeSnapshot(unknownUdid, knownSnapshotName),
      ).rejects.toBeInstanceOf(unknownDevice);
    });

    it("resetToSnapshot with unknown UDID throws UnknownDeviceError", async () => {
      await expect(
        getDriver().resetToSnapshot(unknownUdid, knownSnapshotName),
      ).rejects.toBeInstanceOf(unknownDevice);
    });

    it("shutdownSimulator with unknown UDID throws UnknownDeviceError", async () => {
      await expect(
        getDriver().shutdownSimulator(unknownUdid),
      ).rejects.toBeInstanceOf(unknownDevice);
    });
  });
}

function describeInjectionUdids(
  getDriver: () => FullDriver,
  fixtures: ContractFixtures,
): void {
  const badUdids = fixtures.injectionUdids ?? DEFAULT_INJECTION_UDIDS;
  const { invalidInput } = fixtures.errorClasses;

  describe("§7 T1 — injection-shaped UDID values are rejected with InvalidInput error", () => {
    for (const badUdid of badUdids) {
      it(`bootSimulator rejects UDID: ${JSON.stringify(badUdid)}`, async () => {
        await expect(getDriver().bootSimulator(badUdid)).rejects.toBeInstanceOf(invalidInput);
      });
      it(`snapshotAccessibilityTree rejects UDID: ${JSON.stringify(badUdid)}`, async () => {
        await expect(
          getDriver().snapshotAccessibilityTree(badUdid),
        ).rejects.toBeInstanceOf(invalidInput);
      });
      it(`screenshot rejects UDID: ${JSON.stringify(badUdid)}`, async () => {
        await expect(getDriver().screenshot(badUdid)).rejects.toBeInstanceOf(invalidInput);
      });
    }
  });
}

function describeInjectionBundleIds(
  getDriver: () => FullDriver,
  fixtures: ContractFixtures,
): void {
  const { validUdid, installablePath } = fixtures;
  const badBundleIds = fixtures.injectionBundleIds ?? DEFAULT_INJECTION_BUNDLE_IDS;
  const { invalidInput } = fixtures.errorClasses;

  describe("§8 T1 — injection-shaped bundleId values are rejected with InvalidInput error", () => {
    for (const badBundleId of badBundleIds) {
      it(`launchApp rejects bundleId: ${JSON.stringify(badBundleId)}`, async () => {
        const d = getDriver();
        await d.bootSimulator(validUdid);
        await d.installApp(validUdid, installablePath);
        await expect(d.launchApp(validUdid, badBundleId)).rejects.toBeInstanceOf(invalidInput);
      });
    }
  });
}

function describeInjectionSnapshotNames(
  getDriver: () => FullDriver,
  fixtures: ContractFixtures,
): void {
  const { validUdid } = fixtures;
  const badNames = fixtures.injectionSnapshotNames ?? DEFAULT_INJECTION_SNAPSHOT_NAMES;
  const { invalidInput } = fixtures.errorClasses;

  describe("§9 T1 — injection-shaped snapshotName values are rejected with InvalidInput error", () => {
    for (const badName of badNames) {
      it(`takeSnapshot rejects snapshotName: ${JSON.stringify(badName)}`, async () => {
        const d = getDriver();
        await d.bootSimulator(validUdid);
        await expect(d.takeSnapshot(validUdid, badName)).rejects.toBeInstanceOf(invalidInput);
      });
      it(`resetToSnapshot rejects snapshotName: ${JSON.stringify(badName)}`, async () => {
        const d = getDriver();
        await d.bootSimulator(validUdid);
        await expect(d.resetToSnapshot(validUdid, badName)).rejects.toBeInstanceOf(invalidInput);
      });
    }
  });
}

function describeInjectionAppPaths(
  getDriver: () => FullDriver,
  fixtures: ContractFixtures,
): void {
  const { validUdid } = fixtures;
  const badPaths = fixtures.injectionAppPaths ?? DEFAULT_INJECTION_APP_PATHS;
  const { invalidInput } = fixtures.errorClasses;

  describe("§10 T1/T2 — injection-shaped appBundlePath values are rejected with InvalidInput error", () => {
    for (const badPath of badPaths) {
      it(`installApp rejects appBundlePath: ${JSON.stringify(badPath)}`, async () => {
        const d = getDriver();
        await d.bootSimulator(validUdid);
        await expect(d.installApp(validUdid, badPath)).rejects.toBeInstanceOf(invalidInput);
      });
    }
  });
}

function describeStressPayloads(
  getDriver: () => FullDriver,
  fixtures: ContractFixtures,
): void {
  const { validUdid, validBundleId, installablePath } = fixtures;

  describe("§11 T3 — observable error/payload contract under repeated calls", () => {
    it("repeated snapshotAccessibilityTree calls return consistent non-empty results", async () => {
      const d = getDriver();
      await d.bootSimulator(validUdid);
      await d.installApp(validUdid, installablePath);
      await d.launchApp(validUdid, validBundleId);
      const repeatCount = 3;
      for (let i = 0; i < repeatCount; i++) {
        const snap = await d.snapshotAccessibilityTree(validUdid);
        expect(typeof snap).toBe("string");
        expect(snap.length).toBeGreaterThan(0);
      }
    });

    it("repeated screenshot calls return consistent non-empty Uint8Arrays", async () => {
      const d = getDriver();
      await d.bootSimulator(validUdid);
      await d.installApp(validUdid, installablePath);
      await d.launchApp(validUdid, validBundleId);
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
// The exported parameterised suite
// ---------------------------------------------------------------------------

/**
 * Run the full driver conformance suite against any FullDriver implementation.
 *
 * Call at the top level of a test file (or inside a describe block).
 *
 * @param options.createDriver - factory producing a fresh driver for each test group
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

  describe("MobileDriverPort + SimulatorLifecycle contract suite", () => {
    // Each sub-suite receives a fresh driver via a closure.
    const getDriver = (): FullDriver => createDriver();

    describeLifecycleHappyPath(getDriver, fixtures);
    describeSnapshotReset(getDriver, fixtures);
    describeListDevices(getDriver);
    describeObservation(getDriver, fixtures);
    describeActions(getDriver, fixtures);
    describeUnknownUdid(getDriver, fixtures);
    describeInjectionUdids(getDriver, fixtures);
    describeInjectionBundleIds(getDriver, fixtures);
    describeInjectionSnapshotNames(getDriver, fixtures);
    describeInjectionAppPaths(getDriver, fixtures);
    describeStressPayloads(getDriver, fixtures);
  });
}
