/**
 * snapshot/index.ts — stub for the snapshot/reset capability module.
 *
 * #12 OWNS THIS FILE as a NotImplemented stub.
 * #16 (E1.5 — Snapshot/reset) REPLACES this file entirely with
 * the real SnapshotManager implementation.
 *
 * Do NOT add logic here — stub only.
 *
 * Constructor seam (Wave-1 contract):
 * #16 replaces this class body ONLY — it receives the shared McpConnection,
 * the server config (for timeouts), and an injectable Exec (for xcrun simctl).
 * It NEVER edits capabilities.ts or the facade.
 */

import type { SnapshotCapability } from "../connection/capabilities.js";
import type { McpConnection } from "../connection/McpConnection.js";
import type { McpServerConfig } from "../connection/connection-config.js";
import type { Exec } from "../simctl.js";

function notImplemented(method: string): Promise<never> {
  return Promise.reject(
    new Error(`SnapshotCapability.${method} is not yet implemented — see ticket #16 (E1.5).`),
  );
}

/** Stub implementation — all methods throw NotImplemented. */
export class SnapshotStub implements SnapshotCapability {
  /**
   * Wave-1 seam: #16 replaces this class and wires these params into the real implementation.
   * Stored as protected fields so Wave-1 inherits the declarations without touching
   * capabilities.ts (the frozen file).
   *
   * @param connection - shared McpConnection (used by real impl for MCP tool calls)
   * @param config     - server config slice (timeouts for connect/call/simctl)
   * @param exec       - injectable xcrun simctl executor (T1: no shell string)
   */
  constructor(
    protected readonly connection: McpConnection,
    protected readonly config: McpServerConfig,
    protected readonly exec: Exec,
  ) {}

  takeSnapshot(_udid: string, _snapshotName: string): Promise<void> {
    return notImplemented("takeSnapshot");
  }

  resetToSnapshot(_udid: string, _snapshotName: string): Promise<void> {
    return notImplemented("resetToSnapshot");
  }
}
