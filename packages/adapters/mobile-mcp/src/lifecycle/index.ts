/**
 * lifecycle/index.ts — stub for the lifecycle capability module.
 *
 * #12 OWNS THIS FILE as a NotImplemented stub.
 * #14 (E1.3 — Simulator lifecycle) REPLACES this file entirely with
 * the real SimulatorLifecycleManager implementation.
 *
 * Do NOT add logic here — stub only.
 */

import type { LifecycleCapability } from "../connection/capabilities.js";
import type { DeviceInfo } from "@flowscout/domain";

function notImplemented(method: string): Promise<never> {
  return Promise.reject(
    new Error(`LifecycleCapability.${method} is not yet implemented — see ticket #14 (E1.3).`),
  );
}

/** Stub implementation — all methods throw NotImplemented. */
export class LifecycleStub implements LifecycleCapability {
  listDevices(): Promise<readonly DeviceInfo[]> {
    return notImplemented("listDevices");
  }

  bootSimulator(_udid: string): Promise<void> {
    return notImplemented("bootSimulator");
  }

  installApp(_udid: string, _appBundlePath: string): Promise<void> {
    return notImplemented("installApp");
  }

  launchApp(_udid: string, _bundleId: string): Promise<void> {
    return notImplemented("launchApp");
  }

  shutdownSimulator(_udid: string): Promise<void> {
    return notImplemented("shutdownSimulator");
  }
}
