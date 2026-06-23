/**
 * McpConnection happy-path tests using vi.mock to stub the SDK Client.
 *
 * These cover the branches that require a successfully connected client:
 * - connect() success path (AC1 from the issue)
 * - listTools() result parsing + cache behaviour
 * - callTool() happy path + error (isError) path
 * - dispose() when client is active (reliable teardown — T8)
 * - closeTransport() when close throws (T8 error-path resilience)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  McpTimeoutError,
  McpNotConnectedError,
  McpToolError,
  McpConnectionError,
} from "../connection/errors.js";
import type { McpServerConfig } from "../connection/connection-config.js";

// ---------------------------------------------------------------------------
// Mock the MCP SDK Client so no real transport or network is needed.
// ---------------------------------------------------------------------------

const mockCallTool = vi.fn();
const mockListTools = vi.fn();
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockConnect = vi.fn().mockResolvedValue(undefined);

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockClose,
    callTool: mockCallTool,
    listTools: mockListTools,
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_CONFIG: McpServerConfig = {
  serverCommand: ["npx", "mobile-mcp"],
  serverEnv: { PATH: "/usr/bin" },
  connectTimeoutMs: 5000,
  callTimeoutMs: 10000,
};

/** Create a fake Transport whose start resolves immediately. */
function makeFastTransport() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
  } as unknown as import("@modelcontextprotocol/sdk/shared/transport.js").Transport;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("McpConnection — connect() success path (AC1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
  });

  it("connect() resolves and isConnected becomes true", async () => {
    const { McpConnection } = await import("../connection/McpConnection.js");
    const transport = makeFastTransport();
    const conn = new McpConnection(BASE_CONFIG, () => transport);
    await conn.connect();
    expect(conn.isConnected).toBe(true);
  });

  it("connect() is idempotent — second call is a no-op", async () => {
    const { McpConnection } = await import("../connection/McpConnection.js");
    const transport = makeFastTransport();
    const conn = new McpConnection(BASE_CONFIG, () => transport);
    await conn.connect();
    await conn.connect(); // second call should not create a new client
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });
});

describe("McpConnection — listTools() (AC1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
  });

  it("listTools() returns tool names from the server", async () => {
    const { McpConnection } = await import("../connection/McpConnection.js");
    mockListTools.mockResolvedValue({
      tools: [
        { name: "tap", description: "Tap an element" },
        { name: "screenshot", description: "Take screenshot" },
      ],
    });
    const transport = makeFastTransport();
    const conn = new McpConnection(BASE_CONFIG, () => transport);
    await conn.connect();
    const tools = await conn.listTools();
    expect(tools).toHaveLength(2);
    expect(tools[0]?.name).toBe("tap");
    expect(tools[1]?.name).toBe("screenshot");
  });

  it("listTools() caches the result on subsequent calls", async () => {
    const { McpConnection } = await import("../connection/McpConnection.js");
    mockListTools.mockResolvedValue({ tools: [{ name: "tap", description: "Tap" }] });
    const transport = makeFastTransport();
    const conn = new McpConnection(BASE_CONFIG, () => transport);
    await conn.connect();
    await conn.listTools();
    await conn.listTools(); // second call hits cache
    expect(mockListTools).toHaveBeenCalledTimes(1);
  });

  it("listTools() handles tools with undefined description", async () => {
    const { McpConnection } = await import("../connection/McpConnection.js");
    mockListTools.mockResolvedValue({
      tools: [{ name: "tool-no-desc" }],
    });
    const transport = makeFastTransport();
    const conn = new McpConnection(BASE_CONFIG, () => transport);
    await conn.connect();
    const tools = await conn.listTools();
    expect(tools[0]?.description).toBe("");
  });
});

