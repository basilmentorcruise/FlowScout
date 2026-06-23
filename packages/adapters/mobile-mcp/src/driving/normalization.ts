/**
 * normalization.ts — Anti-corruption mappers (ADR-0002 §2.2, ADR-0001 §2.6).
 *
 * This module owns the boundary between raw MCP response shapes and domain types.
 * MCP vocabulary NEVER leaks past this file into the rest of the adapter or domain.
 *
 * Security controls:
 *  T3 — size bounds enforced before any allocation; malformed/oversized → typed error.
 *  T4 — metadata logged only; screenshot bytes / full a11y content are NEVER logged.
 *  NFR1 — MCP shapes schema-validated before domain types are constructed.
 *
 * All bound constants come from injected config (no magic numbers, ADR-0001 §6).
 */

import type { A11ySnapshot, ScreenshotBytes } from "@flowscout/domain";
import type { McpToolResult } from "../connection/McpConnection.js";
import { McpAdapterError } from "../connection/errors.js";

// ---------------------------------------------------------------------------
// Module-level constants (no inline magic numbers per ADR-0001 §6)
// ---------------------------------------------------------------------------

/** Max chars to include in an InvalidInputError message (avoids long error payloads). */
const INVALID_INPUT_MESSAGE_TRUNCATE_LENGTH = 60;

/** Bytes per kilobyte. */
const BYTES_PER_KB = 1024;
/** Bytes per megabyte (used to express MB-scale bounds without inline magic numbers). */
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;

/**
 * Base64 encodes every 3 raw bytes as 4 ASCII characters.
 * Used to compute the upper-bound decoded byte count from a base64 string length
 * before allocating a Buffer (T3 / CWE-400 pre-decode size gate).
 */
const BASE64_CHARS_PER_BYTE_GROUP = 4;
/** Raw bytes per base64 character group. */
const BASE64_BYTES_PER_GROUP = 3;

/** Divisor for computing screen centre from screen dimension. */
const HALF_DIVISOR = 2;

// ---------------------------------------------------------------------------
// Driving-capability error types (extend the base error, never edit errors.ts)
// ---------------------------------------------------------------------------

/**
 * Thrown when an MCP payload is malformed, empty, or exceeds configured size bounds (T3).
 * Extends McpAdapterError so callers can catch the adapter-level base class.
 */
export class MalformedPayloadError extends McpAdapterError {
  constructor(context: string, detail: string) {
    super(`MalformedPayloadError [${context}]: ${detail}`);
    this.name = "MalformedPayloadError";
  }
}

/**
 * Thrown when a tap coordinate target is off-screen or otherwise invalid (T1/T3).
 */
export class ActionError extends McpAdapterError {
  constructor(detail: string) {
    super(`ActionError: ${detail}`);
    this.name = "ActionError";
  }
}

/**
 * Thrown when a UDID fails format validation (UUID allowlist — T1).
 */
export class InvalidInputError extends McpAdapterError {
  constructor(field: string, value: unknown) {
    const truncated = JSON.stringify(String(value)).slice(0, INVALID_INPUT_MESSAGE_TRUNCATE_LENGTH);
    super(`InvalidInputError: "${field}" value failed validation — ` + `received: ${truncated}`);
    this.name = "InvalidInputError";
  }
}

/**
 * Thrown when an operation targets a device UDID that the MCP server does not know.
 */
export class UnknownDeviceError extends McpAdapterError {
  constructor(udid: string) {
    super(`UnknownDeviceError: device with UDID "${udid}" is not known to the MCP server`);
    this.name = "UnknownDeviceError";
  }
}

// ---------------------------------------------------------------------------
// Payload size bounds (injected from config — no magic numbers)
// ---------------------------------------------------------------------------

/** The size-bound config slice that normalization functions consume (T3). */
export interface NormalizationConfig {
  /** Maximum allowed byte size of an a11y snapshot string (UTF-8 encoded). */
  readonly maxA11ySnapshotBytes: number;
  /** Maximum allowed byte size of screenshot data (raw bytes). */
  readonly maxScreenshotBytes: number;
  /** Simulator screen width in logical pixels (for coordinate validation). */
  readonly screenWidthPx: number;
  /** Simulator screen height in logical pixels (for coordinate validation). */
  readonly screenHeightPx: number;
}

/** A11y snapshot bound in MB (10 MB). */
const DEFAULT_MAX_A11Y_MB = 10;
/** Screenshot bound in MB (20 MB). */
const DEFAULT_MAX_SCREENSHOT_MB = 20;
/** iPhone 16 default logical screen width in points. */
const DEFAULT_SCREEN_WIDTH_PX = 1170;
/** iPhone 16 default logical screen height in points. */
const DEFAULT_SCREEN_HEIGHT_PX = 2532;

