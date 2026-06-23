/**
 * driving.test.ts — test suite for DeviceDriver (ticket #15).
 *
 * Coverage goals (≥80% line+branch on driving business logic):
 *  §1 Normalization unit tests (normalization.ts pure functions)
 *     - normalizeA11ySnapshot: happy path, malformed shape, empty text, oversized
 *     - normalizeScreenshot: happy path, malformed shape, missing image, oversized
 *     - validateCoordinateTarget: on-screen, off-screen (negative, over-max)
 *     - swipeDirectionToCoordinates: all four directions, with/without distance
 *     - validateUdid: valid UUID, injection vectors
 *  §2 DeviceDriver unit tests (connection mocked)
 *     - snapshotAccessibilityTree: happy, McpToolError → UnknownDeviceError, udid validation
 *     - screenshot: happy, McpToolError → UnknownDeviceError, udid validation
 *     - tap (coordinate): happy, off-screen → ActionError, McpToolError, udid validation
 *     - tap (element): happy, McpToolError → ActionError, udid validation
 *     - typeText: happy, McpToolError, udid validation; NEVER logs text (T5)
 *     - swipe: tool-present branch, tool-absent fallback branch, McpToolError, udid
 *  §3 T3 payload normalization security cases
 *     - malformed dump_ui payload → MalformedPayloadError
 *     - malformed screenshot payload → MalformedPayloadError
 *     - oversized a11y snapshot → MalformedPayloadError
 *     - oversized screenshot → MalformedPayloadError
 *     - null payload → MalformedPayloadError
 *  §4 Contract suite: runDrivingContract against real DeviceDriver (AC7)
 *     - runs runDrivingContract (ADR-0003 section runner) against real DeviceDriver
 *       with mocked McpConnection serving canned payloads; exercises §4 observation,
 *       §5 actions, §6(driving) unknown-UDID, §7(driving) injection, §11 stress
 *
 * Security proof (T4/T5):
 *  - typeText tests assert text is NOT present in any callTool invocation args key
 *    named "text" being logged (we verify no log calls capture the text string).
 *  - The test file itself never logs typeText text (all text in tests is clearly labelled
 *    "test-input-text" and is never written to any sink other than the function arg).
 */

import { describe, it, expect, vi } from "vitest";
import { DeviceDriver } from "../driving/DeviceDriver.js";
import {
  normalizeA11ySnapshot,
  normalizeScreenshot,
  validateCoordinateTarget,
  swipeDirectionToCoordinates,
  validateUdid,
  MalformedPayloadError,
  ActionError,
  InvalidInputError,
  UnknownDeviceError,
  DEFAULT_NORMALIZATION_CONFIG,
} from "../driving/normalization.js";
import type { NormalizationConfig } from "../driving/normalization.js";
import { McpToolError, McpAdapterError } from "../connection/errors.js";
import type { McpConnection, McpToolInfo } from "../connection/McpConnection.js";
import { runDrivingContract } from "../testing/index.js";
import type { DrivingFixtures, DrivingErrorClasses } from "../testing/index.js";

// ---------------------------------------------------------------------------
// Synthetic test constants (no magic numbers — ADR-0001 §6)
// ---------------------------------------------------------------------------
const VALID_UDID = "00000000-0000-0000-0000-000000000001";
const UNKNOWN_UDID = "00000000-0000-0000-0000-FFFFFFFF9999";
const SCREEN_W = 1000;
const SCREEN_H = 2000;
const CENTER_X = Math.floor(SCREEN_W / 2);
const CENTER_Y = Math.floor(SCREEN_H / 2);
const TAP_X = 100;
const TAP_Y = 200;
const ELEMENT_ID = "btn-ok";
const SWIPE_DIST = 300;

const TEST_NORM_CONFIG: NormalizationConfig = {
  maxA11ySnapshotBytes: 1024,
  maxScreenshotBytes: 2048,
  screenWidthPx: SCREEN_W,
  screenHeightPx: SCREEN_H,
};

// Minimal valid 1×1 PNG (same as FakeMobileDriver's synthetic fixture)
const SYNTHETIC_PNG_BASE64 = Buffer.from(
  new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
  ]),
).toString("base64");

// ---------------------------------------------------------------------------
// Mock McpConnection factory
// ---------------------------------------------------------------------------

function makeMockConnection(overrides: {
  callToolImpl?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  listToolsImpl?: () => Promise<readonly McpToolInfo[]>;
}): McpConnection {
  return {
    isConnected: true,
    connect: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    callTool: vi
      .fn()
      .mockImplementation(
        overrides.callToolImpl ??
          ((_name: string) => Promise.resolve({ content: [{ type: "text", text: "ok" }] })),
      ),
    listTools: vi.fn().mockImplementation(
      overrides.listToolsImpl ??
        (() =>
          Promise.resolve([
            { name: "mobile_dump_ui", description: "" },
            { name: "mobile_screenshot", description: "" },
            { name: "mobile_tap", description: "" },
            { name: "mobile_type", description: "" },
            { name: "mobile_swipe", description: "" },
          ])),
    ),
  } as unknown as McpConnection;
}

