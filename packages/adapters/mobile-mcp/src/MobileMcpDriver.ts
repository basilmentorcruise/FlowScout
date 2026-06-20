/**
 * MobileMcpDriver — adapter implementing MobileDriverPort + SimulatorLifecycle
 * via the mobile-next/mobile-mcp MCP server.
 *
 * THIS IS THE ONLY FILE IN THE ENTIRE MONOREPO THAT MAY IMPORT THE MCP SDK.
 * All imports of @modelcontextprotocol/sdk or mobile-mcp belong here.
 *
 * TODO (E1): Implement using @modelcontextprotocol/sdk client (stdio transport)
 *            to launch and connect to the mobile-mcp server, then map each port
 *            method to the corresponding MCP tool call.
 *
 * Current state: stub — throws NotImplementedError to satisfy the type contract
 * while the foundation scaffold is in place.
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

// TODO (E1): import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// TODO (E1): import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function notImplemented(method: string): Promise<never> {
  return Promise.reject(
    new Error(
      `MobileMcpDriver.${method} is not yet implemented — see TODO (E1) in MobileMcpDriver.ts`,
    ),
  );
}

/**
 * MobileMcpDriver — stub.
 * Wires in the composition root of `packages/api` as the concrete MobileDriverPort.
 */
export class MobileMcpDriver implements MobileDriverPort, SimulatorLifecycle {
  // TODO (E1): constructor should accept MCP server config (path, port, etc.)

  listDevices(): Promise<readonly DeviceInfo[]> {
    return notImplemented("listDevices");
  }

  snapshotAccessibilityTree(_udid: string): Promise<A11ySnapshot> {
    return notImplemented("snapshotAccessibilityTree");
  }

  screenshot(_udid: string): Promise<ScreenshotBytes> {
    return notImplemented("screenshot");
  }

  tap(_udid: string, _target: TapTarget): Promise<void> {
    return notImplemented("tap");
  }

  typeText(_udid: string, _text: string): Promise<void> {
    return notImplemented("typeText");
  }

  swipe(_udid: string, _direction: SwipeDirection, _distance?: number): Promise<void> {
    return notImplemented("swipe");
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

  takeSnapshot(_udid: string, _snapshotName: string): Promise<void> {
    return notImplemented("takeSnapshot");
  }

  resetToSnapshot(_udid: string, _snapshotName: string): Promise<void> {
    return notImplemented("resetToSnapshot");
  }

  shutdownSimulator(_udid: string): Promise<void> {
    return notImplemented("shutdownSimulator");
  }
}
