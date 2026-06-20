/**
 * MobileDriverPort — the primary port isolating the crawl engine from any concrete
 * mobile driver (Mobile MCP, direct WebDriverAgent, Android, etc.).
 *
 * The engine (application layer) only knows this interface.
 * adapters/mobile-mcp is the only concrete implementation for MVP.
 */

/** A device listed by the driver (simulator or physical). */
export interface DeviceInfo {
  readonly udid: string;
  readonly name: string;
  readonly platform: "ios" | "android";
  readonly osVersion: string;
  readonly state: "booted" | "shutdown" | "unknown";
}

/** A tap target identified by element or coordinate. */
export type TapTarget =
  | { readonly kind: "element"; readonly elementId: string }
  | { readonly kind: "coordinate"; readonly x: number; readonly y: number };

/** Swipe direction. */
export type SwipeDirection = "up" | "down" | "left" | "right";

/** Raw accessibility tree snapshot (opaque serialised string; domain does not parse it). */
export type A11ySnapshot = string & { readonly __brand: "A11ySnapshot" };

/** Raw screenshot bytes (PNG). Uint8Array keeps the domain Node-free; adapters may return a Buffer (a Uint8Array). */
export type ScreenshotBytes = Uint8Array;

/**
 * MobileDriverPort — everything the crawl engine needs to observe and act on a device.
 * The engine never imports the MCP SDK or any platform-specific API.
 */
export interface MobileDriverPort {
  /** List available simulators/devices. */
  listDevices(): Promise<readonly DeviceInfo[]>;

  /** Get the accessibility tree snapshot for the current screen. */
  snapshotAccessibilityTree(udid: string): Promise<A11ySnapshot>;

  /** Capture a screenshot. */
  screenshot(udid: string): Promise<ScreenshotBytes>;

  /** Tap at a target (element ID or coordinate). */
  tap(udid: string, target: TapTarget): Promise<void>;

  /** Type text into the focused element. */
  typeText(udid: string, text: string): Promise<void>;

  /** Swipe in a direction. */
  swipe(udid: string, direction: SwipeDirection, distance?: number): Promise<void>;
}

/**
 * SimulatorLifecycle — lifecycle operations on a simulator (boot, install, snapshot, reset).
 * Separate from the driving operations to keep concerns clear.
 * Implemented by the same adapter as MobileDriverPort for MVP.
 */
export interface SimulatorLifecycle {
  /** Boot a simulator by UDID. */
  bootSimulator(udid: string): Promise<void>;

  /** Install an .app bundle onto the simulator. */
  installApp(udid: string, appBundlePath: string): Promise<void>;

  /** Launch the installed app. */
  launchApp(udid: string, bundleId: string): Promise<void>;

  /** Take a simulator state snapshot (for reset-to-clean). */
  takeSnapshot(udid: string, snapshotName: string): Promise<void>;

  /** Reset simulator to a previously taken snapshot. */
  resetToSnapshot(udid: string, snapshotName: string): Promise<void>;

  /** Shutdown the simulator. */
  shutdownSimulator(udid: string): Promise<void>;
}