/** Default normalization bounds — conservative but generous for real devices. */
export const DEFAULT_NORMALIZATION_CONFIG: NormalizationConfig = {
  maxA11ySnapshotBytes: DEFAULT_MAX_A11Y_MB * BYTES_PER_MB,
  maxScreenshotBytes: DEFAULT_MAX_SCREENSHOT_MB * BYTES_PER_MB,
  screenWidthPx: DEFAULT_SCREEN_WIDTH_PX,
  screenHeightPx: DEFAULT_SCREEN_HEIGHT_PX,
};

// ---------------------------------------------------------------------------
// UUID allowlist (T1 — UDID must match UUID format)
// ---------------------------------------------------------------------------

const UDID_PATTERN =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/**
 * Validate a UDID string against the UUID allowlist (T1).
 * Throws InvalidInputError on rejection — never sanitizes and continues.
 */
export function validateUdid(udid: string): void {
  if (!UDID_PATTERN.test(udid)) {
    throw new InvalidInputError("udid", udid);
  }
}

// ---------------------------------------------------------------------------
// MCP payload schema types (adapter-internal only — never cross the boundary)
// ---------------------------------------------------------------------------

/**
 * The expected shape of a mobile_dump_ui / accessibility tool call result.
 * Schema-validated at the boundary; never passed out of this module.
 */
interface RawDumpUiResult {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}

/**
 * The expected shape of a mobile_screenshot tool call result.
 * Schema-validated at the boundary; never passed out of this module.
 */
interface RawScreenshotResult {
  readonly content: ReadonlyArray<{
    readonly type: string;
    readonly data?: string;
    readonly text?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Schema guard helpers (pure functions — trivially testable)
// ---------------------------------------------------------------------------

function isDumpUiResult(value: unknown): value is RawDumpUiResult {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj["content"])) return false;
  const content = obj["content"] as unknown[];
  return content.every(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>)["type"] === "string",
  );
}

function isScreenshotResult(value: unknown): value is RawScreenshotResult {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj["content"])) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Normalization functions (anti-corruption mappers)
// ---------------------------------------------------------------------------

/**
 * Normalize a raw MCP `mobile_dump_ui` (or equivalent a11y) result into
 * the domain `A11ySnapshot` type.
 *
 * Security (T3):
 *  1. Schema-validate the MCP response shape before touching it.
 *  2. Reject empty text (no silent swallow).
 *  3. Enforce the configured size bound to prevent OOM on giant trees.
 *  4. Metadata only — never log the snapshot content (T4).
 */
export function normalizeA11ySnapshot(
  raw: McpToolResult,
  config: NormalizationConfig,
): A11ySnapshot {
  // Step 1: Schema validate
  if (!isDumpUiResult(raw)) {
    throw new MalformedPayloadError(
      "snapshotAccessibilityTree",
      "MCP response does not match expected dump-ui shape",
    );
  }

  // Step 2: Extract text from first text-type content item
  const textContent = raw.content.find((item) => item.type === "text" && item.text !== undefined);
  if (
    textContent === undefined ||
    textContent.text === undefined ||
    textContent.text.length === 0
  ) {
    throw new MalformedPayloadError(
      "snapshotAccessibilityTree",
      "MCP response contained no non-empty text content",
    );
  }

  const text = textContent.text;

  // Step 3: Size bound (T3 — prevent OOM on oversized payload)
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > config.maxA11ySnapshotBytes) {
    throw new MalformedPayloadError(
      "snapshotAccessibilityTree",
      `A11y snapshot byte size ${String(byteLength)} exceeds configured limit of ${String(config.maxA11ySnapshotBytes)} bytes`,
    );
  }

  // Return the branded domain type — MCP shape never leaks past here
  // T4: log only metadata (byte size), never the content itself
  return text as A11ySnapshot;
}

/**
 * Normalize a raw MCP `mobile_screenshot` result into `ScreenshotBytes` (Uint8Array PNG).
 *
 * Security (T3 / CWE-400):
 *  1. Schema-validate the MCP response shape.
 *  2. Reject missing/empty image data.
 *  3. Pre-decode size gate: estimate decoded byte count from base64 string length and
 *     reject oversized payloads BEFORE allocating a Buffer (prevents partial-OOM).
 *     Formula: `Math.floor(base64Length * BASE64_BYTES_PER_GROUP / BASE64_CHARS_PER_BYTE_GROUP)`
 *     is a conservative upper bound (padding chars only reduce the true decoded size, so
 *     the floor estimate may over-count by at most 2 bytes compared to the actual size).
 *  4. Decode base64 → Buffer → Uint8Array (safe: pre-gate passed).
 *  5. Post-decode exact size check (defense in depth — handles any edge case where the
 *     pre-decode estimate under-counted).
 *  T4: never log the screenshot bytes.
 */
