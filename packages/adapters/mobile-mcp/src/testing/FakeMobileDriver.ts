/**
 * FakeMobileDriver — deterministic in-memory implementation of both
 * MobileDriverPort and SimulatorLifecycle for use in tests.
 *
 * Design:
 *   - Models simulator state (booted / app-installed / app-launched) as an
 *     explicit state machine so tests can assert observable transitions.
 *   - Records all driving actions (tap/typeText/swipe) for assertion.
 *   - Returns purely synthetic canned payloads (T9: no real identifiers, PII,
 *     tokens, or personal paths).
 *   - Validates all inputs with the same allowlists as the real adapter to make
 *     the contract-test security cases pass (T1, T2, T8).
 *   - Maintains an in-memory snapshot registry so resetToSnapshot correctly
 *     fails-closed on an unknown name (T8).
 *   - Injected UDID allowlist: by default, one synthetic UDID is known; more
 *     can be registered via `registerDevice()` for multi-device tests.
 *
 * Security posture:
 *   - No real identifiers in canned data (T9: synthetic only).
 *   - All inputs validated before use; injection-shaped values throw
 *     InvalidInputError (T1/T2).
 *   - resetToSnapshot to unknown name throws SnapshotNotFoundError (T8).
 *   - typeText text is never logged anywhere in this file (T5).
 */

import type {
  MobileDriverPort,
  SimulatorLifecycle,
  DeviceInfo,
  TapTarget,
  SwipeDirection,
  A11ySnapshot,
  ScreenshotBytes,
} from "@flowscout/domain";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Base error for all FakeMobileDriver failures. */
export class FakeDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FakeDriverError";
  }
}

/** Thrown when an operation is called with an unknown (unregistered) UDID. */
export class UnknownDeviceError extends FakeDriverError {
  constructor(udid: string) {
    super(`UnknownDeviceError: device with UDID "${udid}" is not registered in FakeMobileDriver`);
    this.name = "UnknownDeviceError";
  }
}

/** Thrown when a reset is attempted for a snapshot name that was never taken (T8). */
export class SnapshotNotFoundError extends FakeDriverError {
  constructor(snapshotName: string) {
    super(
      `SnapshotNotFoundError: no snapshot with name "${snapshotName}" exists — ` +
        `resetToSnapshot fails closed (T8 threat model)`,
    );
    this.name = "SnapshotNotFoundError";
  }
}

/** Thrown when an input value fails allowlist validation (T1/T2). */
export class InvalidInputError extends FakeDriverError {
  constructor(field: string, value: unknown) {
    super(
      `InvalidInputError: "${field}" value failed validation — ` +
        `value rejected to prevent injection/traversal (T1/T2 threat model); ` +
        `received: ${JSON.stringify(String(value)).slice(0, 60)}`,
    );
    this.name = "InvalidInputError";
  }
}

// ---------------------------------------------------------------------------
// Simulator state
// ---------------------------------------------------------------------------

type SimulatorState = "shutdown" | "booted" | "app-installed" | "app-launched";

interface SimulatorRecord {
  udid: string;
  name: string;
  osVersion: string;
  state: SimulatorState;
  installedBundlePath: string | null;
  launchedBundleId: string | null;
}

// ---------------------------------------------------------------------------
// Recorded action types (for test assertion)
// ---------------------------------------------------------------------------

export type RecordedAction =
  | { readonly kind: "tap"; readonly udid: string; readonly target: TapTarget }
  | { readonly kind: "typeText"; readonly udid: string } // text NOT recorded — T5
  | {
      readonly kind: "swipe";
      readonly udid: string;
      readonly direction: SwipeDirection;
      readonly distance: number | undefined;
    };

// ---------------------------------------------------------------------------
// Input validation (mirrors the real adapter's allowlists per threat model)
// ---------------------------------------------------------------------------

/** UUID format: 8-4-4-4-12 hex chars, case-insensitive. */
const UDID_PATTERN =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/** Reverse-DNS bundle ID: dot-separated alphanumeric/dash segments. */
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
/** Maximum length for a reverse-DNS bundle identifier. */
const BUNDLE_ID_MAX_LENGTH = 255;

/**
 * Snapshot name: alphanumeric, dot, underscore, dash; max 64 chars.
 * Must NOT begin with '-' (argument-injection guard per T1 threat model).
 * The pattern anchors on an alphanumeric first character for this reason.
 */
const SNAPSHOT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * App bundle path: must end in .app and start with the Fake's allowed prefix.
 * For the Fake we use /fake/ as the allowed prefix (no real paths).
 */
const FAKE_APP_PATH_ALLOWED_PREFIX = "/fake/";
/** Maximum length for an app bundle path in the Fake. */
const FAKE_APP_PATH_MAX_LENGTH = 256;

function validateUdid(udid: string): void {
  if (!UDID_PATTERN.test(udid)) {
    throw new InvalidInputError("udid", udid);
  }
}