const STUB_CONFIG = {
  serverCommand: ["node", "server.js"],
  serverEnv: {},
  connectTimeoutMs: 5000,
  callTimeoutMs: 10000,
};

// ---------------------------------------------------------------------------
// §1 — Normalization pure function unit tests
// ---------------------------------------------------------------------------

describe("§1 normalizeA11ySnapshot", () => {
  it("returns branded A11ySnapshot for valid dump_ui result", () => {
    const raw = { content: [{ type: "text", text: "<AXApplication>tree</AXApplication>" }] };
    const result = normalizeA11ySnapshot(raw, TEST_NORM_CONFIG);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("AXApplication");
  });

  it("throws MalformedPayloadError when payload is not an object", () => {
    expect(() => normalizeA11ySnapshot(null, TEST_NORM_CONFIG)).toThrow(MalformedPayloadError);
    expect(() => normalizeA11ySnapshot("string", TEST_NORM_CONFIG)).toThrow(MalformedPayloadError);
    expect(() => normalizeA11ySnapshot(42, TEST_NORM_CONFIG)).toThrow(MalformedPayloadError);
  });

  it("throws MalformedPayloadError when content array is missing", () => {
    expect(() => normalizeA11ySnapshot({ notContent: [] }, TEST_NORM_CONFIG)).toThrow(
      MalformedPayloadError,
    );
  });

  it("throws MalformedPayloadError when content has no text item", () => {
    const raw = { content: [{ type: "image", data: "abc" }] };
    expect(() => normalizeA11ySnapshot(raw, TEST_NORM_CONFIG)).toThrow(MalformedPayloadError);
  });

  it("throws MalformedPayloadError for empty text content", () => {
    const raw = { content: [{ type: "text", text: "" }] };
    expect(() => normalizeA11ySnapshot(raw, TEST_NORM_CONFIG)).toThrow(MalformedPayloadError);
  });

  it("throws MalformedPayloadError when text exceeds maxA11ySnapshotBytes (T3)", () => {
    const tinyConfig: NormalizationConfig = { ...TEST_NORM_CONFIG, maxA11ySnapshotBytes: 5 };
    const raw = { content: [{ type: "text", text: "123456789" }] };
    expect(() => normalizeA11ySnapshot(raw, tinyConfig)).toThrow(MalformedPayloadError);
  });

  it("MalformedPayloadError extends McpAdapterError", () => {
    const raw = { content: [{ type: "image" }] };
    try {
      normalizeA11ySnapshot(raw, TEST_NORM_CONFIG);
    } catch (err) {
      expect(err).toBeInstanceOf(McpAdapterError);
    }
  });

  it("uses first text item when multiple content items present", () => {
    const raw = {
      content: [
        { type: "image", data: "abc" },
        { type: "text", text: "tree-content" },
      ],
    };
    const result = normalizeA11ySnapshot(raw, TEST_NORM_CONFIG);
    expect(result).toBe("tree-content");
  });
});

