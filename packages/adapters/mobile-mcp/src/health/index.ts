/**
 * health/index.ts — stub for the health/readiness capability module.
 *
 * #12 OWNS THIS FILE as a NotImplemented stub.
 * #17 (E1.6 — Health/readiness checks) REPLACES this file entirely with
 * the real HealthReadiness implementation.
 *
 * Do NOT add logic here — stub only.
 *
 * Constructor seam (Wave-1 contract):
 * #17 replaces this class body ONLY — it receives the shared McpConnection
 * and the server config (for call timeouts).
 * It NEVER edits capabilities.ts or the facade.
 */

import type { HealthCapability, ReadinessResult } from "../connection/capabilities.js";
import type { McpConnection } from "../connection/McpConnection.js";
import type { McpServerConfig } from "../connection/connection-config.js";

function notImplemented(method: string): Promise<never> {
  return Promise.reject(
    new Error(`HealthCapability.${method} is not yet implemented — see ticket #17 (E1.6).`),
  );
}

/** Stub implementation — all methods throw NotImplemented. */
export class HealthStub implements HealthCapability {
  /**
   * Wave-1 seam: #17 replaces this class and wires these params into the real implementation.
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

  checkReadiness(_udid?: string): Promise<ReadinessResult> {
    return notImplemented("checkReadiness");
  }
}