describe("McpConnection — callTool() (AC1 + error path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
  });

  it("callTool() returns result on success", async () => {
    const { McpConnection } = await import("../connection/McpConnection.js");
    const fakeResult = { content: [{ type: "text", text: "ok" }] };
    mockCallTool.mockResolvedValue(fakeResult);
    const transport = makeFastTransport();
    const conn = new McpConnection(BASE_CONFIG, () => transport);
    await conn.connect();
    const result = await conn.callTool("tap", { x: 100, y: 200 });
    expect(result).toEqual(fakeResult);
    expect(mockCallTool).toHaveBeenCalledWith({ name: "tap", arguments: { x: 100, y: 200 } });
  });

  it("callTool() throws McpToolError when server returns isError=true", async () => {
    const { McpConnection } = await import("../connection/McpConnection.js");
    mockCallTool.mockResolvedValue({
      isError: true,
      content: "element not found",
    });
    const transport = makeFastTransport();
    const conn = new McpConnection(BASE_CONFIG, () => transport);
    await conn.connect();
    await expect(conn.callTool("tap", {})).rejects.toThrow(McpToolError);
    await expect(conn.callTool("tap", {})).rejects.toThrow("element not found");
  });

  it("callTool() throws McpToolError with 'unknown error' when content is not a string", async () => {
    const { McpConnection } = await import("../connection/McpConnection.js");
    mockCallTool.mockResolvedValue({ isError: true });
    const transport = makeFastTransport();
    const conn = new McpConnection(BASE_CONFIG, () => transport);
    await conn.connect();
    await expect(conn.callTool("tap", {})).rejects.toThrow("unknown error");
  });

  it("callTool() throws McpTimeoutError when the call exceeds callTimeoutMs (AC4)", async () => {
    const { McpConnection } = await import("../connection/McpConnection.js");
    mockCallTool.mockImplementation(
      () =>
        new Promise<void>(() => {
          /* never resolves */
        }),
    );
    const transport = makeFastTransport();
    const conn = new McpConnection(
      { ...BASE_CONFIG, callTimeoutMs: 50 }, // fast timeout
      () => transport,
    );
    await conn.connect();
    await expect(conn.callTool("tap", {})).rejects.toThrow(McpTimeoutError);
  }, 5000);

  it("callTool() wraps non-Error rejections from the SDK in Error", async () => {
    const { McpConnection } = await import("../connection/McpConnection.js");
    mockCallTool.mockRejectedValue("raw string rejection");
    const transport = makeFastTransport();
    const conn = new McpConnection(BASE_CONFIG, () => transport);
    await conn.connect();
    const result = conn.callTool("tap", {});
    await expect(result).rejects.toBeInstanceOf(Error);
  });
});

describe("McpConnection — dispose() with active client (T8 reliable teardown)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
  });

  it("dispose() after connect calls client.close() (T8)", async () => {
    const { McpConnection } = await import("../connection/McpConnection.js");
    const transport = makeFastTransport();
    const conn = new McpConnection(BASE_CONFIG, () => transport);
    await conn.connect();
    expect(conn.isConnected).toBe(true);
    await conn.dispose();
    expect(mockClose).toHaveBeenCalled();
    expect(conn.isConnected).toBe(false);
  });

  it("dispose() after connect clears the tool cache", async () => {
    const { McpConnection } = await import("../connection/McpConnection.js");
    mockListTools.mockResolvedValue({ tools: [{ name: "tap" }] });
    const transport = makeFastTransport();
    const conn = new McpConnection(BASE_CONFIG, () => transport);
    await conn.connect();
    await conn.listTools(); // populates cache
    await conn.dispose(); // should clear cache
    // After dispose, listTools() should throw McpNotConnectedError (not return cached).
    await expect(conn.listTools()).rejects.toThrow(McpNotConnectedError);
  });

  it("dispose() does not throw even if client.close() fails (T8 resilience)", async () => {
    const { McpConnection } = await import("../connection/McpConnection.js");
    mockClose.mockRejectedValue(new Error("close failed"));
    const transport = makeFastTransport();
    const conn = new McpConnection(BASE_CONFIG, () => transport);
    await conn.connect();
    // Should not throw despite client.close() failing.
    await expect(conn.dispose()).resolves.toBeUndefined();
    expect(conn.isConnected).toBe(false);
  });
});

describe("McpConnection — closeTransport error resilience (T8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
  });

  it("closeTransport() does not throw when transport.close() fails", async () => {
    const { McpConnection } = await import("../connection/McpConnection.js");
    const transport = makeFastTransport();
    // Make transport.close() throw.
    (transport as { close: () => Promise<void> }).close = vi
      .fn()
      .mockRejectedValue(new Error("transport close error"));
    const conn = new McpConnection(BASE_CONFIG, () => transport);
    await conn.connect();
    // dispose calls closeTransport — should not propagate.
    await expect(conn.dispose()).resolves.toBeUndefined();
  });
});

describe("McpConnection — McpConnectionError from failed handshake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("connect() throws McpConnectionError when SDK connect rejects", async () => {
    const { McpConnection } = await import("../connection/McpConnection.js");
    mockConnect.mockRejectedValue(new Error("handshake failed"));
    const transport = makeFastTransport();
    const conn = new McpConnection(BASE_CONFIG, () => transport);
    await expect(conn.connect()).rejects.toThrow(McpConnectionError);
  });
});
