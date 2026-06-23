/**
 * SimulatorLifecycleManager — real implementation of LifecycleCapability (#14 E1.3).
 *
 * Tool-vs-simctl mapping (ADR-0002 §4/OQ2):
 *   listDevices        → simctl fallback: `xcrun simctl list devices --json`
 *   bootSimulator      → simctl fallback: `xcrun simctl boot <udid>`
 *   installApp         → simctl fallback: `xcrun simctl install <udid> <path>`
 *   launchApp          → simctl fallback: `xcrun simctl launch <udid> <bundleId>`
 *   shutdownSimulator  → simctl fallback: `xcrun simctl shutdown <udid>`
 *
 * Rationale: device lifecycle (boot/install/launch/erase) is a host-level concern
 * that `simctl` owns natively.  No mobile-mcp tool covers these operations
 * (ADR-0002 §4 table: "device lifecycle is a host concern, not an in-app MCP tool").
 *
 * Security controls (threat model E1):
 *   T1 — validate udid (UUID) and bundleId (reverse-DNS) before any simctl call;
 *         reject any value beginning with '-'; execFile argv-array only (no shell string).
 *   T2 — installApp: canonicalize appBundlePath with realpath, confine to config-
 *         allowlisted base dir (FLOWSCOUT_APP_BUNDLE_DIR env / constructor param),
 *         require readable .app directory, reject traversal/symlinks escaping the base.
 *   T3 — all operations bounded by config.callTimeoutMs (no magic numbers).
 *   T5 — log only udid (not the raw input value that triggered an error) to avoid
 *         echoing injection payloads or partial secrets in log output.
 *   T8 — shutdownSimulator propagates a typed error so callers can log and retry;
 *         "already shutdown" is silently treated as success (idempotent, no orphan).
 *
 * Error taxonomy (declared here; extend #12 base — DRY):
 *   DeviceNotFoundError  — unknown udid (from #12 errors.ts)
 *   InstallFailedError   — .app path invalid or simctl install failed
 *   LaunchFailedError    — simctl launch failed (distinct from install failure)
 *   LifecycleInputError  — udid / bundleId / path fails allowlist (T1/T2)
 *
 * Constructor signature matches the Wave-1 seam defined in the #12 stub:
 *   (connection, config, exec)
 * An optional fourth param `appBundleBaseDir` is accepted for DI in tests.
 * When omitted, it defaults to the FLOWSCOUT_APP_BUNDLE_DIR env var or os.tmpdir().
 */

import * as fsSync from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";
import type { DeviceInfo } from "@flowscout/domain";
import type { LifecycleCapability } from "../connection/capabilities.js";
import type { McpServerConfig } from "../connection/connection-config.js";
import type { McpConnection } from "../connection/McpConnection.js";
import { DeviceNotFoundError, McpAdapterError } from "../connection/errors.js";
import { runSimctlWithTimeout } from "../simctl.js";
import type { Exec } from "../simctl.js";

// ---------------------------------------------------------------------------
// Capability-specific error types (ADR-0002 §2.4 — declared in owner file)
// ---------------------------------------------------------------------------

/** Thrown when an input value fails allowlist / format validation (T1/T2). */
export class LifecycleInputError extends McpAdapterError {
  constructor(field: string, reason: string) {
    // T5: include field name and reason, NOT the raw value, to prevent injection
    // payloads or partial secrets from appearing in logs.
    super(`Invalid '${field}': ${reason}`);
    this.name = "LifecycleInputError";
  }
}

/** Thrown when installApp fails (bad path or simctl install error). */
export class InstallFailedError extends McpAdapterError {
  constructor(reason: string, rootCause?: unknown) {
    super(`App installation failed: ${reason}`, rootCause);
    this.name = "InstallFailedError";
  }
}

/**
 * Thrown when launchApp fails (simctl launch error).
 * Distinct from InstallFailedError so callers can distinguish install vs launch failures.
 */
export class LaunchFailedError extends McpAdapterError {
  constructor(reason: string, rootCause?: unknown) {
    super(`App launch failed: ${reason}`, rootCause);
    this.name = "LaunchFailedError";
  }
}

// ---------------------------------------------------------------------------
// Validation helpers (T1/T2 allowlists)
// ---------------------------------------------------------------------------

/** UUID format: 8-4-4-4-12 hex chars, case-insensitive. */
const UDID_PATTERN =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/** Reverse-DNS bundle ID: dot-separated alphanumeric / dash / underscore segments. */
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const BUNDLE_ID_MAX_LENGTH = 255;

/** Maximum filesystem path length (practical limit). */
const APP_PATH_MAX_LENGTH = 4096;

/**
 * Validate UDID against the UUID allowlist (T1).
 * Throws LifecycleInputError when the value is invalid.
 * Rejects empty strings, leading-dash values, and non-UUID patterns.
 */
