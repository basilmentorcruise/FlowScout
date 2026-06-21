/**
 * SnapshotManager — implementation of SnapshotCapability (ADR-0002 §3, #16).
 *
 * Mechanism: Strategy pattern with two concrete strategies:
 *   1. EraseReinstallStrategy — primary: `xcrun simctl erase` + `xcrun simctl install` to
 *      restore the working UDID in place to the snapshotted state.
 *   2. CleanInstallStrategy   — fast-path: `xcrun simctl erase` only (for a pure factory-
 *      reset baseline with no installed apps).
 *
 * Why clone-based restore is NOT used:
 *   `xcrun simctl clone` creates a NEW device with a NEW UDID. There is no `simctl` command
 *   that clones INTO an existing UDID. Because `resetToSnapshot(udid, name)` returns void
 *   and the CALLER continues using the same udid, a clone-based restore would leave
 *   the working UDID wiped (erased) and the new clone stranded with an unused UDID.
 *
 * EraseReinstallStrategy — the correct in-place restore mechanism:
 *   takeSnapshot: record the installed app bundle path (supplied at construction time).
 *   resetToSnapshot: `simctl shutdown <udid>` (non-fatal) -> `simctl erase <udid>` (wipes to
 *     factory, in-place on the SAME udid) -> `simctl install <udid> <appPath>` (reinstalls the
 *     captured .app) so the same udid returns to the snapshotted clean state.
 *
 * CleanInstallStrategy — factory-reset baseline (no app reinstall):
 *   takeSnapshot: no-op (records intent only).
 *   resetToSnapshot: `simctl shutdown <udid>` (non-fatal) -> `simctl erase <udid>`.
 *   The same udid is preserved at factory-clean state.
 *
 * Security controls (threat model T1 / T8):
 *   - snapshotName validated against ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ BEFORE argv construction.
 *   - udid validated against UUID format before argv construction.
 *   - All simctl calls go through the injected Exec seam (argv array, shell:false).
 *   - resetToSnapshot verifies the device exists (DeviceNotFoundError) BEFORE the registry
 *     lookup — device-first contract per ADR-0003 §2.
 *   - resetToSnapshot on a known udid with an unregistered name throws SnapshotNotFoundError
 *     (fail-closed, T8).
 *   - All ops bounded by config-injected timeout (T3).
 */

import type { SnapshotCapability } from "../connection/capabilities.js";
import type { McpConnection } from "../connection/McpConnection.js";
import type { McpServerConfig } from "../connection/connection-config.js";
import type { Exec } from "../simctl.js";
import { runSimctlWithTimeout } from "../simctl.js";
import { McpAdapterError, DeviceNotFoundError } from "../connection/errors.js";

// ---------------------------------------------------------------------------
// Snapshot-specific error type (extends #12 base — DRY per ADR-0002 §2.4)
// ---------------------------------------------------------------------------

/**
 * Thrown when resetToSnapshot is called with a snapshot name that was never
 * registered by a prior takeSnapshot call on this instance.
 *
 * T8 / F6 safety backstop: must NEVER be a silent no-op.
 */
export class SnapshotNotFoundError extends McpAdapterError {
  constructor(
    public readonly snapshotName: string,
    public readonly udid: string,
  ) {
    super(
      `SnapshotNotFoundError: no snapshot named "${snapshotName}" was recorded for device ${udid}. ` +
        `Call takeSnapshot first. resetToSnapshot fails closed (T8 / F6 safety control).`,
    );
    this.name = "SnapshotNotFoundError";
  }
}

/**
 * Thrown when a snapshotName or udid fails the allowlist validation.
 * Extends McpAdapterError so callers can catch the base and still distinguish.
 */
export class InvalidSnapshotInputError extends McpAdapterError {
  constructor(field: string, value: unknown) {
    super(
      `InvalidSnapshotInputError: "${field}" value failed validation — ` +
        `value rejected to prevent argument injection (T1 threat model). ` +
        `received: ${JSON.stringify(String(value)).slice(0, VALIDATION_DISPLAY_LIMIT)}`,
    );
    this.name = "InvalidSnapshotInputError";
  }
}

