/**
 * AppBundlePathValidator — path confinement for appBundlePath used in
 * `simctl install <udid> <appBundlePath>` (#16 / T2 / CWE-22 / CWE-88 fix).
 *
 * Security controls (T2 / CWE-22 path traversal, CWE-88 argument injection):
 *   1. Rejects a leading '-' character (prevents argument injection).
 *   2. Requires the path to end with '.app' (allowlist on extension).
 *   3. Rejects any '..' path segment BEFORE canonicalization (fast-fail on
 *      obvious traversal without touching the filesystem).
 *   4. Canonicalizes via fs.realpath (resolves symlinks; resolves '..'
 *      segments that survive to this point; fails if the path does not exist).
 *   5. Confines the canonicalized path to an allowlisted base directory
 *      (also canonicalized via realpath) — rejects anything that escapes
 *      the base, including symlinks pointing outside the base.
 *   6. Requires the resolved path to be a readable directory
 *      (a .app bundle is a directory on macOS).
 *
 * FsAccess seam:
 *   All filesystem operations are injected via the `FsAccess` interface so
 *   the validator is unit-testable in a Mac-free environment (no real disk I/O).
 *
 * Decomposition note:
 *   This validator is intentionally self-contained within src/snapshot/**.
 *   The lifecycle capability (#14) has independent path-confinement logic in
 *   its own subtree. A future shared-util extraction is a follow-up refactor
 *   (flagged in the coordinator note); for now the decomposition is kept clean
 *   by mirroring the same contract without cross-subtree coupling.
 */

import { InvalidSnapshotInputError } from "./SnapshotManager.js";

// ---------------------------------------------------------------------------
// Named constants (no magic numbers — ADR-0001 §6)
// ---------------------------------------------------------------------------

/**
 * Maximum number of characters displayed from a rejected path in the error
 * message. Truncated to avoid leaking overly long user-supplied strings.
 */
const PATH_DISPLAY_LIMIT = 80;

// ---------------------------------------------------------------------------
// FsAccess seam — injectable filesystem abstraction for unit testability
// ---------------------------------------------------------------------------

/**
 * Filesystem access interface.
 * All methods mirror the relevant node:fs/promises signatures.
 * Injected at construction so the validator is testable without a real disk.
 */
export interface FsAccess {
  /**
   * Resolve all symlinks and '..' segments in path.
   * Rejects if any component of the path does not exist.
   */
  realpath(path: string): Promise<string>;

  /**
   * Return the stat of the file/directory at path.
   * Uses stat (not lstat) so symlinks are followed to the target.
   */
  stat(path: string): Promise<{ isDirectory(): boolean }>;
}

// ---------------------------------------------------------------------------
// AppBundlePathValidator
// ---------------------------------------------------------------------------

/**
 * Validates and confines an .app bundle path before it is used as an
 * argument to xcrun simctl install.
 *
 * Constructor-time (synchronous, no I/O):
 *   - Rejects empty string.
 *   - Rejects a leading '-' (CWE-88 argument injection).
 *   - Rejects paths containing '..' segments (fast-fail traversal check).
 *   - Requires the path to end with '.app'.
 *
 * validate() (async, requires I/O):
 *   - Resolves the base dir via realpath.
 *   - Resolves the app bundle path via realpath (resolves symlinks / normalizes).
 *   - Confines: the resolved path MUST be inside the resolved base dir.
 *     A symlink that resolves outside the base is rejected.
 *   - Requires the resolved path to be a directory (.app bundles are dirs on macOS).
 *
 * Throws InvalidSnapshotInputError (the existing typed error for this
 * adapter) on any violation, so callers can catch the base type.
 */
export class AppBundlePathValidator {
  private readonly rawPath: string;
  private readonly baseDir: string;
  private readonly fsAccess: FsAccess;

  /**
   * @param rawPath  - the raw appBundlePath supplied by the caller.
   * @param baseDir  - the allowlisted base directory; paths that do not
   *                   resolve inside this directory are rejected.
   * @param fsAccess - injectable fs abstraction (defaults to real node:fs/promises).
   */
  constructor(rawPath: string, baseDir: string, fsAccess?: FsAccess) {
    this.rawPath = rawPath;
    this.baseDir = baseDir;
    this.fsAccess = fsAccess ?? AppBundlePathValidator.defaultFsAccess();

    // Synchronous fast-fail checks (no I/O required).
    this.validateSync(rawPath);
  }

