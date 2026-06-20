/**
 * Capability interfaces + default stub implementations (ADR-0002 §2.3).
 *
 * #12 OWNS AND FREEZES THIS FILE.
 * Wave-1 tickets (#14, #15, #16, #17) replace the stub index.ts + class in their
 * own subtrees (`src/lifecycle/`, `src/driving/`, `src/snapshot/`, `src/health/`).
 * They NEVER edit this file.
 *
 * The three capability interfaces define the internal seam between the facade
 * and the capability modules. They are adapter-private — not domain ports.
 * `defaultCapabilities()` wires real classes when they land; for now it wires stubs.
 */

import type { DeviceInfo, A11ySnapshot, ScreenshotBytes, TapTarget, SwipeDirection } from "@flowscout/domain";
import type { McpServerConfig } from "./connection-config.js";
import { McpConnection } from "./McpConnection.js";
import { createDefaultExec, type Exec } from "../simctl.js";
import { LifecycleStub } from "../lifecycle/index.js";
import { DrivingStub } from "../driving/index.js";
import { SnapshotStub } from "../snapshot/index.js";
import { HealthStub } from "../health/index.js";

// ---------------------------------------------------------------------------
// Capability interfaces — the contract between the facade and each module
// ---------------------------------------------------------------------------

/** Simulator lifecycle: device enumeration, boot, install, launch, shutdown. */
export interface LifecycleCapability {
  listDevices(): Promise<readonly DeviceInfo[]>;
  bootSimulator(udid: string): Promise<void>;
  installApp(udid: string, appBundlePath: string): Promise<void>;
  launchApp(udid: string, bundleId: string): Promise<void>;
  shutdownSimulator(udid: string): Promise<void>;
}

/** Device driving: accessibility snapshots, screenshots, tap, type, swipe. */
export interface DrivingCapability {
  snapshotAccessibilityTree(udid: string): Promise<A11ySnapshot>;
  screenshot(udid: string): Promise<ScreenshotBytes>;
  tap(udid: string, target: TapTarget): Promise<void>;
  typeText(udid: string, text: string): Promise<void>;
  swipe(udid: string, direction: SwipeDirection, distance?: number): Promise<void>;
}

/** Snapshot / reset: take a simulator state snapshot and restore it. */
export interface SnapshotCapability {
  takeSnapshot(udid: string, snapshotName: string): Promise<void>;
  resetToSnapshot(udid: string, snapshotName: string): Promise<void>;
}

/** Health / readiness result type (adapter-local, not a domain type per ADR-0002 §5/#17). */
export interface ReadinessResult {
  readonly mcpReachable: boolean;
  readonly wdaUp: boolean;
  readonly appLaunched: boolean | null;
}

/** Health / readiness checks. */
export interface HealthCapability {
  checkReadiness(udid?: string): Promise<ReadinessResult>;
}

// ---------------------------------------------------------------------------
// Capability bundle — what the facade receives at construction
// ---------------------------------------------------------------------------

export interface CapabilityBundle {
  readonly lifecycle: LifecycleCapability;
  readonly driving: DrivingCapability;
  readonly snapshot: SnapshotCapability;
  readonly health: HealthCapability;
}

// ---------------------------------------------------------------------------
// Default factory — wires stubs until Wave-1 tickets replace them
// ---------------------------------------------------------------------------

/**
 * Construct the default capability bundle from the server config.
 *
 * A single shared `McpConnection` is constructed from the config and injected
 * into every capability so that all four share one transport session (one spawn,
 * one handshake).  The injectable `exec` seam lets Wave-1 tickets and tests
 * supply a fake executor without touching this file.
 *
 * Wiring layout:
 * - lifecycle  → connection + config + exec  (#14 needs simctl + MCP)
 * - driving    → connection + config         (#15 needs MCP only)
 * - snapshot   → connection + config + exec  (#16 needs simctl + MCP)
 * - health     → connection + config         (#17 needs MCP only)
 *
 * This function is written ONCE by #12 and NEVER edited by Wave-1 tickets.
 * Wave-1 tickets replace ONLY their own `src/<capability>/index.ts`.
 *
 * @param config - server config (command, env, timeouts)
 * @param exec   - injectable xcrun executor; defaults to the real execFile wrapper (T1)
 */
export function defaultCapabilities(
  config: McpServerConfig,
  exec: Exec = createDefaultExec(),
): CapabilityBundle {
  // One shared connection for the entire driver lifetime.
  // Wave-1 classes call connection.connect() lazily before their first tool call.
  const connection = new McpConnection(config);

  return {
    lifecycle: new LifecycleStub(connection, config, exec),
    driving: new DrivingStub(connection, config),
    snapshot: new SnapshotStub(connection, config, exec),
    health: new HealthStub(connection, config),
  };
}
