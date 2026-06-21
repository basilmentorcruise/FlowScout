/**
 * snapshot/errors.ts — shared error types for the snapshot/reset capability (#16).
 *
 * Extracted from SnapshotManager.ts to break the circular dependency between
 * AppBundlePathValidator.ts (which throws these errors) and SnapshotManager.ts
 * (which imports AppBundlePathValidator). Both modules now import from here,
 * eliminating the cycle detected by dependency-cruiser.
 *
 * Extends the base McpAdapterError (#12) so callers can catch the base type.
 */

import { McpAdapterError } from "../connection/errors.js";

// ---------------------------------------------------------------------------
// Error message display limits (named constants — no magic numbers per ADR-0001 §6)
// ---------------------------------------------------------------------------

/** Max chars from a field value shown in validation error messages (truncated for safety). */
const VALIDATION_DISPLAY_LIMIT = 60;

// ---------------------------------------------------------------------------
// Snapshot-specific error types
// ---------------------------------------------------------------------------

/**
 * Thrown when a snapshotName, udid, or appBundlePath fails allowlist validation.
 * Extends McpAdapterError so callers can catch the base and still distinguish.
 *
 * Used by both AppBundlePathValidator (path confinement, CWE-22/CWE-88) and
 * SnapshotManager (udid/snapshotName T1 input validation).
 */
export class InvalidSnapshotInputError extends McpAdapterError {
  constructor(field: string, value: unknown) {
    super(
      `InvalidSnapshotInputError: "${field}" value failed validation — ` +
        `value rejected to prevent argument injection (T1/T2 threat model). ` +
        `received: ${JSON.stringify(String(value)).slice(0, VALIDATION_DISPLAY_LIMIT)}`,
    );
    this.name = "InvalidSnapshotInputError";
  }
}

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