function validateBundleId(bundleId: string): void {
  if (
    !bundleId ||
    bundleId.length > BUNDLE_ID_MAX_LENGTH ||
    !BUNDLE_ID_PATTERN.test(bundleId) ||
    bundleId.startsWith("-")
  ) {
    throw new InvalidInputError("bundleId", bundleId);
  }
}

function validateSnapshotName(name: string): void {
  if (!SNAPSHOT_NAME_PATTERN.test(name)) {
    throw new InvalidInputError("snapshotName", name);
  }
}

function validateAppBundlePath(path: string): void {
  if (
    !path ||
    !path.endsWith(".app") ||
    path.includes("..") ||
    !path.startsWith(FAKE_APP_PATH_ALLOWED_PREFIX) ||
    path.length > FAKE_APP_PATH_MAX_LENGTH
  ) {
    throw new InvalidInputError("appBundlePath", path);
  }
}

// ---------------------------------------------------------------------------
// Synthetic canned payloads (T9: no real identifiers or PII)
// ---------------------------------------------------------------------------

/** Synthetic a11y snapshot — plainly fake XML-like structure. */
const CANNED_A11Y_SNAPSHOT = (`<AXApplication title="FlowScout Fixture" role="AXApplication">` +
  `<AXButton title="OK" role="AXButton" identifier="btn-ok"/>` +
  `<AXStaticText value="Hello from synthetic fixture" role="AXStaticText"/>` +
  `</AXApplication>`) as A11ySnapshot;

/**
 * Minimal valid PNG bytes: 1×1 white pixel.
 * Signature + IHDR + IDAT (1 white pixel) + IEND.
 * Must be declared before CANNED_SCREENSHOT_BYTES to avoid TDZ error.
 */
// prettier-ignore
const SYNTHETIC_PNG_BYTES: readonly number[] = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // width=1, height=1
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // bit depth, color type, CRC
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT chunk
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, // IDAT data
  0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, // IDAT CRC
  0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, // IEND chunk
  0x44, 0xae, 0x42, 0x60, 0x82,                   // IEND CRC
];

/** Build the 1×1 synthetic PNG byte array. Isolated to keep the class slim. */
function buildSyntheticPng(): ScreenshotBytes {
  return new Uint8Array(SYNTHETIC_PNG_BYTES);
}

/** Synthetic screenshot: minimal valid 1×1 white PNG (T9: no real image). */
const CANNED_SCREENSHOT_BYTES: ScreenshotBytes = buildSyntheticPng();

// ---------------------------------------------------------------------------
// Default registered device (synthetic, no real UDID)
// ---------------------------------------------------------------------------

/** The one pre-registered synthetic device. Tests can register more. */
export const DEFAULT_FAKE_UDID = "00000000-0000-0000-0000-000000000001";

// ---------------------------------------------------------------------------
// State mapping helper (pure function, outside the class for line-count budget)
// ---------------------------------------------------------------------------

/** Maps the internal four-state enum to the domain's three-state DeviceInfo.state. */
const SIM_STATE_TO_DEVICE_STATE: Record<SimulatorState, "booted" | "shutdown" | "unknown"> = {
  shutdown: "shutdown",
  booted: "booted",
  "app-installed": "booted",
  "app-launched": "booted",
};

function mapSimStateToDeviceState(state: SimulatorState): "booted" | "shutdown" | "unknown" {
  return SIM_STATE_TO_DEVICE_STATE[state];
}

// ---------------------------------------------------------------------------
// FakeMobileDriver
// ---------------------------------------------------------------------------

/**
 * In-memory deterministic implementation of MobileDriverPort + SimulatorLifecycle.
 *
 * By default one device (DEFAULT_FAKE_UDID) is pre-registered.
 * Call `registerDevice()` to add more.
 *
 * All driving actions are recorded in `recordedActions`; tests may read these
 * to assert what the caller did without mocking individual methods.
 */
export class FakeMobileDriver implements MobileDriverPort, SimulatorLifecycle {
  /** All driving actions recorded in order. typeText entries omit the text (T5). */
  public readonly recordedActions: RecordedAction[] = [];

  /** In-memory simulator registry. Key = udid. */
  private readonly simulators = new Map<string, SimulatorRecord>();

  /** In-memory snapshot registry. Key = `${udid}::${snapshotName}`. */
  private readonly snapshots = new Set<string>();

  constructor() {
    // Register the default synthetic device
    this.registerDevice(DEFAULT_FAKE_UDID, "FlowScout Synthetic iPhone 16", "18.0");
  }

  /**
   * Register an additional synthetic device so tests can model multi-device scenarios.
   * Use only synthetic UDIDs (no real device UDIDs).
   */
  registerDevice(udid: string, name: string, osVersion: string): void {
    this.simulators.set(udid, {
      udid,
      name,
      osVersion,
      state: "shutdown",
      installedBundlePath: null,
      launchedBundleId: null,
    });
  }