function validateUdid(udid: string): void {
  if (!udid || udid.startsWith("-") || !UDID_PATTERN.test(udid)) {
    throw new LifecycleInputError(
      "udid",
      "must be a UUID (8-4-4-4-12 hex groups) with no leading dash",
    );
  }
}

/**
 * Validate bundleId against the reverse-DNS allowlist (T1).
 * Throws LifecycleInputError when the value is invalid.
 */
function validateBundleId(bundleId: string): void {
  if (
    !bundleId ||
    bundleId.startsWith("-") ||
    bundleId.length > BUNDLE_ID_MAX_LENGTH ||
    !BUNDLE_ID_PATTERN.test(bundleId)
  ) {
    throw new LifecycleInputError(
      "bundleId",
      "must match reverse-DNS format ([A-Za-z0-9._-]+, max 255 chars, no leading dash)",
    );
  }
}

/**
 * Validate the basic format of the app bundle path (no FS access).
 * Throws LifecycleInputError for empty / too-long / non-.app values.
 */
function validateAppPathFormat(rawPath: string): void {
  if (!rawPath || rawPath.length > APP_PATH_MAX_LENGTH) {
    throw new LifecycleInputError("appBundlePath", "path is empty or exceeds maximum length");
  }
  if (!rawPath.endsWith(".app")) {
    throw new LifecycleInputError("appBundlePath", "must end with '.app'");
  }
}

/**
 * Resolve a path to its canonical realpath.
 * Throws InstallFailedError if the path cannot be resolved (ENOENT, EACCES, etc.)
 * T5: the raw path is NOT echoed in the error message.
 */
async function resolveRealpath(p: string): Promise<string> {
  try {
    return await fsPromises.realpath(p);
  } catch {
    throw new InstallFailedError(
      "app bundle path could not be resolved — check it exists and is accessible",
    );
  }
}

/**
 * Resolve the canonical base directory for confinement checks.
 * Throws LifecycleInputError if the base dir itself cannot be resolved.
 */
async function resolveCanonicalBase(baseDir: string): Promise<string> {
  try {
    return await fsPromises.realpath(baseDir);
  } catch {
    throw new LifecycleInputError(
      "appBundlePath",
      "allowlisted base directory could not be resolved — check FLOWSCOUT_APP_BUNDLE_DIR",
    );
  }
}

/**
 * Check that the canonical path is confined within the canonical base directory.
 * Throws LifecycleInputError on path traversal / confinement violation.
 *
 * Appends path.sep to the base to avoid false positives where the path starts with
 * the base as a string prefix but is actually outside it:
 *   base=/builds, path=/builds-extra/x → must NOT pass.
 */
function assertConfined(canonicalPath: string, canonicalBase: string): void {
  const withSep = canonicalBase.endsWith(nodePath.sep)
    ? canonicalBase
    : canonicalBase + nodePath.sep;
  const confined = canonicalPath.startsWith(withSep) || canonicalPath === canonicalBase;
  if (!confined) {
    throw new LifecycleInputError(
      "appBundlePath",
      "resolved path escapes the allowlisted app bundle base directory (path traversal rejected)",
    );
  }
}

/**
 * Verify the canonical path is a readable directory (required for .app bundles).
 * Throws InstallFailedError for stat failures, non-directory, or unreadable paths.
 */
async function assertReadableDirectory(canonicalPath: string): Promise<void> {
  let stat: fsSync.Stats;
  try {
    stat = await fsPromises.stat(canonicalPath);
  } catch {
    throw new InstallFailedError("app bundle path could not be stat-ed — check file permissions");
  }
  if (!stat.isDirectory()) {
    throw new InstallFailedError(
      "app bundle path is not a directory (expected an '.app' bundle directory)",
    );
  }
  try {
    await fsPromises.access(canonicalPath, fsSync.constants.R_OK);
  } catch {
    throw new InstallFailedError("app bundle directory is not readable");
  }
}

/**
 * Canonicalize and validate the app bundle path (T2 — path traversal defence).
 *
 * Delegates to focused helpers to stay within complexity limits:
 *   1. Format check (no FS access) — validateAppPathFormat
 *   2. Realpath resolution         — resolveRealpath
 *   3. Confinement check           — resolveCanonicalBase + assertConfined
 *   4. Readable-directory check    — assertReadableDirectory
 *
 * Returns the canonical absolute path for use in simctl install.
 * Throws LifecycleInputError for format / traversal / confinement violations (T1/T2).
 * Throws InstallFailedError for FS access failures.
 * T5: raw path values are never echoed in error messages.
 */