export function normalizeScreenshot(
  raw: McpToolResult,
  config: NormalizationConfig,
): ScreenshotBytes {
  // Step 1: Schema validate
  if (!isScreenshotResult(raw)) {
    throw new MalformedPayloadError(
      "screenshot",
      "MCP response does not match expected screenshot shape",
    );
  }

  // Step 2: Find image content item (base64-encoded data)
  const imageContent = raw.content.find((item) => item.type === "image" && item.data !== undefined);
  if (
    imageContent === undefined ||
    imageContent.data === undefined ||
    imageContent.data.length === 0
  ) {
    throw new MalformedPayloadError("screenshot", "MCP response contained no image data");
  }

  // Step 3: Pre-decode size gate (T3 / CWE-400 — reject BEFORE Buffer allocation).
  // base64 encodes 3 bytes per 4 chars; Math.floor gives a slightly-conservative estimate
  // (over-counts by at most 2 bytes due to padding). If the estimate already exceeds the
  // limit, the actual decoded size certainly does too — reject immediately.
  const base64Length = imageContent.data.length;
  const estimatedDecodedBytes = Math.floor(
    (base64Length * BASE64_BYTES_PER_GROUP) / BASE64_CHARS_PER_BYTE_GROUP,
  );
  if (estimatedDecodedBytes > config.maxScreenshotBytes) {
    throw new MalformedPayloadError(
      "screenshot",
      `Screenshot base64 payload (estimated ${String(estimatedDecodedBytes)} decoded bytes) exceeds configured limit of ${String(config.maxScreenshotBytes)} bytes`,
    );
  }

  // Step 4: Decode base64 → Buffer → Uint8Array (safe: pre-gate passed)
  const buffer = Buffer.from(imageContent.data, "base64");

  // Step 5: Post-decode exact size check (defense in depth — T3)
  if (buffer.length > config.maxScreenshotBytes) {
    throw new MalformedPayloadError(
      "screenshot",
      `Screenshot byte size ${String(buffer.length)} exceeds configured limit of ${String(config.maxScreenshotBytes)} bytes`,
    );
  }

  // T4: log only byte size metadata, never the bytes themselves
  return new Uint8Array(buffer);
}

/**
 * Validate a coordinate tap target is within the configured screen bounds (T1/T3).
 * Throws ActionError if the coordinate is off-screen.
 */
export function validateCoordinateTarget(x: number, y: number, config: NormalizationConfig): void {
  if (x < 0 || y < 0 || x >= config.screenWidthPx || y >= config.screenHeightPx) {
    throw new ActionError(
      `Coordinate (${String(x)}, ${String(y)}) is off-screen ` +
        `(screen: ${String(config.screenWidthPx)}×${String(config.screenHeightPx)})`,
    );
  }
}

/** Default swipe distance as a fraction of the relevant screen dimension. */
const DEFAULT_SWIPE_FRACTION = 0.4;

/**
 * Compute swipe start/end coordinates from a direction + optional distance (pixels).
 * Used when the MCP server's swipe tool requires from/to coordinates rather than a
 * direction+distance keyword (ADR-0002 OQ2 fallback).
 *
 * Swipe starts from screen centre and ends direction × distance away.
 */
export function swipeDirectionToCoordinates(
  direction: "up" | "down" | "left" | "right",
  config: NormalizationConfig,
  distancePx?: number,
): { startX: number; startY: number; endX: number; endY: number } {
  const centerX = Math.floor(config.screenWidthPx / HALF_DIVISOR);
  const centerY = Math.floor(config.screenHeightPx / HALF_DIVISOR);

  const defaultDistanceByAxis = {
    vertical: Math.floor(config.screenHeightPx * DEFAULT_SWIPE_FRACTION),
    horizontal: Math.floor(config.screenWidthPx * DEFAULT_SWIPE_FRACTION),
  };

  switch (direction) {
    case "up": {
      const dist = distancePx ?? defaultDistanceByAxis.vertical;
      return { startX: centerX, startY: centerY, endX: centerX, endY: centerY - dist };
    }
    case "down": {
      const dist = distancePx ?? defaultDistanceByAxis.vertical;
      return { startX: centerX, startY: centerY, endX: centerX, endY: centerY + dist };
    }
    case "left": {
      const dist = distancePx ?? defaultDistanceByAxis.horizontal;
      return { startX: centerX, startY: centerY, endX: centerX - dist, endY: centerY };
    }
    case "right": {
      const dist = distancePx ?? defaultDistanceByAxis.horizontal;
      return { startX: centerX, startY: centerY, endX: centerX + dist, endY: centerY };
    }
  }
}
