/**
 * @flowscout/adapter-mobile-mcp — public API barrel.
 *
 * Only this adapter package may import @modelcontextprotocol/sdk or mobile-mcp.
 * See ADR-0001 §2.6, ADR-0002 §2.2.
 */

// Facade — the single public class the composition root wires to both ports.
export { MobileMcpDriver } from "./MobileMcpDriver.js";

// Config value objects (used by the composition root to construct the driver).
export type { MobileMcpDriverConfig, McpServerConfig } from "./connection/index.js";
export { defaultServerEnv } from "./connection/index.js";

// Error taxonomy (capabilities extend these; callers catch them).
export {
  McpAdapterError,
  McpConnectionError,
  McpTimeoutError,
  McpToolError,
  DeviceNotFoundError,
  McpNotConnectedError,
} from "./connection/index.js";

// simctl helper (Wave-1 lifecycle + snapshot tickets import this).
export { runSimctl, runSimctlWithTimeout, createDefaultExec } from "./simctl.js";
export type { Exec, ExecResult } from "./simctl.js";

