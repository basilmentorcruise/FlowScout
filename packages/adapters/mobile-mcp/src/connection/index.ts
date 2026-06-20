/**
 * Public exports from the connection module.
 * Wave-1 capability tickets import from here — they never import
 * from @modelcontextprotocol/sdk directly.
 */

export { McpConnection } from "./McpConnection.js";
export type { McpToolInfo, McpToolResult, TransportFactory } from "./McpConnection.js";

export type { McpServerConfig, MobileMcpDriverConfig } from "./connection-config.js";
export { defaultServerEnv } from "./connection-config.js";

export {
  McpAdapterError,
  McpConnectionError,
  McpTimeoutError,
  McpToolError,
  DeviceNotFoundError,
  McpNotConnectedError,
} from "./errors.js";

export type {
  LifecycleCapability,
  DrivingCapability,
  SnapshotCapability,
  HealthCapability,
  ReadinessResult,
  CapabilityBundle,
} from "./capabilities.js";

export { defaultCapabilities } from "./capabilities.js";
