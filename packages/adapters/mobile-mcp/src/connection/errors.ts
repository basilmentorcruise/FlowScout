/**
 * Error taxonomy for the mobile-mcp adapter (ADR-0002 §2.4).
 *
 * All adapter errors extend McpAdapterError so callers can distinguish
 * adapter-level failures from generic JavaScript errors.
 * Wave-1 capability tickets (#14/#15/#16/#17) extend these base classes
 * in their own files — they never edit this file.
 *
 * Security (T5): error messages name the cause category WITHOUT echoing
 * secrets, full env, or full config values.
 */

/**
 * Base class for all errors originating in the mobile-mcp adapter.
 * Uses the standard Error cause option rather than a property override.
 */
export class McpAdapterError extends Error {
  constructor(message: string, rootCause?: unknown) {
    super(message, rootCause !== undefined ? { cause: rootCause } : undefined);
    this.name = "McpAdapterError";
  }
}

/**
 * Thrown when the adapter cannot establish or maintain the MCP connection.
 * Includes the cause (invalid/missing command, transport error, etc.)
 * but must NOT echo secret config values in the message.
 */
export class McpConnectionError extends McpAdapterError {
  constructor(message: string, rootCause?: unknown) {
    super(message, rootCause);
    this.name = "McpConnectionError";
  }
}

/**
 * Thrown when a configured timeout is exceeded during connect or a tool call.
 * `timeoutMs` is surfaced so callers can report it as actionable info.
 */
export class McpTimeoutError extends McpAdapterError {
  constructor(
    message: string,
    public readonly timeoutMs: number,
    rootCause?: unknown,
  ) {
    super(message, rootCause);
    this.name = "McpTimeoutError";
  }
}

/**
 * Thrown when an MCP tool call fails (server returned an error result).
 * Carries the tool name and server-reported error detail.
 */
export class McpToolError extends McpAdapterError {
  constructor(
    public readonly toolName: string,
    detail: string,
    rootCause?: unknown,
  ) {
    super(`Tool '${toolName}' failed: ${detail}`, rootCause);
    this.name = "McpToolError";
  }
}

/**
 * Thrown when a requested device UDID is not found in the device list.
 * Defined here as part of the base taxonomy; Wave-1 lifecycle ticket (#14)
 * may specialize it further in its own file.
 */
export class DeviceNotFoundError extends McpAdapterError {
  constructor(
    public readonly udid: string,
    rootCause?: unknown,
  ) {
    super(`Device not found: ${udid}`, rootCause);
    this.name = "DeviceNotFoundError";
  }
}

/**
 * Thrown when a capability method is called before the adapter is connected.
 */
export class McpNotConnectedError extends McpAdapterError {
  constructor() {
    super("McpConnection is not connected — call connect() before using capabilities.");
    this.name = "McpNotConnectedError";
  }
}
