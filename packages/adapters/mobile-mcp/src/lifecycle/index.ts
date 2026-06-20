/**
 * lifecycle/index.ts — stub for the lifecycle capability module.
 *
 * #12 OWNS THIS FILE as a NotImplemented stub.
 * #14 (E1.3 — Simulator lifecycle) REPLACES this file entirely with
 * the real SimulatorLifecycleManager implementation.
 *
 * Do NOT add logic here — stub only.
 *
 * Constructor seam (Wave-1 contract):
 * #14 replaces this class body ONLY — it receives the shared McpConnection,
 * the server config (for timeouts), and an injectable Exec (for xcrun simctl).
 * It NEVER edits capabilities.ts or the facade.
 */

import type { LifecycleCapability } from "../connection/capabilities.js";
import type { McpConnection } from "../connection/McpConnection.js";
import type { McpServerConfig } from "../connection/connection-config.js";
import type { Exec } from "../simctl.js";
import type { DeviceInfo } from "@flowscout/domain";

function notImplemented(method: string): Promise<never> {
  return Promise.reject(
    new Error(`LifecycleCapability.${method} is not yet implemented — see ticket #14 (E1.3).`),
  );
}

/** Stub implementation — all methods throw NotImplemented. */
export class LifecycleStub implements LifecycleCapability {
  /**
   * Wave-1 seam: #14 replaces this class and wires these params into the real implementation.
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

  listDevices(): Promise<readonly DeviceInfo[]> {
    return notImplemented("listDevices");
  }

  bootSimulator(_udid: string): Promise<void> {
    return notImplemented("bootSimulator");
  }

  installApp(_udid: string, _appBundlePath: string): Promise<void> {
    return notImplemented("installApp");
  }

  launchApp(_udid: string, _bundleId: string): Promise<void> {
    return notImplemented("launchApp");
  }

  shutdownSimulator(_udid: string): Promise<void> {
    return notImplemented("shutdownSimulator");
  }
}