// ---------------------------------------------------------------------------
// Error message display limits (named constants — no magic numbers per ADR-0001 §6)
// ---------------------------------------------------------------------------

/** Max chars from a field value shown in validation error messages (truncated for safety). */
const VALIDATION_DISPLAY_LIMIT = 60;

// ---------------------------------------------------------------------------
// Input validation (T1 — allowlist before any argv construction)
// ---------------------------------------------------------------------------

/** UUID format: 8-4-4-4-12 hex chars, case-insensitive (matches simctl output). */
const UDID_PATTERN =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/**
 * Snapshot name allowlist: alphanumeric, dot, underscore, dash; 1-64 chars.
 * The security model (T1) also requires the first char be alphanumeric to
 * prevent a leading '-' from being interpreted as a flag by simctl.
 */
const SNAPSHOT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validateUdid(udid: string): void {
  if (!UDID_PATTERN.test(udid)) {
    throw new InvalidSnapshotInputError("udid", udid);
  }
}

function validateSnapshotName(name: string): void {
  if (!SNAPSHOT_NAME_PATTERN.test(name)) {
    throw new InvalidSnapshotInputError("snapshotName", name);
  }
}

// ---------------------------------------------------------------------------
// Strategy interface (OCP: future mechanisms added by extension, not modification)
// ---------------------------------------------------------------------------

/**
 * Internal snapshot strategy contract.
 * Each strategy encapsulates ONE take+restore mechanism;
 * the SnapshotManager selects at take-time and dispatches at reset-time.
 */
interface SnapshotStrategy {
  /** Execute the snapshot operation and return the opaque record needed to restore. */
  take(udid: string, name: string, exec: Exec, timeoutMs: number): Promise<SnapshotRecord>;