  /**
   * Async validation: realpath canonicalization + base-dir confinement + directory check.
   * Call this before using the path in any simctl argv.
   *
   * @returns the canonicalized (realpath) version of the path, safe for use in argv.
   * @throws InvalidSnapshotInputError on any violation.
   */
  async validate(): Promise<string> {
    const raw = this.rawPath;

    // Canonicalize the base dir first (symlinks in the base dir are resolved too).
    let resolvedBase: string;
    try {
      resolvedBase = await this.fsAccess.realpath(this.baseDir);
    } catch {
      throw new InvalidSnapshotInputError(
        "appBundleBaseDir",
        truncate(this.baseDir),
      );
    }

    // Canonicalize the app bundle path (resolves symlinks + normalizes).
    let resolvedPath: string;
    try {
      resolvedPath = await this.fsAccess.realpath(raw);
    } catch {
      throw new InvalidSnapshotInputError(
        "appBundlePath",
        truncate(raw),
      );
    }

    // Confinement: resolvedPath must be WITHIN resolvedBase.
    // We normalise with a trailing '/' to avoid prefix-collision attacks
    // (e.g., base=/tmp/builds, path=/tmp/builds-evil would otherwise pass a
    // naive startsWith check).
    const normalizedBase = resolvedBase.endsWith("/")
      ? resolvedBase
      : resolvedBase + "/";
    const normalizedPath = resolvedPath.endsWith("/")
      ? resolvedPath
      : resolvedPath + "/";

    if (!normalizedPath.startsWith(normalizedBase)) {
      throw new InvalidSnapshotInputError(
        "appBundlePath",
        truncate(raw),
      );
    }

    // Directory check: .app bundles are macOS directory packages.
    let stat: { isDirectory(): boolean };
    try {
      stat = await this.fsAccess.stat(resolvedPath);
    } catch {
      throw new InvalidSnapshotInputError(
        "appBundlePath",
        truncate(raw),
      );
    }

    if (!stat.isDirectory()) {
      throw new InvalidSnapshotInputError(
        "appBundlePath",
        truncate(raw),
      );
    }

    return resolvedPath;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Synchronous checks: performed at construction time (no I/O).
   * These are fast-fail guards that do not require filesystem access.
   */
  private validateSync(path: string): void {
    // Empty string.
    if (path.length === 0) {
      throw new InvalidSnapshotInputError("appBundlePath", path);
    }

    // Leading '-': would be interpreted as a flag by simctl (CWE-88).
    if (path.startsWith("-")) {
      throw new InvalidSnapshotInputError("appBundlePath", path);
    }

    // '..' segments: fast-fail path traversal (CWE-22).
    // We check individual path segments so we don't reject paths that merely
    // contain '..' as a substring within a valid directory name (e.g., "..evil").
    const segments = path.split("/");
    for (const segment of segments) {
      if (segment === "..") {
        throw new InvalidSnapshotInputError("appBundlePath", truncate(path));
      }
    }

    // Must end with '.app' (case-sensitive, per macOS convention).
    if (!path.endsWith(".app")) {
      throw new InvalidSnapshotInputError("appBundlePath", truncate(path));
    }
  }

  /**
   * Build the default FsAccess backed by node:fs/promises.
   * The lazy require keeps this module unit-testable when callers inject a fake.
   */
  private static defaultFsAccess(): FsAccess {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
    return {
      realpath: (p: string) => fsp.realpath(p),
      stat: (p: string) => fsp.stat(p),
    };
  }
}

// ---------------------------------------------------------------------------
// Module-private utility
// ---------------------------------------------------------------------------

/** Truncate a string for safe inclusion in error messages. */
function truncate(s: string): string {
  return s.length > PATH_DISPLAY_LIMIT ? s.slice(0, PATH_DISPLAY_LIMIT) + "…" : s;
}