  // -------------------------------------------------------------------------
  // MobileDriverPort
  // -------------------------------------------------------------------------

  listDevices(): Promise<readonly DeviceInfo[]> {
    const devices: DeviceInfo[] = Array.from(this.simulators.values()).map((sim) => ({
      udid: sim.udid,
      name: sim.name,
      platform: "ios" as const,
      osVersion: sim.osVersion,
      state: mapSimStateToDeviceState(sim.state),
    }));
    return Promise.resolve(devices);
  }

  snapshotAccessibilityTree(udid: string): Promise<A11ySnapshot> {
    return this.attempt(() => {
      validateUdid(udid);
      this.requireDevice(udid);
      return CANNED_A11Y_SNAPSHOT;
    });
  }

  screenshot(udid: string): Promise<ScreenshotBytes> {
    return this.attempt(() => {
      validateUdid(udid);
      this.requireDevice(udid);
      return CANNED_SCREENSHOT_BYTES;
    });
  }

  tap(udid: string, target: TapTarget): Promise<void> {
    return this.attempt(() => {
      validateUdid(udid);
      this.requireDevice(udid);
      this.recordedActions.push({ kind: "tap", udid, target });
    });
  }

  typeText(udid: string, _text: string): Promise<void> {
    // _text intentionally unused here — T5: never log typeText text.
    return this.attempt(() => {
      validateUdid(udid);
      this.requireDevice(udid);
      this.recordedActions.push({ kind: "typeText", udid });
    });
  }

  swipe(udid: string, direction: SwipeDirection, distance?: number): Promise<void> {
    return this.attempt(() => {
      validateUdid(udid);
      this.requireDevice(udid);
      this.recordedActions.push({ kind: "swipe", udid, direction, distance });
    });
  }

  // -------------------------------------------------------------------------
  // SimulatorLifecycle
  // -------------------------------------------------------------------------

  bootSimulator(udid: string): Promise<void> {
    return this.attempt(() => {
      validateUdid(udid);
      const sim = this.requireDevice(udid);
      sim.state = "booted";
    });
  }

  installApp(udid: string, appBundlePath: string): Promise<void> {
    return this.attempt(() => {
      validateUdid(udid);
      validateAppBundlePath(appBundlePath);
      const sim = this.requireDevice(udid);
      sim.installedBundlePath = appBundlePath;
      sim.state = "app-installed";
    });
  }

  launchApp(udid: string, bundleId: string): Promise<void> {
    return this.attempt(() => {
      validateUdid(udid);
      validateBundleId(bundleId);
      const sim = this.requireDevice(udid);
      sim.launchedBundleId = bundleId;
      sim.state = "app-launched";
    });
  }

  takeSnapshot(udid: string, snapshotName: string): Promise<void> {
    return this.attempt(() => {
      validateUdid(udid);
      validateSnapshotName(snapshotName);
      this.requireDevice(udid);
      this.snapshots.add(this.snapshotKey(udid, snapshotName));
    });
  }

  resetToSnapshot(udid: string, snapshotName: string): Promise<void> {
    return this.attempt(() => {
      validateUdid(udid);
      validateSnapshotName(snapshotName);
      this.requireDevice(udid);
      if (!this.snapshots.has(this.snapshotKey(udid, snapshotName))) {
        // T8: fail closed — never silently no-op on an unknown snapshot name.
        throw new SnapshotNotFoundError(snapshotName);
      }
      // In the Fake, "restore" is a no-op on state (already modelled
      // by what happened before the snapshot was taken). Real adapters clone/restore.
    });
  }

  shutdownSimulator(udid: string): Promise<void> {
    return this.attempt(() => {
      validateUdid(udid);
      const sim = this.requireDevice(udid);
      sim.state = "shutdown";
      sim.launchedBundleId = null;
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Retrieve a registered simulator or throw UnknownDeviceError. */
  private requireDevice(udid: string): SimulatorRecord {
    const sim = this.simulators.get(udid);
    if (!sim) {
      throw new UnknownDeviceError(udid);
    }
    return sim;
  }

  /** Composite key for the snapshot registry. */
  private snapshotKey(udid: string, name: string): string {
    return `${udid}::${name}`;
  }

  /**
   * Wrap a synchronous operation in a Promise so synchronous validation throws
   * (e.g. from validateUdid / requireDevice) surface as rejected Promises rather
   * than synchronous exceptions. This ensures `.rejects.toThrow()` catches them
   * and callers that only await the return value see a uniform async contract.
   */
  private attempt<T>(fn: () => T): Promise<T> {
    try {
      return Promise.resolve(fn());
    } catch (err) {
      // All throws in this class are FakeDriverError subclasses (which extend Error).
      // We re-throw as a rejected Promise to satisfy the uniform async contract.
      const error = err instanceof Error ? err : new FakeDriverError(String(err));
      return Promise.reject(error);
    }
  }
}
