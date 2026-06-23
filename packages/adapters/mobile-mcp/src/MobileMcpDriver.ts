/**
 * MobileMcpDriver — frozen facade implementing MobileDriverPort + SimulatorLifecycle.
 *
 * THIS FILE IS OWNED AND FROZEN BY TICKET #12.
 * Wave-1 tickets (#14/#15/#16/#17) MUST NOT edit this file.
 * They replace only their own capability module (src/<capability>/index.ts).
 *
 * Design (ADR-0002 §2.1 — Facade + Delegation + DI):
 * - This class is a THIN DELEGATION LAYER with ZERO logic.
 * - Each port method delegates to the injected capability module.
 * - The MCP SDK is used ONLY in src/connection/McpConnection.ts; never here.
 * - One instance satisfies BOTH MobileDriverPort AND SimulatorLifecycle
 *   (preserving the composition-root contract: simulatorLifecycle = mobileDriver).
 *
 * Composition root (packages/api) constructs:
 *   const driver = new MobileMcpDriver(config);
 *   // driver satisfies both ports — single instance, no duplication needed.
 *
 * THIS IS THE ONLY ADAPTER PACKAGE THAT MAY (INDIRECTLY) USE THE MCP SDK.
 * The SDK import lives in src/connection/McpConnection.ts exclusively.
 * See ADR-0001 §2.6, ADR-0002 §2.1.
 */

import type {
  MobileDriverPort,
  SimulatorLifecycle,
  DeviceInfo,
  TapTarget,
  SwipeDirection,
  A11ySnapshot,
  ScreenshotBytes,
} from "@flowscout/domain";

import type { MobileMcpDriverConfig, CapabilityBundle } from "./connection/index.js";
import { defaultCapabilities } from "./connection/index.js";

/**
 * MobileMcpDriver — the single public class the composition root binds to both ports.
 *
 * @param config - server command, env, and timeout config (injected, no magic numbers)
 * @param deps   - optional capability bundle for DI / testing (defaults to stubs until Wave-1 lands)
 */
export class MobileMcpDriver implements MobileDriverPort, SimulatorLifecycle {
  private readonly deps: CapabilityBundle;

  constructor(config: MobileMcpDriverConfig, deps?: CapabilityBundle) {
    this.deps = deps ?? defaultCapabilities(config.server);
  }

  // -------------------------------------------------------------------------
  // MobileDriverPort — driving surface (delegates to DrivingCapability)
  // -------------------------------------------------------------------------

  listDevices(): Promise<readonly DeviceInfo[]> {
    return this.deps.lifecycle.listDevices();
  }

  snapshotAccessibilityTree(udid: string): Promise<A11ySnapshot> {
    return this.deps.driving.snapshotAccessibilityTree(udid);
  }

  screenshot(udid: string): Promise<ScreenshotBytes> {
    return this.deps.driving.screenshot(udid);
  }

  tap(udid: string, target: TapTarget): Promise<void> {
    return this.deps.driving.tap(udid, target);
  }

  typeText(udid: string, text: string): Promise<void> {
    return this.deps.driving.typeText(udid, text);
  }

  swipe(udid: string, direction: SwipeDirection, distance?: number): Promise<void> {
    return this.deps.driving.swipe(udid, direction, distance);
  }

  // -------------------------------------------------------------------------
  // SimulatorLifecycle — lifecycle + snapshot surface
  // -------------------------------------------------------------------------

  bootSimulator(udid: string): Promise<void> {
    return this.deps.lifecycle.bootSimulator(udid);
  }

  installApp(udid: string, appBundlePath: string): Promise<void> {
    return this.deps.lifecycle.installApp(udid, appBundlePath);
  }

  launchApp(udid: string, bundleId: string): Promise<void> {
    return this.deps.lifecycle.launchApp(udid, bundleId);
  }

  takeSnapshot(udid: string, snapshotName: string): Promise<void> {
    return this.deps.snapshot.takeSnapshot(udid, snapshotName);
  }

  resetToSnapshot(udid: string, snapshotName: string): Promise<void> {
    return this.deps.snapshot.resetToSnapshot(udid, snapshotName);
  }

  shutdownSimulator(udid: string): Promise<void> {
    return this.deps.lifecycle.shutdownSimulator(udid);
  }
}
