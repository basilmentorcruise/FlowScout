/**
 * McpConnection — the single shared seam between the adapter and the MCP server (ADR-0002 §2.4).
 *
 * Responsibilities:
 *  - Connect to the MCP server via the SDK's StdioClientTransport (T7: stdio-only, local spawn).
 *  - Expose callTool() and listTools() so capabilities never import the SDK directly.
 *  - Enforce config-injected timeouts on connect and every tool call (T3/NFR3).
 *  - Provide reliable teardown: dispose() closes the transport, no orphans (T8).
 *
 * Security controls implemented here:
 *  - T1: serverCommand is an argv array; StdioClientTransport spawns with shell:false internally.
 *  - T5: serverEnv is scoped (never process.env); nothing from config is logged verbatim.
 *  - T7: stdio-only transport; command comes from config, not a remote URL.
 *  - T8: reliable teardown in dispose(), even on error paths.
 *
 * The TransportFactory is injected for unit-testability (tests inject a fake transport).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "./connection-config.js";
import {
  McpConnectionError,
  McpNotConnectedError,
  McpTimeoutError,
  McpToolError,
} from "./errors.js";

/** Name + description of an MCP tool as returned by listTools(). */
export interface McpToolInfo {
  readonly name: string;
  readonly description: string;
}

/** Result from a tool call. Typed as unknown because MCP schemas vary per tool. */
export type McpToolResult = unknown;

/**
 * Injectable factory for creating the MCP Transport.
 * The default implementation creates a StdioClientTransport (shell:false, argv array — T1).
 * Tests inject a fake transport so no real process is spawned.
 */
export type TransportFactory = (config: McpServerConfig) => Transport;

/**
 * Default transport factory: StdioClientTransport.
 * The SDK spawns the process with shell:false internally (T1 compliant).
 * Security: serverCommand is an argv array; serverEnv is scoped (T1, T5).
 */
function createDefaultTransport(config: McpServerConfig): Transport {
  const { serverCommand, serverEnv } = config;
  const [command, ...args] = serverCommand;
  if (command === undefined) {
    throw new McpConnectionError(
      "serverCommand must be a non-empty argv array (shell:false — T1 security control).",
    );
  }
  // StdioClientTransport spawns with shell:false internally (T1 compliant).
  // serverEnv is the scoped child env — never process.env (T5).
  return new StdioClientTransport({
    command,
    args,
    env: { ...serverEnv },
    stderr: "pipe", // Capture stderr so it does not pollute the parent process output.
  });
}

/**
 * Wraps a promise with a timeout.
 * Rejects with McpTimeoutError if the promise does not settle within timeoutMs.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new McpTimeoutError(`${label} timed out after ${String(timeoutMs)}ms`, timeoutMs));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        // Preserve the original error — wrap in Error if it is not already one.
        const wrapped =
          err instanceof Error ? err : new Error(`Unexpected rejection: ${String(err)}`);
        reject(wrapped);
      },
    );
  });
}

/**
 * McpConnection — the single transport abstraction all capabilities use.
 * Instantiated once by MobileMcpDriver; injected into each capability.
 *
 * Lifecycle: create → connect() → [callTool / listTools] → dispose()
 */
export class McpConnection {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private cachedTools: readonly McpToolInfo[] | null = null;

  constructor(
    private readonly config: McpServerConfig,
    private readonly transportFactory: TransportFactory = createDefaultTransport,
  ) {}

  /** True when a session is active. */
  get isConnected(): boolean {
    return this.client !== null;
  }

  /**
   * Establish the MCP session over stdio.
   * Creates the transport (which will spawn the server) and completes the MCP handshake.
   * Throws McpConnectionError on invalid config or transport creation failure.
   * Throws McpTimeoutError if the handshake takes longer than connectTimeoutMs.
   *
   * Security (T5): logs only the command name (argv[0]), never the full config.
   */
  async connect(): Promise<void> {
    if (this.client !== null) {
      return; // idempotent
    }

    const { serverCommand, connectTimeoutMs } = this.config;

    if (serverCommand.length === 0) {
      throw new McpConnectionError(
        "serverCommand must be a non-empty argv array (shell:false — T1 security control).",
      );
    }

    let transport: Transport;
    try {
      transport = this.transportFactory(this.config);
    } catch (err) {
      if (err instanceof McpConnectionError) {
        throw err;
      }
      // Log only the command name (argv[0]), not secrets or the full config (T5).
      const cmdName = serverCommand[0] ?? "(unknown)";
      throw new McpConnectionError(
        `Failed to create MCP transport for server '${cmdName}': ${String(err)}`,
        err,
      );
    }

    this.transport = transport;
    const client = new Client({ name: "flowscout-mobile-mcp", version: "0.0.1" });

    try {
      await withTimeout(client.connect(transport), connectTimeoutMs, "MCP connect");
    } catch (err) {
      // Teardown the transport on connect failure so no orphan is left (T8).
      await this.closeTransport();

      if (err instanceof McpTimeoutError) {
        throw err;
      }
      const cmdName = serverCommand[0] ?? "(unknown)";
      throw new McpConnectionError(`MCP session handshake failed for server '${cmdName}'.`, err);
    }

    this.client = client;
    this.cachedTools = null;
  }

  /**
   * Invoke an MCP tool by name with the given arguments.
   * Every call is bounded by the config-injected callTimeoutMs (T3/NFR3).
   * Throws McpNotConnectedError if not connected.
   * Throws McpTimeoutError if the call exceeds callTimeoutMs.
   * Throws McpToolError if the server returns an error result.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (this.client === null) {
      throw new McpNotConnectedError();
    }

    const { callTimeoutMs } = this.config;

    const raw = await withTimeout(
      this.client.callTool({ name: toolName, arguments: args }),
      callTimeoutMs,
      `callTool('${toolName}')`,
    );

    // The SDK returns an object with optional isError field — surface tool errors as McpToolError.
    if (typeof raw === "object" && "isError" in raw && raw.isError === true) {
      const detail =
        "content" in raw && typeof raw.content === "string" ? raw.content : "unknown error";
      throw new McpToolError(toolName, detail);
    }

    return raw;
  }

  /**
   * List the tool names (and descriptions) exposed by the connected server.
   * Results are cached after the first call to avoid repeated round-trips.
   * This is the capability-detection probe used by capabilities (e.g. gesture fallback).
   * Throws McpNotConnectedError if not connected.
   */
  async listTools(): Promise<readonly McpToolInfo[]> {
    if (this.client === null) {
      throw new McpNotConnectedError();
    }

    if (this.cachedTools !== null) {
      return this.cachedTools;
    }

    const { callTimeoutMs } = this.config;
    const result = await withTimeout(this.client.listTools(), callTimeoutMs, "listTools()");

    const tools: McpToolInfo[] = result.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
    }));

    this.cachedTools = tools;
    return tools;
  }

  /**
   * Tear down the MCP session and close the transport.
   * Safe to call multiple times (idempotent).
   * Reliable teardown is mandatory — no orphan processes (T8).
   */
  async dispose(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.cachedTools = null;

    if (client !== null) {
      try {
        await client.close();
      } catch {
        // Swallow — we still close the transport below.
      }
    }

    await this.closeTransport();
    this.transport = null;
  }

  /** Close the underlying transport (which terminates the spawned process). */
  private async closeTransport(): Promise<void> {
    const transport = this.transport;
    if (transport === null) {
      return;
    }
    try {
      await transport.close();
    } catch {
      // Ignore close errors — best effort.
    }
  }
}