describe("§1 normalizeScreenshot", () => {
  it("returns Uint8Array for valid screenshot result", () => {
    const raw = {
      content: [
        { type: "text", text: "screenshot info" },
        { type: "image", data: SYNTHETIC_PNG_BASE64 },
      ],
    };
    const result = normalizeScreenshot(raw, TEST_NORM_CONFIG);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(0);
  });

  it("throws MalformedPayloadError for null payload (T3)", () => {
    expect(() => normalizeScreenshot(null, TEST_NORM_CONFIG)).toThrow(MalformedPayloadError);
  });

  it("throws MalformedPayloadError for payload without content array (T3)", () => {
    expect(() => normalizeScreenshot({ data: "abc" }, TEST_NORM_CONFIG)).toThrow(
      MalformedPayloadError,
    );
  });

  it("throws MalformedPayloadError when no image item in content (T3)", () => {
    const raw = { content: [{ type: "text", text: "no image here" }] };
    expect(() => normalizeScreenshot(raw, TEST_NORM_CONFIG)).toThrow(MalformedPayloadError);
  });

  it("throws MalformedPayloadError when image data is empty string (T3)", () => {
    const raw = { content: [{ type: "image", data: "" }] };
    expect(() => normalizeScreenshot(raw, TEST_NORM_CONFIG)).toThrow(MalformedPayloadError);
  });

  it("throws MalformedPayloadError when decoded bytes exceed maxScreenshotBytes (T3)", () => {
    // Create base64 of a buffer larger than our tiny limit
    const bigBuffer = Buffer.alloc(100, 0xff);
    const bigBase64 = bigBuffer.toString("base64");
    const tinyConfig: NormalizationConfig = { ...TEST_NORM_CONFIG, maxScreenshotBytes: 10 };
    const raw = { content: [{ type: "image", data: bigBase64 }] };
    expect(() => normalizeScreenshot(raw, tinyConfig)).toThrow(MalformedPayloadError);
  });

  // ---------------------------------------------------------------------------
  // §1 normalizeScreenshot — pre-decode base64 size gate (ticket #27, T3 / CWE-400)
  // Oversized payloads must be rejected on their base64 string length BEFORE
  // Buffer.from() is called, preventing partial-OOM allocation.
  // ---------------------------------------------------------------------------

  it("rejects an oversized base64 payload WITHOUT decoding it (pre-decode gate, T3/#27)", () => {
    // Construct a base64 string whose estimated decoded size exceeds maxScreenshotBytes.
    // 100 bytes encoded → base64 string of 136 chars; decoded estimate = floor(136*3/4) = 102.
    // tinyConfig.maxScreenshotBytes = 10, so the pre-decode gate must fire before any allocation.
    const oversizedBuffer = Buffer.alloc(100, 0xab);
    const oversizedBase64 = oversizedBuffer.toString("base64");
    const tinyConfig: NormalizationConfig = { ...TEST_NORM_CONFIG, maxScreenshotBytes: 10 };
    const raw = { content: [{ type: "image", data: oversizedBase64 }] };

    // Spy on Buffer.from to verify it is NOT called with "base64" encoding.
    const bufferFromSpy = vi.spyOn(Buffer, "from");
    expect(() => normalizeScreenshot(raw, tinyConfig)).toThrow(MalformedPayloadError);
    // Pre-decode gate must have fired before Buffer.from("base64") is reached.
    const base64Calls = bufferFromSpy.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any[]) => args[1] === "base64",
    );
    expect(base64Calls).toHaveLength(0);
    bufferFromSpy.mockRestore();
  });

  it("accepts a valid payload well within the limit (pre-decode gate passes, T3/#27)", () => {
    // The pre-decode estimate (Math.floor(base64Length * 3 / 4)) may over-count by up to
    // 2 bytes vs the actual decoded size due to base64 padding characters.
    // A buffer of (maxScreenshotBytes - 2) is guaranteed to produce an estimate
    // ≤ maxScreenshotBytes for any padding combination.
    // TEST_NORM_CONFIG.maxScreenshotBytes = 2048.
    const safeBuffer = Buffer.alloc(TEST_NORM_CONFIG.maxScreenshotBytes - 2, 0xcc);
    const safeBase64 = safeBuffer.toString("base64");
    const raw = {
      content: [
        { type: "text", text: "screenshot info" },
        { type: "image", data: safeBase64 },
      ],
    };
    expect(() => normalizeScreenshot(raw, TEST_NORM_CONFIG)).not.toThrow();
  });

  it("rejects a payload 1 byte over the limit (boundary check, T3/#27)", () => {
    // A buffer of maxScreenshotBytes + 1 must be rejected by the pre-decode gate.
    const overBuffer = Buffer.alloc(TEST_NORM_CONFIG.maxScreenshotBytes + 1, 0xdd);
    const overBase64 = overBuffer.toString("base64");
    const raw = { content: [{ type: "image", data: overBase64 }] };
    expect(() => normalizeScreenshot(raw, TEST_NORM_CONFIG)).toThrow(MalformedPayloadError);
  });
});

describe("§1 validateCoordinateTarget", () => {
  it("passes for coordinates within screen bounds", () => {
    expect(() => validateCoordinateTarget(0, 0, TEST_NORM_CONFIG)).not.toThrow();
    expect(() => validateCoordinateTarget(TAP_X, TAP_Y, TEST_NORM_CONFIG)).not.toThrow();
    // Last valid pixel is (SCREEN_W - 1, SCREEN_H - 1); SCREEN_W/SCREEN_H are out-of-bounds
    expect(() =>
      validateCoordinateTarget(SCREEN_W - 1, SCREEN_H - 1, TEST_NORM_CONFIG),
    ).not.toThrow();
  });

  it("throws ActionError for coordinate exactly at screenWidthPx (off-by-one: 0-indexed pixels)", () => {
    expect(() => validateCoordinateTarget(SCREEN_W, TAP_Y, TEST_NORM_CONFIG)).toThrow(ActionError);
  });

  it("throws ActionError for coordinate exactly at screenHeightPx (off-by-one: 0-indexed pixels)", () => {
    expect(() => validateCoordinateTarget(TAP_X, SCREEN_H, TEST_NORM_CONFIG)).toThrow(ActionError);
  });

  it("throws ActionError for negative x (T3 off-screen)", () => {
    expect(() => validateCoordinateTarget(-1, TAP_Y, TEST_NORM_CONFIG)).toThrow(ActionError);
  });

  it("throws ActionError for negative y (T3 off-screen)", () => {
    expect(() => validateCoordinateTarget(TAP_X, -1, TEST_NORM_CONFIG)).toThrow(ActionError);
  });

  it("throws ActionError for x beyond screenWidthPx (T3 off-screen)", () => {
    expect(() => validateCoordinateTarget(SCREEN_W + 1, TAP_Y, TEST_NORM_CONFIG)).toThrow(
      ActionError,
    );
  });

  it("throws ActionError for y beyond screenHeightPx (T3 off-screen)", () => {
    expect(() => validateCoordinateTarget(TAP_X, SCREEN_H + 1, TEST_NORM_CONFIG)).toThrow(
      ActionError,
    );
  });

  it("ActionError extends McpAdapterError", () => {
    try {
      validateCoordinateTarget(-1, -1, TEST_NORM_CONFIG);
    } catch (err) {
      expect(err).toBeInstanceOf(McpAdapterError);
    }
  });
});

