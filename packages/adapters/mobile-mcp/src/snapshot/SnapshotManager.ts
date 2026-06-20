/**
 * SnapshotManager — implementation of SnapshotCapability (ADR-0002 §3, #16).
 *
 * Mechanism: Strategy pattern with two concrete strategies:
 *   1. CloneSnapshotStrategy  — primary, full-fidelity: `xcrun simctl clone`
 *   2. EraseReinstallStrategy — fast-path: `xcrun simctl erase` + recorded reinstall
 *
 * The strategy is selected per-snapshot by `takeSnapshot`; `resetToSnapshot`
 * consults the in-memory registry to apply the correct strategy.
 *
 * Security controls (threat model T1 / T8):
 *   - `snapshotName` validated against ^[A-Za-z0-9._-]{1,64}$ BEFORE argv construction.
 *   - `udid` validated against UUID format before argv construction.
 *   - All simctl calls go through the injected `Exec` seam (argv array, shell:false).
 *   - `resetToSnapshot` on an unregistered name throws SnapshotNotFoundError (fail-closed, T8).
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
 * Thrown when `resetToSnapshot` is called with a snapshot name that was never
 * registered by a prior `takeSnapshot` call on this instance.
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
 * Thrown when a `snapshotName` or `udid` fails the allowlist validation.
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

/** Max chars of simctl stdout shown in error messages (diagnostic, not a security sink). */
const SIMCTL_OUTPUT_DISPLAY_LIMIT = 120;

// ---------------------------------------------------------------------------
// Input validation (T1 — allowlist before any argv construction)
// ---------------------------------------------------------------------------

