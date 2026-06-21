/**
 * DeviceDriver.ts — real implementation of DrivingCapability (ADR-0002 §2.2, §5/#15).
 *
 * Implements all five driving methods by calling mobile-mcp MCP tools via the
 * injected McpConnection, normalizing responses into domain types at the boundary.
 *
 * Tool mapping (ADR-0002 OQ2 coverage table):
 *   snapshotAccessibilityTree → mobile_dump_ui (direct MCP tool)
 *   screenshot                → mobile_screenshot (direct MCP tool)
 *   tap (element)             → mobile_tap with elementId parameter (MCP server resolves
 *                               element to coordinates server-side — no adapter round-trip)
 *   tap (coordinate)          → mobile_tap (direct MCP tool)
 *   typeText                  → mobile_type (direct MCP tool)
 *   swipe                     → mobile_swipe if tool present; else coordinate fallback
 *                               (ADR-0002 OQ2: detect via listTools() at connect time)
 *
 * Security controls (per threat model):
 *   T1  — udid validated against UUID allowlist before any MCP call.
 *   T3  — payload normalization bounds enforced in normalization.ts.
 *   T4/T5 — typeText text is NEVER logged (not even at debug level).
 *           Screenshot bytes and full a11y content are NEVER logged.
 *   NFR1 — MCP shapes normalized to domain types in normalization.ts; no MCP shape leaks.
 */

import type { A11ySnapshot, ScreenshotBytes, TapTarget, SwipeDirection } from "@flowscout/domain";
import type { DrivingCapability } from "../connection/capabilities.js";
import type { McpConnection } from "../connection/McpConnection.js";
import type { McpServerConfig } from "../connection/connection-config.js";
import { McpToolError } from "../connection/errors.js";
import {
  normalizeA11ySnapshot,
  normalizeScreenshot,
  validateCoordinateTarget,
  swipeDirectionToCoordinates,
  validateUdid,
  UnknownDeviceError,
  ActionError,
  DEFAULT_NORMALIZATION_CONFIG,
} from "./normalization.js";
import type { NormalizationConfig } from "./normalization.js";

// ---------------------------------------------------------------------------
// MCP tool names (adapter-internal constants — never leak to domain)
// ---------------------------------------------------------------------------

const TOOL_DUMP_UI = "mobile_dump_ui";
const TOOL_SCREENSHOT = "mobile_screenshot";
const TOOL_TAP = "mobile_tap";
const TOOL_TYPE = "mobile_type";
const TOOL_SWIPE = "mobile_swipe";

// ---------------------------------------------------------------------------
// DeviceDriver
// ---------------------------------------------------------------------------

/**
 * Real implementation of DrivingCapability.
 *
 * Gesture fallback strategy (ADR-0002 OQ2):
 *   On the first swipe call, listTools() is consulted to determine if the server
 *   exposes `mobile_swipe`. The result is cached so subsequent calls pay no
 *   extra round-trip. If the tool is absent, swipe falls back to computing
 *   start/end coordinates and calling `mobile_tap` as a coarse gesture substitute
 *   (pragmatic fallback; confirmed via E2E in #18).
 */
export class DeviceDriver implements DrivingCapability {
  /** Cached result of tool-presence detection. null = not yet probed. */
  private swipeToolAvailable: boolean | null = null;

  constructor(
    private readonly connection: McpConnection,
    // config is part of the Wave-1 constructor seam (ADR-0002 §2.3) even though
    // DeviceDriver delegates all timeout enforcement to the injected McpConnection.
    // Prefixed with _ to satisfy strict TS6138 without removing the seam.
    _config: McpServerConfig,
    private readonly normConfig: NormalizationConfig = DEFAULT_NORMALIZATION_CONFIG,
  ) {}

  // ---------------------------------------------------------------------------
  // snapshotAccessibilityTree
  // ---------------------------------------------------------------------------

  async snapshotAccessibilityTree(udid: string): Promise<A11ySnapshot> {
    validateUdid(udid);
    await this.connection.connect();

    let raw: unknown;
    try {
      raw = await this.connection.callTool(TOOL_DUMP_UI, { udid });
    } catch (err) {
      if (err instanceof McpToolError) {
        throw new UnknownDeviceError(udid);
      }
      throw err;
    }

    // Normalize the raw MCP payload → domain type (T3/NFR1)
    return normalizeA11ySnapshot(raw, this.normConfig);
  }

  // ---------------------------------------------------------------------------
  // screenshot
  // ---------------------------------------------------------------------------