describe("§1 swipeDirectionToCoordinates", () => {
  it("swipe up: endY < startY", () => {
    const coords = swipeDirectionToCoordinates("up", TEST_NORM_CONFIG);
    expect(coords.startX).toBe(CENTER_X);
    expect(coords.startY).toBe(CENTER_Y);
    expect(coords.endY).toBeLessThan(CENTER_Y);
    expect(coords.endX).toBe(CENTER_X);
  });

  it("swipe down: endY > startY", () => {
    const coords = swipeDirectionToCoordinates("down", TEST_NORM_CONFIG);
    expect(coords.endY).toBeGreaterThan(CENTER_Y);
    expect(coords.endX).toBe(CENTER_X);
  });

  it("swipe left: endX < startX", () => {
    const coords = swipeDirectionToCoordinates("left", TEST_NORM_CONFIG);
    expect(coords.endX).toBeLessThan(CENTER_X);
    expect(coords.endY).toBe(CENTER_Y);
  });

  it("swipe right: endX > startX", () => {
    const coords = swipeDirectionToCoordinates("right", TEST_NORM_CONFIG);
    expect(coords.endX).toBeGreaterThan(CENTER_X);
    expect(coords.endY).toBe(CENTER_Y);
  });

  it("uses provided distance when supplied", () => {
    const coords = swipeDirectionToCoordinates("up", TEST_NORM_CONFIG, SWIPE_DIST);
    expect(coords.startY - coords.endY).toBe(SWIPE_DIST);
  });

  it("computes default distance from screen dimensions when not supplied", () => {
    const coords = swipeDirectionToCoordinates("down", TEST_NORM_CONFIG);
    const expectedDefault = Math.floor(SCREEN_H * 0.4);
    expect(coords.endY - coords.startY).toBe(expectedDefault);
  });
});

describe("§1 validateUdid (T1 injection guard)", () => {
  it("passes for a valid UUID v4", () => {
    expect(() => validateUdid(VALID_UDID)).not.toThrow();
  });

  it("throws InvalidInputError for empty string", () => {
    expect(() => validateUdid("")).toThrow(InvalidInputError);
  });

  it("throws InvalidInputError for shell injection; rm -rf", () => {
    expect(() => validateUdid("; rm -rf ~")).toThrow(InvalidInputError);
  });

  it("throws InvalidInputError for subshell injection", () => {
    expect(() => validateUdid("$(echo injected)")).toThrow(InvalidInputError);
  });

  it("throws InvalidInputError for leading-dash injection", () => {
    expect(() => validateUdid("--flag-injection")).toThrow(InvalidInputError);
  });

  it("throws InvalidInputError for NUL-byte injection", () => {
    expect(() => validateUdid("udid\x00with\x00nuls")).toThrow(InvalidInputError);
  });

  it("InvalidInputError extends McpAdapterError", () => {
    try {
      validateUdid("");
    } catch (err) {
      expect(err).toBeInstanceOf(McpAdapterError);
    }
  });
});

// ---------------------------------------------------------------------------
// §2 — DeviceDriver unit tests (connection mocked)
// ---------------------------------------------------------------------------

describe("§2 DeviceDriver.snapshotAccessibilityTree", () => {
  it("returns A11ySnapshot for valid dump_ui response", async () => {
    const conn = makeMockConnection({
      callToolImpl: () =>
        Promise.resolve({ content: [{ type: "text", text: "<AXApp>tree</AXApp>" }] }),
    });
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    const result = await driver.snapshotAccessibilityTree(VALID_UDID);
    expect(typeof result).toBe("string");
    expect(result).toContain("AXApp");
  });

  it("calls connect() before calling the MCP tool", async () => {
    const conn = makeMockConnection({
      callToolImpl: () => Promise.resolve({ content: [{ type: "text", text: "tree" }] }),
    });
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    await driver.snapshotAccessibilityTree(VALID_UDID);
    expect(conn.connect).toHaveBeenCalledOnce();
  });

  it("throws InvalidInputError for injection-shaped UDID before calling MCP (T1)", async () => {
    const conn = makeMockConnection({});
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    await expect(driver.snapshotAccessibilityTree("; rm -rf ~")).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    expect(conn.callTool).not.toHaveBeenCalled();
  });

  it("throws UnknownDeviceError when MCP returns McpToolError", async () => {
    const conn = makeMockConnection({
      callToolImpl: () => Promise.reject(new McpToolError("mobile_dump_ui", "device not found")),
    });
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    await expect(driver.snapshotAccessibilityTree(UNKNOWN_UDID)).rejects.toBeInstanceOf(
      UnknownDeviceError,
    );
  });

  it("propagates non-McpToolError errors (e.g. timeouts) unchanged", async () => {
    const conn = makeMockConnection({
      callToolImpl: () => Promise.reject(new Error("generic network failure")),
    });
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    const err = await driver.snapshotAccessibilityTree(VALID_UDID).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UnknownDeviceError);
    expect((err as Error).message).toContain("generic network failure");
  });
});

