/**
 * driving/index.ts — public barrel for the driving capability module.
 *
 * #15 (E1.4 — Device driving + payload normalization) OWNS AND REPLACES
 * the stub that #12 left here.
 *
 * Exports the real DeviceDriver class so capabilities.ts (which was frozen by
 * #12 and MUST NOT be edited) can import { DrivingStub } under the legacy name
 * OR any caller can import DeviceDriver directly.
 *
 * ADR-0002 §2.3: capabilities.ts imports DrivingStub by name from this barrel.
 * We export DeviceDriver as DrivingStub to satisfy that import without touching
 * capabilities.ts (the frozen file).
 */

export { DeviceDriver } from "./DeviceDriver.js";

// Re-export as DrivingStub so the frozen capabilities.ts import continues to compile.
// `DrivingStub` is the name capabilities.ts was written to expect.
export { DeviceDriver as DrivingStub } from "./DeviceDriver.js";

// Re-export error and config types for consumers of this capability
export {
  MalformedPayloadError,
  ActionError,
  InvalidInputError,
  UnknownDeviceError,
  DEFAULT_NORMALIZATION_CONFIG,
  validateUdid,
  normalizeA11ySnapshot,
  normalizeScreenshot,
  validateCoordinateTarget,
  swipeDirectionToCoordinates,
} from "./normalization.js";
export type { NormalizationConfig } from "./normalization.js";