  async screenshot(udid: string): Promise<ScreenshotBytes> {
    validateUdid(udid);
    await this.connection.connect();

    let raw: unknown;
    try {
      raw = await this.connection.callTool(TOOL_SCREENSHOT, { udid });
    } catch (err) {
      if (err instanceof McpToolError) {
        throw new UnknownDeviceError(udid);
      }
      throw err;
    }

    // T4: normalizeScreenshot never logs screenshot bytes — metadata only
    return normalizeScreenshot(raw, this.normConfig);
  }

  // ---------------------------------------------------------------------------
  // tap
  // ---------------------------------------------------------------------------

  async tap(udid: string, target: TapTarget): Promise<void> {
    validateUdid(udid);
    await this.connection.connect();

    if (target.kind === "coordinate") {
      // T1/T3: validate coordinate is on-screen before calling MCP
      validateCoordinateTarget(target.x, target.y, this.normConfig);
      try {
        await this.connection.callTool(TOOL_TAP, { udid, x: target.x, y: target.y });
      } catch (err) {
        if (err instanceof McpToolError) {
          throw new UnknownDeviceError(udid);
        }
        throw err;
      }
    } else {
      // Element tap: mobile_tap accepts an optional elementId parameter.
      // Per ADR-0002 OQ2, we pass elementId directly to mobile_tap so the MCP server
      // can resolve the element to screen coordinates internally. This avoids a
      // round-trip dump_ui lookup in the adapter and keeps resolution server-side.
      //
      // A McpToolError from mobile_tap when targeting an element is re-thrown as
      // ActionError (not UnknownDeviceError) because the failure is an element-not-found
      // condition, not a device-not-found condition. The #18 E2E ticket confirms the
      // round-trip mapping against a real simulator.
      try {
        await this.connection.callTool(TOOL_TAP, { udid, elementId: target.elementId });
      } catch (err) {
        if (err instanceof McpToolError) {
          // Re-throw as ActionError so the caller gets a typed action error
          throw new ActionError(`Element tap failed for elementId "${target.elementId}": ${String(err)}`);
        }
        throw err;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // typeText
  // ---------------------------------------------------------------------------

  async typeText(udid: string, text: string): Promise<void> {
    validateUdid(udid);
    // T4/T5: text is NEVER logged here or anywhere in this class.
    await this.connection.connect();

    try {
      // text passed directly; never logged (T5 no-log discipline for E6 credential reuse)
      await this.connection.callTool(TOOL_TYPE, { udid, text });
    } catch (err) {
      if (err instanceof McpToolError) {
        throw new UnknownDeviceError(udid);
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // swipe (ADR-0002 OQ2 gesture fallback strategy)
  // ---------------------------------------------------------------------------

  async swipe(udid: string, direction: SwipeDirection, distance?: number): Promise<void> {
    validateUdid(udid);
    await this.connection.connect();

    const hasTool = await this.probeSwipeTool();

    if (hasTool) {
      // Direct MCP tool path
      const coords = swipeDirectionToCoordinates(direction, this.normConfig, distance);
      try {
        await this.connection.callTool(TOOL_SWIPE, {
          udid,
          startX: coords.startX,
          startY: coords.startY,
          endX: coords.endX,
          endY: coords.endY,
        });
      } catch (err) {
        if (err instanceof McpToolError) {
          throw new UnknownDeviceError(udid);
        }
        throw err;
      }
    } else {
      // Fallback: no swipe tool available — simulate via coordinate tap at end point
      // ADR-0002 OQ2: "the fallback is isolated in a dedicated, separately testable seam"
      const coords = swipeDirectionToCoordinates(direction, this.normConfig, distance);
      try {
        await this.connection.callTool(TOOL_TAP, { udid, x: coords.endX, y: coords.endY });
      } catch (err) {
        if (err instanceof McpToolError) {
          throw new UnknownDeviceError(udid);
        }
        throw err;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Gesture tool detection (cached; computed once per connection session)
  // ---------------------------------------------------------------------------

  /**
   * Probe whether the connected MCP server exposes the `mobile_swipe` tool.
   * Result is cached after the first call (ADR-0002 OQ2: "computed from
   * connection.listTools(), cached").
   */
  private async probeSwipeTool(): Promise<boolean> {
    if (this.swipeToolAvailable !== null) {
      return this.swipeToolAvailable;
    }
    const tools = await this.connection.listTools();
    const available = tools.some((t) => t.name === TOOL_SWIPE);
    this.swipeToolAvailable = available;
    return available;
  }
}