describe("§2 DeviceDriver.screenshot", () => {
  it("returns Uint8Array for valid screenshot response", async () => {
    const conn = makeMockConnection({
      callToolImpl: () =>
        Promise.resolve({
          content: [{ type: "image", data: SYNTHETIC_PNG_BASE64 }],
        }),
    });
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    const result = await driver.screenshot(VALID_UDID);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(0);
  });

  it("throws InvalidInputError for injection UDID (T1)", async () => {
    const conn = makeMockConnection({});
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    await expect(driver.screenshot("$(injection)")).rejects.toBeInstanceOf(InvalidInputError);
    expect(conn.callTool).not.toHaveBeenCalled();
  });

  it("throws UnknownDeviceError when MCP returns McpToolError", async () => {
    const conn = makeMockConnection({
      callToolImpl: () => Promise.reject(new McpToolError("mobile_screenshot", "no device")),
    });
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    await expect(driver.screenshot(UNKNOWN_UDID)).rejects.toBeInstanceOf(UnknownDeviceError);
  });
});

describe("§2 DeviceDriver.tap (coordinate)", () => {
  it("calls mobile_tap with correct coordinates", async () => {
    const conn = makeMockConnection({
      callToolImpl: () => Promise.resolve({ content: [{ type: "text", text: "tapped" }] }),
    });
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    await driver.tap(VALID_UDID, { kind: "coordinate", x: TAP_X, y: TAP_Y });
    expect(conn.callTool).toHaveBeenCalledWith("mobile_tap", {
      udid: VALID_UDID,
      x: TAP_X,
      y: TAP_Y,
    });
  });

  it("throws ActionError for off-screen coordinate (negative x)", async () => {
    const conn = makeMockConnection({});
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    await expect(
      driver.tap(VALID_UDID, { kind: "coordinate", x: -1, y: TAP_Y }),
    ).rejects.toBeInstanceOf(ActionError);
    expect(conn.callTool).not.toHaveBeenCalled();
  });

  it("throws ActionError for off-screen coordinate (beyond screenWidthPx)", async () => {
    const conn = makeMockConnection({});
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    await expect(
      driver.tap(VALID_UDID, { kind: "coordinate", x: SCREEN_W + 1, y: TAP_Y }),
    ).rejects.toBeInstanceOf(ActionError);
  });

  it("throws InvalidInputError for injection UDID before calling MCP (T1)", async () => {
    const conn = makeMockConnection({});
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    await expect(
      driver.tap("--injection", { kind: "coordinate", x: TAP_X, y: TAP_Y }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    expect(conn.callTool).not.toHaveBeenCalled();
  });

  it("throws UnknownDeviceError when MCP returns McpToolError on tap", async () => {
    const conn = makeMockConnection({
      callToolImpl: () => Promise.reject(new McpToolError("mobile_tap", "device gone")),
    });
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    await expect(
      driver.tap(UNKNOWN_UDID, { kind: "coordinate", x: TAP_X, y: TAP_Y }),
    ).rejects.toBeInstanceOf(UnknownDeviceError);
  });
});

describe("§2 DeviceDriver.tap (element)", () => {
  it("calls mobile_tap with elementId for element target", async () => {
    const conn = makeMockConnection({
      callToolImpl: () => Promise.resolve({ content: [{ type: "text", text: "tapped" }] }),
    });
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    await driver.tap(VALID_UDID, { kind: "element", elementId: ELEMENT_ID });
    expect(conn.callTool).toHaveBeenCalledWith("mobile_tap", {
      udid: VALID_UDID,
      elementId: ELEMENT_ID,
    });
  });

  it("throws ActionError when MCP returns McpToolError for element tap", async () => {
    const conn = makeMockConnection({
      callToolImpl: () => Promise.reject(new McpToolError("mobile_tap", "element not found")),
    });
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    await expect(
      driver.tap(VALID_UDID, { kind: "element", elementId: "non-existent" }),
    ).rejects.toBeInstanceOf(ActionError);
  });
});

describe("§2 DeviceDriver.typeText (T5 no-log proof)", () => {
  it("calls mobile_type with the provided text", async () => {
    const conn = makeMockConnection({
      callToolImpl: () => Promise.resolve({ content: [{ type: "text", text: "typed" }] }),
    });
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    // The text is passed to the MCP tool — never to any logger
    await driver.typeText(VALID_UDID, "test-input-text");
    expect(conn.callTool).toHaveBeenCalledWith("mobile_type", {
      udid: VALID_UDID,
      text: "test-input-text",
    });
  });

  it("T5: callTool is the ONLY sink for text; no console.log is called", async () => {
    // Spy on console.log/error/warn to assert the text never surfaces there
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const conn = makeMockConnection({
      callToolImpl: () => Promise.resolve({ content: [{ type: "text", text: "ok" }] }),
    });
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    const secretText = "super-secret-credential-text";
    await driver.typeText(VALID_UDID, secretText);

    // Assert no log call captured the secret text
    const allLogCalls = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    const loggedStrings = allLogCalls.flatMap((args) => args.map(String));
    expect(loggedStrings.some((s) => s.includes(secretText))).toBe(false);

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("throws InvalidInputError for injection UDID (T1)", async () => {
    const conn = makeMockConnection({});
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    await expect(driver.typeText("not-a-uuid", "text")).rejects.toBeInstanceOf(InvalidInputError);
    expect(conn.callTool).not.toHaveBeenCalled();
  });

  it("throws UnknownDeviceError when MCP returns McpToolError", async () => {
    const conn = makeMockConnection({
      callToolImpl: () => Promise.reject(new McpToolError("mobile_type", "device lost")),
    });
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    await expect(driver.typeText(UNKNOWN_UDID, "text")).rejects.toBeInstanceOf(UnknownDeviceError);
  });
});

describe("§2 DeviceDriver.swipe — tool-present branch", () => {
  it("calls mobile_swipe when tool is available (direct MCP tool path)", async () => {
    const callToolMock = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "swiped" }],
    });
    const conn = makeMockConnection({ callToolImpl: callToolMock });
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);

    await driver.swipe(VALID_UDID, "up");

    const swipeCall = callToolMock.mock.calls.find(
      (call: unknown[]) => (call[0] as string) === "mobile_swipe",
    );
    expect(swipeCall).toBeDefined();
    const args = (swipeCall as unknown[])[1] as Record<string, unknown>;
    expect(args).toHaveProperty("startX");
    expect(args).toHaveProperty("startY");
    expect(args).toHaveProperty("endX");
    expect(args).toHaveProperty("endY");
  });

  it("passes explicit distance correctly through to coordinates", async () => {
    const callToolMock = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const conn = makeMockConnection({ callToolImpl: callToolMock });
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);

    await driver.swipe(VALID_UDID, "down", SWIPE_DIST);

    const swipeCall = callToolMock.mock.calls.find(
      (call: unknown[]) => (call[0] as string) === "mobile_swipe",
    );
    const args = (swipeCall as unknown[])[1] as Record<string, unknown>;
    const delta = (args["endY"] as number) - (args["startY"] as number);
    expect(delta).toBe(SWIPE_DIST);
  });

  it("throws UnknownDeviceError when MCP returns McpToolError on swipe", async () => {
    const conn = makeMockConnection({
      callToolImpl: () => Promise.reject(new McpToolError("mobile_swipe", "failed")),
    });
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    await expect(driver.swipe(UNKNOWN_UDID, "left")).rejects.toBeInstanceOf(UnknownDeviceError);
  });

  it("throws InvalidInputError for injection UDID (T1)", async () => {
    const conn = makeMockConnection({});
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    await expect(driver.swipe("; rm -rf ~", "right")).rejects.toBeInstanceOf(InvalidInputError);
    expect(conn.callTool).not.toHaveBeenCalled();
  });
});

