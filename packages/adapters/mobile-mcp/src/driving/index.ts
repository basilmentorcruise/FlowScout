/**
 * driving/index.ts — stub for the driving capability module.
 *
 * #12 OWNS THIS FILE as a NotImplemented stub.
 * #15 (E1.4 — Device driving + normalization) REPLACES this file entirely with
 * the real DeviceDriver implementation.
 *
 * Do NOT add logic here — stub only.
 *
 * Constructor seam (Wave-1 contract):
 * #15 replaces this class body ONLY — it receives the shared McpConnection
 * and the server config (for call timeouts).
 * It NEVER edits capabilities.ts or the facade.
 */

import type { DrivingCapability } from "../connection/capabilities.js";
import type { McpConnection } from "../connection/McpConnection.js";
import type { McpServerConfig } from "../connection/connection-config.js";
import type { A11ySnapshot, ScreenshotBytes, TapTarget, SwipeDirection } from "@flowscout/domain";

function notImplemented(method: string): Promise<never> {
  return Promise.reject(
    new Error(`DrivingCapability.${method} is not yet implemented — see ticket #15 (E1.4).`),
  );
}

/** Stub implementation — all methods throw NotImplemented. */
export class DrivingStub implements DrivingCapability {
  /**
   * Wave-1 seam: #15 replaces this class and wires these params into the real implementation.
   * Stored as protected fields so Wave-1 inherits the declarations without touching
   * capabilities.ts (the frozen file).
   *
   * @param connection - shared McpConnection (used by real impl for MCP tool calls)
   * @param config     - server config slice (callTimeoutMs for every tool call)
   */
  constructor(
    protected readonly connection: McpConnection,
    protected readonly config: McpServerConfig,
  ) {}

  snapshotAccessibilityTree(_udid: string): Promise<A11ySnapshot> {
    return notImplemented("snapshotAccessibilityTree");
  }

  screenshot(_udid: string): Promise<ScreenshotBytes> {
    return notImplemented("screenshot");
  }

  tap(_udid: string, _target: TapTarget): Promise<void> {
    return notImplemented("tap");
  }

  typeText(_udid: string, _text: string): Promise<void> {
    return notImplemented("typeText");
  }

  swipe(_udid: string, _direction: SwipeDirection, _distance?: number): Promise<void> {
    return notImplemented("swipe");
  }
}