async function canonicalizeAppPath(rawPath: string, baseDir: string): Promise<string> {
  validateAppPathFormat(rawPath); // Step 1
  const canonicalPath = await resolveRealpath(rawPath); // Step 2
  const canonicalBase = await resolveCanonicalBase(baseDir); // Step 3a
  assertConfined(canonicalPath, canonicalBase); // Step 3b
  await assertReadableDirectory(canonicalPath); // Step 4
  return canonicalPath;
}

// ---------------------------------------------------------------------------
// `simctl list devices --json` shape (partial — only what we map)
// ---------------------------------------------------------------------------

/** One device entry returned by `simctl list devices --json`. */
interface SimctlDeviceEntry {
  readonly udid: string;
  readonly name: string;
  readonly state: string; // "Booted" | "Shutdown" | "Creating" | ...
  readonly isAvailable?: boolean;
}

/** Top-level shape of `simctl list devices --json`. */
interface SimctlListOutput {
  readonly devices: Record<string, readonly SimctlDeviceEntry[]>;
}

/** Map a simctl state string to the three-value domain enum. */
function mapSimctlState(state: string): "booted" | "shutdown" | "unknown" {
  switch (state.toLowerCase()) {
    case "booted":
      return "booted";
    case "shutdown":
      return "shutdown";
    default:
      return "unknown";
  }
}

/**
 * Extract a human-readable OS version from a simctl runtime key.
 *
 * Input:  "com.apple.CoreSimulator.SimRuntime.iOS-17-5"
 * Output: "iOS 17.5"
 */
/** Index of the OS platform group in the SimRuntime key pattern. */
const RUNTIME_PLATFORM_GROUP = 1;
/** Index of the OS version group in the SimRuntime key pattern. */
const RUNTIME_VERSION_GROUP = 2;

function extractOsVersion(runtimeKey: string): string {
  const match = /SimRuntime\.([A-Za-z]+)-(\d+(?:-\d+)*)$/.exec(runtimeKey);
  if (!match) return runtimeKey;
  const platform = match[RUNTIME_PLATFORM_GROUP] ?? "";
  const version = (match[RUNTIME_VERSION_GROUP] ?? "").replace(/-/g, ".");
  return `${platform} ${version}`;
}

/**
 * Parse the JSON output of `simctl list devices --json` into DeviceInfo[].
 * Returns [] on malformed output (defensive: prefer empty over crash).
 */
function parseSimctlList(stdout: string): readonly DeviceInfo[] {
  let parsed: SimctlListOutput;
  try {
    parsed = JSON.parse(stdout) as SimctlListOutput;
  } catch {
    return [];
  }

  const devices: DeviceInfo[] = [];
  for (const [runtimeKey, entries] of Object.entries(parsed.devices)) {
    const osVersion = extractOsVersion(runtimeKey);
    for (const entry of entries) {
      if (typeof entry.udid !== "string" || typeof entry.name !== "string") {
        continue; // skip malformed entries defensively
      }
      devices.push({
        udid: entry.udid,
        name: entry.name,
        platform: "ios",
        osVersion,
        state: mapSimctlState(entry.state),
      });
    }
  }
  return devices;
}

// ---------------------------------------------------------------------------
// Default base directory resolution (T2)
// ---------------------------------------------------------------------------

/**
 * Resolve the allowlisted base directory for app bundles.
 * Priority: injected param → FLOWSCOUT_APP_BUNDLE_DIR env var → os.tmpdir().
 * The fallback to os.tmpdir() ensures the confinement check always has a
 * meaningful base even in test environments that don't set the env var.
 */
function resolveBaseDir(injected: string | undefined): string {
  if (injected !== undefined && injected.length > 0) {
    return injected;
  }
  const envDir = process.env["FLOWSCOUT_APP_BUNDLE_DIR"];
  if (envDir !== undefined && envDir.length > 0) {
    return envDir;
  }
  return os.tmpdir();
}

// ---------------------------------------------------------------------------
// SimulatorLifecycleManager
// ---------------------------------------------------------------------------

/**
 * Real implementation of LifecycleCapability via `xcrun simctl` shell-outs.
 *
 * All five methods fall back to simctl — no mobile-mcp tool calls are made
 * (ADR-0002 OQ2: "device lifecycle is a host concern, not an in-app MCP tool").
 *
 * The `McpConnection` field is preserved to match the Wave-1 constructor seam
 * `(connection, config, exec)` from the stub; it is not used in lifecycle.
 *
 * @param connection     - shared McpConnection (seam-required; unused in lifecycle)
 * @param config         - server config (callTimeoutMs bounds all simctl calls)
 * @param exec           - injectable Exec (T1: argv-array, no shell string)
 * @param appBundleBaseDir - optional override for the T2 confinement base dir;
 *                           defaults to FLOWSCOUT_APP_BUNDLE_DIR env / os.tmpdir()
 */
export class SimulatorLifecycleManager implements LifecycleCapability {
  private readonly baseDir: string;