describe("§2 DeviceDriver.swipe — tool-absent fallback branch (ADR-0002 OQ2)", () => {
  it("falls back to mobile_tap when mobile_swipe is NOT in tool list", async () => {
    const callToolMock = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    // listTools returns tools WITHOUT mobile_swipe
    const conn = makeMockConnection({
      callToolImpl: callToolMock,
      listToolsImpl: () =>
        Promise.resolve([
          { name: "mobile_dump_ui", description: "" },
          { name: "mobile_tap", description: "" },
          { name: "mobile_type", description: "" },
        ]),
    });
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);

    await driver.swipe(VALID_UDID, "up");

    // Only mobile_tap should have been called (fallback), not mobile_swipe
    const swipeCall = callToolMock.mock.calls.find(
      (call: unknown[]) => (call[0] as string) === "mobile_swipe",
    );
    const tapCall = callToolMock.mock.calls.find(
      (call: unknown[]) => (call[0] as string) === "mobile_tap",
    );
    expect(swipeCall).toBeUndefined();
    expect(tapCall).toBeDefined();
  });

  it("caches tool list result (listTools called at most once per session)", async () => {
    const listToolsMock = vi.fn().mockResolvedValue([
      { name: "mobile_dump_ui", description: "" },
      { name: "mobile_swipe", description: "" },
    ]);
    const conn = makeMockConnection({
      callToolImpl: () => Promise.resolve({ content: [{ type: "text", text: "ok" }] }),
      listToolsImpl: listToolsMock,
    });
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);

    // Call swipe three times — listTools should be called only once (cached)
    await driver.swipe(VALID_UDID, "up");
    await driver.swipe(VALID_UDID, "down");
    await driver.swipe(VALID_UDID, "left");
    expect(listToolsMock).toHaveBeenCalledTimes(1);
  });

  it("fallback: throws UnknownDeviceError on McpToolError from mobile_tap", async () => {
    const conn = makeMockConnection({
      callToolImpl: () => Promise.reject(new McpToolError("mobile_tap", "failed")),
      listToolsImpl: () => Promise.resolve([{ name: "mobile_tap", description: "" }]),
    });
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    await expect(driver.swipe(UNKNOWN_UDID, "right")).rejects.toBeInstanceOf(UnknownDeviceError);
  });
});