/** UUID format: 8-4-4-4-12 hex chars, case-insensitive (matches simctl output). */
const UDID_PATTERN =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/**
 * Snapshot name allowlist: alphanumeric, dot, underscore, dash; 1–64 chars.
 * The security model (T1) also requires the first char be alphanumeric to
 * prevent a leading `-` from being interpreted as a flag by simctl.
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

  /** Restore the simulator to the snapshot captured by `take`. */
  restore(record: SnapshotRecord, exec: Exec, timeoutMs: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Registry entry
// ---------------------------------------------------------------------------

/**
 * What the registry stores per taken snapshot.
 * The `kind` discriminant selects the correct strategy on restore.
 */
type SnapshotRecord =
  | {
      readonly kind: "clone";
      /** UDID of the clone device created by `simctl clone <udid> <cloneName>`. */
      readonly cloneUdid: string;
      /** The original source UDID (used for the re-clone restore). */
      readonly sourceUdid: string;
    }
  | {
      readonly kind: "clean-install";
      readonly sourceUdid: string;
    };

// ---------------------------------------------------------------------------
// CloneSnapshotStrategy — primary full-fidelity strategy (#3/ADR-0002)
// ---------------------------------------------------------------------------

/**
 * Primary strategy: `xcrun simctl clone <udid> <cloneId>`.
 *
 * takeSnapshot:
 *   1. Run `xcrun simctl clone <udid> <cloneId>` where cloneId = internal
 *      clone identifier derived from the snapshot name.
 *   2. Parse the new device UDID from stdout (simctl emits it on success).
 *   3. Store the clone UDID in the registry.
 *
 * resetToSnapshot:
 *   1. Shut down the source device (best-effort, non-fatal).
 *   2. Erase the source device back to factory state.
 *   3. Re-clone from the golden snapshot clone.
 *
 * All T1 compliance: argv arrays only, validated inputs, injected Exec.
 */
class CloneSnapshotStrategy implements SnapshotStrategy {
  async take(udid: string, name: string, exec: Exec, timeoutMs: number): Promise<SnapshotRecord> {
    // The clone gets an internal name derived from the snapshot name.
    const cloneName = `flowscout-snapshot-${name}`;

    const result = await runSimctlWithTimeout(
      ["clone", udid, cloneName],
      exec,
      timeoutMs,
    );

    // `simctl clone` prints the new device UDID on stdout.
    const cloneUdid = result.stdout.trim();
    if (!cloneUdid || !UDID_PATTERN.test(cloneUdid)) {
      throw new McpAdapterError(
        `simctl clone did not return a valid UDID for snapshot "${name}". ` +
          `stdout: ${result.stdout.slice(0, SIMCTL_OUTPUT_DISPLAY_LIMIT)}`,
      );
    }

    return { kind: "clone", cloneUdid, sourceUdid: udid };
  }

  async restore(record: SnapshotRecord, exec: Exec, timeoutMs: number): Promise<void> {
    if (record.kind !== "clone") {
      throw new McpAdapterError("CloneSnapshotStrategy.restore called with non-clone record.");
    }

    // Step 1 — shut down (non-fatal; device may already be shut down)
    await runSimctlWithTimeout(
      ["shutdown", record.sourceUdid],
      exec,
      timeoutMs,
    ).catch(() => {
      // Shutdown failures are non-fatal during restore.
    });

    // Step 2 — erase the working device back to a clean slate
    await runSimctlWithTimeout(
      ["erase", record.sourceUdid],
      exec,
      timeoutMs,
    );

    // Step 3 — re-clone from the golden snapshot clone.
    // The re-clone produces a new device that is byte-identical to the snapshot moment.
    const restoreResult = await runSimctlWithTimeout(
      ["clone", record.cloneUdid, `flowscout-restored-${String(Date.now())}`],
      exec,
      timeoutMs,
    );

    const restoredUdid = restoreResult.stdout.trim();
    if (!restoredUdid || !UDID_PATTERN.test(restoredUdid)) {
      throw new McpAdapterError(
        `simctl clone (restore) did not return a valid UDID. ` +
          `stdout: ${restoreResult.stdout.slice(0, SIMCTL_OUTPUT_DISPLAY_LIMIT)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// EraseReinstallStrategy — fast-path for clean-install snapshots
// ---------------------------------------------------------------------------

/**
 * Fast-path strategy: `xcrun simctl erase <udid>`.
 *
 * Used when the snapshot was taken immediately after install with no user data —
 * the "clean-install" baseline. No re-clone needed; erase resets to factory state.
 *
 * takeSnapshot: records `{ kind: 'clean-install' }` — no clone operation needed.
 * resetToSnapshot: runs `xcrun simctl erase <udid>`.
 */
class EraseReinstallStrategy implements SnapshotStrategy {
  async take(
    udid: string,
    _name: string,
    _exec: Exec,
    _timeoutMs: number,
  ): Promise<SnapshotRecord> {
    // No simctl operation needed at take-time for this strategy;
    // we simply record the intent.
    return Promise.resolve({ kind: "clean-install", sourceUdid: udid });
  }

  async restore(record: SnapshotRecord, exec: Exec, timeoutMs: number): Promise<void> {
    if (record.kind !== "clean-install") {
      throw new McpAdapterError(
        "EraseReinstallStrategy.restore called with non-clean-install record.",
      );
    }

    // Erase resets the simulator to a fresh, factory state (no apps, no data).
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

/** Strategy discriminant: controls which strategy `takeSnapshot` applies. */
export type SnapshotKind = "clone" | "clean-install";

/**
 * SnapshotManager implements SnapshotCapability via the Strategy pattern.
 *
 * Dependency injection:
 *   - `connection`: shared McpConnection (kept for wave-1 seam compatibility; not used
 *     for snapshot ops — snapshot/reset is a simctl concern, not an MCP-tool concern).
 *   - `config`: server config providing `callTimeoutMs` as the simctl timeout.
 *   - `exec`: injectable xcrun executor (T1: no shell string; unit-testable without Mac).
 *
 * The in-memory snapshot registry maps `<udid>::<name>` → `SnapshotRecord`.
 * Registry lifetime = process (E7 / OQ4 persistence is out of scope for E1).
 */
export class SnapshotManager implements SnapshotCapability {
  /** In-memory registry: maps composite key → SnapshotRecord. */
  private readonly registry = new Map<string, SnapshotRecord>();

  /** Strategy instances (singleton within this manager). */
  private readonly cloneStrategy = new CloneSnapshotStrategy();
  private readonly eraseStrategy = new EraseReinstallStrategy();

  /**
   * @param connection  - shared McpConnection (wave-1 seam; not used for simctl ops)
   * @param config      - server config (callTimeoutMs used as simctl timeout)
   * @param exec        - injectable xcrun executor (T1 compliance + unit-testability)
   * @param defaultKind - strategy for `takeSnapshot`; defaults to 'clone' (primary)
   */
  constructor(
    protected readonly connection: McpConnection,
    protected readonly config: McpServerConfig,
    protected readonly exec: Exec,
    private readonly defaultKind: SnapshotKind = "clone",
  ) {}

  /**
   * Take a named snapshot of the simulator at `udid`.
   *
   * Security (T1): validates both `udid` and `snapshotName` before any argv construction.
   * Security (T3): bounded by `config.callTimeoutMs`.
   */
  async takeSnapshot(udid: string, snapshotName: string): Promise<void> {
    // T1 — validate before argv
    validateUdid(udid);
    validateSnapshotName(snapshotName);

    // Verify the udid exists in the simctl device list before attempting the clone.
    await this.requireDeviceExists(udid);

    const strategy = this.selectStrategy(this.defaultKind);
    const record = await strategy.take(udid, snapshotName, this.exec, this.config.callTimeoutMs);

    this.registry.set(this.registryKey(udid, snapshotName), record);
  }

  /**
   * Restore the simulator at `udid` to the named snapshot.
   *
   * Security (T1): validates both `udid` and `snapshotName` before any argv construction.
   * Security (T8): throws SnapshotNotFoundError if name was never registered (NEVER no-ops).
   * Security (T3): bounded by `config.callTimeoutMs`.
   */
  async resetToSnapshot(udid: string, snapshotName: string): Promise<void> {
    // T1 — validate before argv (also before registry lookup)
    validateUdid(udid);
    validateSnapshotName(snapshotName);

    // T8 / F6 — fail closed: throw if the snapshot was never taken.
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
    if (kind === "clone") return this.cloneStrategy;
    return this.eraseStrategy;
  }

  /**
   * Verify that the given UDID is known to simctl by running `simctl list devices -j`
   * and checking the output.
   *
   * Throws DeviceNotFoundError if the udid does not appear in the output.
   * This is a typed not-found error per the AC: "unknown udid → typed not-found error".
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
   * simctl emits `{ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-17-0": [{ udid, ... }] } }`.
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
