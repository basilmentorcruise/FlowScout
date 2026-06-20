/**
 * snapshot/index.ts — public barrel for the snapshot/reset capability module.
 *
 * #16 (E1.5 — Snapshot/reset) OWNS THIS FILE.
 * This file replaces the #12 stub and re-exports the real SnapshotManager.
 *
 * capabilities.ts imports { SnapshotStub } from here as the default capability
 * for the facade. We re-export SnapshotManager as SnapshotStub to satisfy
 * that import without touching the frozen capabilities.ts.
 */

export {
  SnapshotManager,
  SnapshotManager as SnapshotStub, // alias: capabilities.ts imports 'SnapshotStub'
  SnapshotNotFoundError,
  InvalidSnapshotInputError,
} from "./SnapshotManager.js";

export type { SnapshotKind } from "./SnapshotManager.js";