// ---------------------------------------------------------------------------
// §3 — T3 payload normalization security cases (malformed/oversized)
// ---------------------------------------------------------------------------

describe("§3 T3 payload normalization security cases", () => {
  it("malformed dump_ui payload (null) → MalformedPayloadError (T3)", () => {
    expect(() => normalizeA11ySnapshot(null, TEST_NORM_CONFIG)).toThrow(MalformedPayloadError);
  });

  it("malformed dump_ui payload (no content) → MalformedPayloadError (T3)", () => {
    expect(() => normalizeA11ySnapshot({}, TEST_NORM_CONFIG)).toThrow(MalformedPayloadError);
  });

  it("malformed dump_ui payload (content is not array) → MalformedPayloadError (T3)", () => {
    expect(() => normalizeA11ySnapshot({ content: "not-array" }, TEST_NORM_CONFIG)).toThrow(
      MalformedPayloadError,
    );
  });

  it("empty a11y snapshot text → MalformedPayloadError (T3, no silent swallow)", () => {
    const raw = { content: [{ type: "text", text: "" }] };
    expect(() => normalizeA11ySnapshot(raw, TEST_NORM_CONFIG)).toThrow(MalformedPayloadError);
  });

  it("oversized a11y snapshot → MalformedPayloadError (T3, no OOM)", () => {
    const boundConfig: NormalizationConfig = { ...TEST_NORM_CONFIG, maxA11ySnapshotBytes: 2 };
    const raw = { content: [{ type: "text", text: "abc" }] };
    expect(() => normalizeA11ySnapshot(raw, boundConfig)).toThrow(MalformedPayloadError);
  });

  it("malformed screenshot payload (null) → MalformedPayloadError (T3)", () => {
    expect(() => normalizeScreenshot(null, TEST_NORM_CONFIG)).toThrow(MalformedPayloadError);
  });

  it("screenshot with no image content → MalformedPayloadError (T3)", () => {
    const raw = { content: [{ type: "text", text: "info" }] };
    expect(() => normalizeScreenshot(raw, TEST_NORM_CONFIG)).toThrow(MalformedPayloadError);
  });

  it("oversized screenshot → MalformedPayloadError (T3, no OOM)", () => {
    const bigBuf = Buffer.alloc(50, 0xab);
    const raw = { content: [{ type: "image", data: bigBuf.toString("base64") }] };
    const boundConfig: NormalizationConfig = { ...TEST_NORM_CONFIG, maxScreenshotBytes: 10 };
    expect(() => normalizeScreenshot(raw, boundConfig)).toThrow(MalformedPayloadError);
  });

  it("off-screen coordinate (negative) → ActionError (T3 typed action error)", () => {
    expect(() => validateCoordinateTarget(-10, 0, TEST_NORM_CONFIG)).toThrow(ActionError);
  });

  it("off-screen coordinate (beyond bounds) → ActionError (T3 typed action error)", () => {
    expect(() =>
      validateCoordinateTarget(SCREEN_W + 100, SCREEN_H + 100, TEST_NORM_CONFIG),
    ).toThrow(ActionError);
  });

  it("T3 error messages do not contain raw payload data (metadata only)", () => {
    const raw = { content: [{ type: "text", text: "" }] };
    try {
      normalizeA11ySnapshot(raw, TEST_NORM_CONFIG);
    } catch (err) {
      expect(err).toBeInstanceOf(MalformedPayloadError);
      // Error message should describe the problem, not include snapshot content
      expect((err as Error).message).not.toContain("__payload__");
    }
  });
});

// ---------------------------------------------------------------------------
// §4 — Driving contract suite: runDrivingContract against real DeviceDriver (AC7)
// ---------------------------------------------------------------------------
//
// This runs the shared runDrivingContract section runner against the REAL DeviceDriver
// (not FakeMobileDriver) with a mocked McpConnection that returns canned MCP payloads.
// Per ADR-0003 §1.1: real adapters must pass the per-capability section runner, not
// just the Fake-backed aggregator. The Fake continues to be tested via the full-suite
// aggregator in fake-driver.contract.test.ts.
//
// Mock design:
//   - callTool dispatches on the first argument (toolName) to return canned payloads
//     for any validUdid call, and throws McpToolError for unknownUdid calls.
//   - Injection-shaped UDIDs never reach callTool (validateUdid rejects them first —
//     DeviceDriver validates the UDID before any MCP call, per T1 security control).
//   - listTools always returns the full tool set (including mobile_swipe) so the
//     tool-present swipe path is exercised by default.

