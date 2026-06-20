/**
 * snapshot/index.ts — stub for the snapshot/reset capability module.
 *
 * #12 OWNS THIS FILE as a NotImplemented stub.
 * #16 (E1.5 — Snapshot/reset) REPLACES this file entirely with
 * the real SnapshotManager implementation.
 *
 * Do NOT add logic here — stub only.
 */

import type { SnapshotCapability } from "../connection/capabilities.js";

function notImplemented(method: string): Promise<never> {
  return Promise.reject(
    new Error(`SnapshotCapability.${method} is not yet implemented — see ticket #16 (E1.5).`),
  );
}

/** Stub implementation — all methods throw NotImplemented. */
export class SnapshotStub implements SnapshotCapability {
  takeSnapshot(_udid: string, _snapshotName: string): Promise<void> {
    return notImplemented("takeSnapshot");
  }

  resetToSnapshot(_udid: string, _snapshotName: string): Promise<void> {
    return notImplemented("resetToSnapshot");
  }
}