  /**
   * Restore the simulator IN PLACE to the snapshot captured by take.
   * The restore MUST operate on the same UDID — it must not change the device identity.
   */
  restore(record: SnapshotRecord, exec: Exec, timeoutMs: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Registry entry
// ---------------------------------------------------------------------------

/**
 * What the registry stores per taken snapshot.
 * The kind discriminant selects the correct strategy on restore.
 *
 * erase-reinstall: erase the device then reinstall the captured app bundle.
 *   Used when an app bundle path was provided at SnapshotManager construction time.
 *
 * clean-install: erase only (factory reset, no app reinstall).
 *   Used when no app bundle path is available — resets to clean factory state.
 */
type SnapshotRecord =
  | {
      readonly kind: "erase-reinstall";
      /** The working device UDID that will be erased+reinstalled in place. */
      readonly sourceUdid: string;
      /**
       * The .app bundle path captured at take-time.
       * Used by simctl install <udid> <appBundlePath> during restore.
       */
      readonly appBundlePath: string;
    }
  | {
      readonly kind: "clean-install";
      /** The working device UDID that will be erased (factory-reset) in place. */
      readonly sourceUdid: string;
    };

// ---------------------------------------------------------------------------
// EraseReinstallStrategy — primary in-place restore strategy
// ---------------------------------------------------------------------------

/**
 * Primary strategy: erase the working device then reinstall the captured .app bundle.
 *
 * Why this is correct and clone-based restore is not:
 *   xcrun simctl clone creates a NEW device with a NEW UDID. There is no simctl command
 *   that clones INTO an existing UDID. The caller of resetToSnapshot keeps using the SAME
 *   udid, so a clone-based restore would leave the working UDID wiped and the newly-cloned
 *   device stranded. This strategy avoids that entirely by using erase+install in-place.
 *
 * takeSnapshot (no simctl op):
 *   Records { kind: 'erase-reinstall', sourceUdid, appBundlePath }.
 *   The app bundle path is provided at SnapshotManager construction time.
 *
 * resetToSnapshot — exact simctl argv sequence issued (in order):
 *   1. xcrun simctl shutdown <sourceUdid>            (non-fatal; may already be shut down)
 *   2. xcrun simctl erase <sourceUdid>               factory-resets the device IN PLACE;
 *      the SAME udid is preserved with a clean filesystem.
 *   3. xcrun simctl install <sourceUdid> <appPath>   reinstalls the captured .app;
 *      the SAME udid now reflects the snapshotted clean state with the app present.
 *
 * Repeated take->mutate->reset cycles:
 *   Each reset issues the same shutdown->erase->install sequence on the same udid,
 *   producing the identical clean baseline every time.
 *
 * All T1 compliance: argv arrays only, validated inputs, injected Exec.
 */
class EraseReinstallStrategy implements SnapshotStrategy {
  constructor(private readonly appBundlePath: string) {}

  async take(
    udid: string,
    _name: string,
    _exec: Exec,
    _timeoutMs: number,
  ): Promise<SnapshotRecord> {
    // No simctl op at take-time; record the app path to reinstall on restore.
    return Promise.resolve({
      kind: "erase-reinstall",
      sourceUdid: udid,
      appBundlePath: this.appBundlePath,
    });
  }

  async restore(record: SnapshotRecord, exec: Exec, timeoutMs: number): Promise<void> {
    if (record.kind !== "erase-reinstall") {
      throw new McpAdapterError(
        "EraseReinstallStrategy.restore called with non-erase-reinstall record.",
      );
    }

    // Step 1 — shut down (non-fatal; device may already be shut down).
    await runSimctlWithTimeout(
      ["shutdown", record.sourceUdid],
      exec,
      timeoutMs,
    ).catch(() => {
      // Shutdown failures are non-fatal during restore.
    });

    // Step 2 — erase: factory-resets the device IN PLACE on the SAME udid.
    await runSimctlWithTimeout(
      ["erase", record.sourceUdid],
      exec,
      timeoutMs,
    );

    // Step 3 — reinstall the captured .app so the same udid reflects the snapshotted state.
    await runSimctlWithTimeout(
      ["install", record.sourceUdid, record.appBundlePath],
      exec,
      timeoutMs,
    );
  }
}

// ---------------------------------------------------------------------------
// CleanInstallStrategy — fast-path for factory-reset-only baselines
// ---------------------------------------------------------------------------

/**
 * Fast-path strategy: erase only (no app reinstall).
 *
 * Used when no app bundle path is available — the baseline is simply a factory-clean
 * device with no user data and no installed apps.
 *
 * takeSnapshot (no simctl op):
 *   Records { kind: 'clean-install', sourceUdid }.
 *
 * resetToSnapshot — exact simctl argv sequence issued (in order):
 *   1. xcrun simctl shutdown <sourceUdid>   (non-fatal; may already be shut down)
 *   2. xcrun simctl erase <sourceUdid>      factory-resets the device IN PLACE.
 *      The SAME udid is preserved; the device is now at clean factory state.
 *
 * Like EraseReinstallStrategy, repeated cycles issue the same sequence on the same udid.
 */
class CleanInstallStrategy implements SnapshotStrategy {
  async take(
    udid: string,
    _name: string,
    _exec: Exec,
    _timeoutMs: number,
  ): Promise<SnapshotRecord> {
    return Promise.resolve({ kind: "clean-install", sourceUdid: udid });
  }

  async restore(record: SnapshotRecord, exec: Exec, timeoutMs: number): Promise<void> {
    if (record.kind !== "clean-install") {
      throw new McpAdapterError(
        "CleanInstallStrategy.restore called with non-clean-install record.",
      );
    }

    // Step 1 — shut down (non-fatal; device may already be shut down).
    await runSimctlWithTimeout(
      ["shutdown", record.sourceUdid],
      exec,
      timeoutMs,
    ).catch(() => {
      // Shutdown failures are non-fatal during restore.
    });

    // Step 2 — erase resets the device to factory state IN PLACE on the SAME udid.
    await runSimctlWithTimeout(
      ["erase", record.sourceUdid],
      exec,
      timeoutMs,
    );
  }
}

// ---------------------------------------------------------------------------
// SnapshotManager — the exported SnapshotCapability implementation
// ---------------------------------------------------------------------------

/** Strategy discriminant: controls which strategy takeSnapshot applies. */
export type SnapshotKind = "erase-reinstall" | "clean-install";

/**
 * SnapshotManager implements SnapshotCapability via the Strategy pattern.
 *
 * Dependency injection:
 *   - connection: shared McpConnection (kept for wave-1 seam compatibility; not used
 *     for snapshot ops — snapshot/reset is a simctl concern, not an MCP-tool concern).
 *   - config: server config providing callTimeoutMs as the simctl timeout.
 *   - exec: injectable xcrun executor (T1: no shell string; unit-testable without Mac).
 *   - appBundlePath: optional .app path; when provided, the default strategy is
 *     'erase-reinstall' (shutdown->erase->install on the same udid). When null/omitted,
 *     the default strategy is 'clean-install' (shutdown->erase only).
 *
 * ADR-0003 §2 — device-first contract:
 *   Both takeSnapshot and resetToSnapshot call requireDeviceExists AFTER input
 *   validation and BEFORE the registry lookup. An unknown UDID always throws
 *   DeviceNotFoundError, whether or not a matching snapshot record exists.
 *   A known UDID with an unknown snapshot name throws SnapshotNotFoundError (T8).
 *
 * The in-memory snapshot registry maps <udid>::<name> -> SnapshotRecord.
 * Registry lifetime = process (E7 / OQ4 persistence is out of scope for E1).
 */
export class SnapshotManager implements SnapshotCapability {
  /** In-memory registry: maps composite key -> SnapshotRecord. */
  private readonly registry = new Map<string, SnapshotRecord>();

  /** Strategy instances (singleton within this manager). */
  private readonly eraseReinstallStrategy: EraseReinstallStrategy | null;
  private readonly cleanInstallStrategy = new CleanInstallStrategy();

  /** The effective default strategy kind (resolved from constructor args). */
  private readonly resolvedKind: SnapshotKind;

  /**
   * @param connection    - shared McpConnection (wave-1 seam; not used for simctl ops)
   * @param config        - server config (callTimeoutMs used as simctl timeout)
   * @param exec          - injectable xcrun executor (T1 compliance + unit-testability)
   * @param appBundlePath - optional path to the .app bundle to reinstall on restore.
   *                        When provided, 'erase-reinstall' is the default strategy
   *                        (shutdown->erase->install). When omitted/null, 'clean-install'
   *                        is the default (shutdown->erase only).
   */
  constructor(
    protected readonly connection: McpConnection,
    protected readonly config: McpServerConfig,
    protected readonly exec: Exec,
    appBundlePath: string | null = null,
  ) {
    if (appBundlePath !== null) {
      this.eraseReinstallStrategy = new EraseReinstallStrategy(appBundlePath);
      this.resolvedKind = "erase-reinstall";
    } else {
      this.eraseReinstallStrategy = null;
      this.resolvedKind = "clean-install";
    }
  }

  /**
   * Take a named snapshot of the simulator at udid.
   *
   * Security (T1): validates both udid and snapshotName before any argv construction.
   * ADR-0003 §2: verifies device existence AFTER input validation, BEFORE any operation.
   * Security (T3): bounded by config.callTimeoutMs.
   */
  async takeSnapshot(udid: string, snapshotName: string): Promise<void> {
    // T1 — validate before argv
    validateUdid(udid);
    validateSnapshotName(snapshotName);

    // ADR-0003 §2 — device-first: verify the udid exists before any operation.
    await this.requireDeviceExists(udid);

    const strategy = this.selectStrategy(this.resolvedKind);
    const record = await strategy.take(udid, snapshotName, this.exec, this.config.callTimeoutMs);

    this.registry.set(this.registryKey(udid, snapshotName), record);
  }

  /**
   * Restore the simulator at udid to the named snapshot.
   *
   * Security (T1): validates both udid and snapshotName before any argv construction.
   * ADR-0003 §2 — device-first: verifies device existence AFTER input validation, BEFORE
   *   the registry lookup. Unknown UDID -> DeviceNotFoundError regardless of registry state.
   * Security (T8): throws SnapshotNotFoundError if device is known but name was never
   *   registered (NEVER no-ops — known-device + unknown-snapshot is the T8 case).
   * Security (T3): bounded by config.callTimeoutMs.
   */
  async resetToSnapshot(udid: string, snapshotName: string): Promise<void> {
    // T1 — validate before argv (also before registry lookup)
    validateUdid(udid);
    validateSnapshotName(snapshotName);

    // ADR-0003 §2 — device-first: throw DeviceNotFoundError for unknown UDID,
    // regardless of whether a matching snapshot record exists in the registry.
    await this.requireDeviceExists(udid);

    // T8 / F6 — fail closed: throw if the snapshot was never taken.
    // Reached only when the device is known (passed requireDeviceExists above).
    const record = this.registry.get(this.registryKey(udid, snapshotName));
    if (!record) {
      throw new SnapshotNotFoundError(snapshotName, udid);
    }

    const strategy = this.selectStrategy(record.kind);
    await strategy.restore(record, this.exec, this.config.callTimeoutMs);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Composite registry key: <udid>::<snapshotName>. */
  private registryKey(udid: string, name: string): string {
    return `${udid}::${name}`;
  }

  /** Select the concrete strategy matching the requested kind. */
  private selectStrategy(kind: SnapshotKind): SnapshotStrategy {
    if (kind === "erase-reinstall") {
      if (!this.eraseReinstallStrategy) {
        throw new McpAdapterError(
          `EraseReinstallStrategy selected but no appBundlePath was provided. ` +
            `Pass an appBundlePath to the SnapshotManager constructor to use 'erase-reinstall'.`,
        );
      }
      return this.eraseReinstallStrategy;
    }
    return this.cleanInstallStrategy;
  }

  /**
   * Verify that the given UDID is known to simctl by running simctl list devices --json
   * and checking the output.
   *
   * Throws DeviceNotFoundError if the udid does not appear in the output.
   * This is a typed not-found error per the AC: "unknown udid -> typed not-found error".
   */
  private async requireDeviceExists(udid: string): Promise<void> {
    const result = await runSimctlWithTimeout(
      ["list", "devices", "--json"],
      this.exec,
      this.config.callTimeoutMs,
    );

    // Parse JSON output and search for the udid.
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout) as unknown;
    } catch {
      throw new McpAdapterError(
        `Failed to parse simctl list output while looking up device ${udid}.`,
      );
    }

    if (!this.containsUdid(parsed, udid)) {
      throw new DeviceNotFoundError(udid);
    }
  }

  /**
   * Recursively search the simctl JSON output for the given UDID.
   * simctl emits { devices: { "com.apple.CoreSimulator.SimRuntime.iOS-17-0": [{ udid, ... }] } }.
   */
  private containsUdid(parsed: unknown, udid: string): boolean {
    if (typeof parsed !== "object" || parsed === null) return false;

    if (Array.isArray(parsed)) {
      return parsed.some((item) => this.containsUdid(item, udid));
    }

    const obj = parsed as Record<string, unknown>;

    // Check if this object is a device record with the matching udid field.
    if (typeof obj["udid"] === "string" && obj["udid"] === udid) {
      return true;
    }

    // Recurse into all values.
    return Object.values(obj).some((val) => this.containsUdid(val, udid));
  }
}