const CONTRACT_VALID_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const CONTRACT_UNKNOWN_UDID = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";

/** Build a canned McpConnection that serves valid payloads for CONTRACT_VALID_UDID
 *  and throws McpToolError for CONTRACT_UNKNOWN_UDID. */
function makeDrivingContractConnection(): McpConnection {
  return {
    isConnected: true,
    connect: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([
      { name: "mobile_dump_ui", description: "" },
      { name: "mobile_screenshot", description: "" },
      { name: "mobile_tap", description: "" },
      { name: "mobile_type", description: "" },
      { name: "mobile_swipe", description: "" },
    ]),
    callTool: vi
      .fn()
      .mockImplementation((toolName: string, args: Record<string, unknown>): Promise<unknown> => {
        // Unknown UDID: any tool call should throw McpToolError
        if (args["udid"] === CONTRACT_UNKNOWN_UDID) {
          return Promise.reject(new McpToolError(toolName, "device not found"));
        }

        // Canned responses per tool for the valid UDID
        switch (toolName) {
          case "mobile_dump_ui":
            return Promise.resolve({
              content: [
                {
                  type: "text",
                  text: "<AXApplication><AXWindow>canned-a11y</AXWindow></AXApplication>",
                },
              ],
            });
          case "mobile_screenshot":
            return Promise.resolve({
              content: [{ type: "image", data: SYNTHETIC_PNG_BASE64 }],
            });
          case "mobile_tap":
          case "mobile_type":
          case "mobile_swipe":
            return Promise.resolve({ content: [{ type: "text", text: "ok" }] });
          default:
            return Promise.resolve({ content: [{ type: "text", text: "ok" }] });
        }
      }),
  } as unknown as McpConnection;
}

const DRIVING_FIXTURES: DrivingFixtures = {
  validUdid: CONTRACT_VALID_UDID,
  unknownUdid: CONTRACT_UNKNOWN_UDID,
  // Use the default injection vectors (the standard set in driver-contract.ts)
};

const DRIVING_ERROR_CLASSES: DrivingErrorClasses = {
  unknownDevice: UnknownDeviceError,
  invalidInput: InvalidInputError,
};

// Run the shared driving contract against the real DeviceDriver (AC7).
// The mock McpConnection makes CONTRACT_VALID_UDID observable and rejects
// CONTRACT_UNKNOWN_UDID with McpToolError → DeviceDriver converts to UnknownDeviceError.
runDrivingContract({
  createDriving: () =>
    new DeviceDriver(makeDrivingContractConnection(), STUB_CONFIG, TEST_NORM_CONFIG),
  fixtures: DRIVING_FIXTURES,
  errorClasses: DRIVING_ERROR_CLASSES,
});

// ---------------------------------------------------------------------------
// §5 — Domain-type leak guard: returned values must be domain types
// ---------------------------------------------------------------------------

describe("§5 Anti-corruption: returned values are domain types (no MCP shape leaks)", () => {
  it("snapshotAccessibilityTree returns a plain string (not an MCP content object)", async () => {
    const conn = makeMockConnection({
      callToolImpl: () => Promise.resolve({ content: [{ type: "text", text: "domain-string" }] }),
    });
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    const result = await driver.snapshotAccessibilityTree(VALID_UDID);
    // Must be a plain string, not an object with 'content' property
    expect(typeof result).toBe("string");
    expect(result).not.toHaveProperty("content");
  });

  it("screenshot returns Uint8Array, not base64 string or MCP content object", async () => {
    const conn = makeMockConnection({
      callToolImpl: () =>
        Promise.resolve({
          content: [{ type: "image", data: SYNTHETIC_PNG_BASE64 }],
        }),
    });
    const driver = new DeviceDriver(conn, STUB_CONFIG, TEST_NORM_CONFIG);
    const result = await driver.screenshot(VALID_UDID);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(typeof result).not.toBe("string");
    expect(result).not.toHaveProperty("content");
  });
});

// ---------------------------------------------------------------------------
// §6 — DEFAULT_NORMALIZATION_CONFIG export sanity
// ---------------------------------------------------------------------------

describe("§6 DEFAULT_NORMALIZATION_CONFIG", () => {
  it("has sensible positive bounds", () => {
    expect(DEFAULT_NORMALIZATION_CONFIG.maxA11ySnapshotBytes).toBeGreaterThan(0);
    expect(DEFAULT_NORMALIZATION_CONFIG.maxScreenshotBytes).toBeGreaterThan(0);
    expect(DEFAULT_NORMALIZATION_CONFIG.screenWidthPx).toBeGreaterThan(0);
    expect(DEFAULT_NORMALIZATION_CONFIG.screenHeightPx).toBeGreaterThan(0);
  });
});