  constructor(
    protected readonly connection: McpConnection,
    protected readonly config: McpServerConfig,
    protected readonly exec: Exec,
    appBundleBaseDir?: string,
  ) {
    this.baseDir = resolveBaseDir(appBundleBaseDir);
  }

  // -------------------------------------------------------------------------
  // listDevices
  // Mechanism: simctl fallback — `xcrun simctl list devices --json`
  // -------------------------------------------------------------------------

  async listDevices(): Promise<readonly DeviceInfo[]> {
    const { stdout } = await runSimctlWithTimeout(
      ["list", "devices", "--json"],
      this.exec,
      this.config.callTimeoutMs,
    );
    return parseSimctlList(stdout);
  }

  // -------------------------------------------------------------------------
  // bootSimulator
  // Mechanism: simctl fallback — `xcrun simctl boot <udid>`
  // -------------------------------------------------------------------------

  async bootSimulator(udid: string): Promise<void> {
    validateUdid(udid); // T1

    try {
      await runSimctlWithTimeout(["boot", udid], this.exec, this.config.callTimeoutMs);
    } catch (err) {
      const msg = extractMessage(err);
      if (isUnknownDevice(msg)) {
        throw new DeviceNotFoundError(udid, err);
      }
      // "Already booted" is not an error — simulator is in the desired state.
      if (msg.toLowerCase().includes("already booted")) {
        return;
      }
      throw new McpAdapterError(`bootSimulator failed for device`, err);
    }
  }

  // -------------------------------------------------------------------------
  // installApp
  // Mechanism: simctl fallback — `xcrun simctl install <udid> <canonical-path>`
  // T2: path is canonicalized and confined before reaching simctl argv.
  // -------------------------------------------------------------------------

  async installApp(udid: string, appBundlePath: string): Promise<void> {
    validateUdid(udid); // T1

    // T2: resolve canonical path, check confinement, verify readable directory.
    const canonical = await canonicalizeAppPath(appBundlePath, this.baseDir);

    try {
      await runSimctlWithTimeout(
        ["install", udid, canonical],
        this.exec,
        this.config.callTimeoutMs,
      );
    } catch (err) {
      const msg = extractMessage(err);
      if (isUnknownDevice(msg)) {
        throw new DeviceNotFoundError(udid, err);
      }
      throw new InstallFailedError(
        "simctl install failed — confirm the .app is a valid iOS simulator build",
        err,
      );
    }
  }

  // -------------------------------------------------------------------------
  // launchApp
  // Mechanism: simctl fallback — `xcrun simctl launch <udid> <bundleId>`
  // -------------------------------------------------------------------------

  async launchApp(udid: string, bundleId: string): Promise<void> {
    validateUdid(udid); // T1
    validateBundleId(bundleId); // T1

    try {
      await runSimctlWithTimeout(["launch", udid, bundleId], this.exec, this.config.callTimeoutMs);
    } catch (err) {
      const msg = extractMessage(err);
      if (isUnknownDevice(msg)) {
        throw new DeviceNotFoundError(udid, err);
      }
      // Distinct from InstallFailedError (per ticket AC: "launch-failure error distinct
      // from install-failure").
      throw new LaunchFailedError(
        "simctl launch failed — confirm the app is installed and the bundle ID matches",
        err,
      );
    }
  }

  // -------------------------------------------------------------------------
  // shutdownSimulator
  // Mechanism: simctl fallback — `xcrun simctl shutdown <udid>`
  // T8: "already shutdown" / "invalid state" treated as success (idempotent).
  // -------------------------------------------------------------------------

  async shutdownSimulator(udid: string): Promise<void> {
    validateUdid(udid); // T1

    try {
      await runSimctlWithTimeout(["shutdown", udid], this.exec, this.config.callTimeoutMs);
    } catch (err) {
      const msg = extractMessage(err).toLowerCase();
      if (isUnknownDevice(msg)) {
        throw new DeviceNotFoundError(udid, err);
      }
      // Idempotent: "already shutdown" / "invalid state" / "not booted" means
      // the simulator is not running — T8 goal (no orphan) is already satisfied.
      if (
        msg.includes("invalid state") ||
        msg.includes("not booted") ||
        msg.includes("already shutdown")
      ) {
        return;
      }
      throw new McpAdapterError("shutdownSimulator failed for device", err);
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers (outside class to keep method bodies clean)
// ---------------------------------------------------------------------------

/** Extract a string message from an unknown thrown value. */
function extractMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Heuristic: detect simctl "device not found / invalid UDID" error messages.
 * simctl writes these to stderr and exits non-zero.
 */
function isUnknownDevice(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("invalid device") ||
    lower.includes("device not found") ||
    lower.includes("no matching device") ||
    lower.includes("no device matching") ||
    lower.includes("could not find device")
  );
}
