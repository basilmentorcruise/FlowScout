/**
 * Layer B — gated macOS real-simulator E2E script (E1.7 #18, plan §3.2).
 *
 * Run via: pnpm run e2e:round-trip  (from repo root)
 * Requires (for a real run):
 *   - macOS with Xcode / xcrun installed.
 *   - FLOWSCOUT_FIXTURE_APP: path to a .app bundle inside FLOWSCOUT_APP_BUNDLE_DIR.
 *   - FLOWSCOUT_FIXTURE_BUNDLE_ID: bundle identifier of the fixture app.
 *   - FLOWSCOUT_APP_BUNDLE_DIR: base dir containing the .app (confinement root, T2).
 *   - A booted iOS simulator UDID (env: FLOWSCOUT_E2E_SIM_UDID)
 *     or the first booted sim from `xcrun simctl list devices booted`.
 *
 * SKIP behaviour (plan §3.2):
 *   If FLOWSCOUT_FIXTURE_APP is unset, print a clear skip message and exit 0.
 *   NEVER silent pass; NEVER red build for a missing optional fixture.
 *
 * No-orphan assertion (plan §3.3, T8):
 *   Captures the set of booted sim UDIDs before the run.
 *   After teardown, asserts the set returned to baseline (no orphaned sims).
 *
 * Security:
 *   T4: Artifacts → .flowscout-e2e-artifacts/ (gitignored, chmod 700).
 *   T5: No full env or config object is logged.
 *   T7: mobile-mcp uses stdio transport (loopback by default; no routable port exposed).
 *   T8: try/finally teardown in roundTrip() ensures sim is shut down on failure.
 *   T9: Fixture .app MUST be secret/PII-free; documented below.
 *
 * How to run locally (macOS only):
 *   1. Boot a simulator: xcrun simctl boot <UDID>
 *   2. export FLOWSCOUT_FIXTURE_APP=... FLOWSCOUT_FIXTURE_BUNDLE_ID=...
 *   3. pnpm run e2e:round-trip
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { loadMobileMcpConfig } from "../packages/api/src/config/index.js";
import { MobileMcpDriver } from "../packages/adapters/mobile-mcp/src/index.js";
import { roundTrip } from "./round-trip.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of consecutive iterations required by the success metric (plan §3.3). */
const REQUIRED_ITERATIONS = 3;

/**
 * Artifacts directory: gitignored, chmod 700 (T4 — non-world-readable).
 * Screenshots land here; never committed to the repo.
 */
const ARTIFACTS_DIR = path.resolve(process.cwd(), ".flowscout-e2e-artifacts");

// ---------------------------------------------------------------------------
// Fixture config type
// ---------------------------------------------------------------------------

interface FixtureConfig {
  readonly fixtureApp: string;
  readonly fixtureBundleId: string;
}

// ---------------------------------------------------------------------------
// resolveFixtureConfig — skip guard (§3.2)
// ---------------------------------------------------------------------------

/**
 * Returns null (skip) if FLOWSCOUT_FIXTURE_APP is unset; throws on partial config.
 * Caller prints the skip message and exits 0.
 */
function resolveFixtureConfig(): FixtureConfig | null {
  const rawApp = process.env["FLOWSCOUT_FIXTURE_APP"];
  const rawBundleId = process.env["FLOWSCOUT_FIXTURE_BUNDLE_ID"];
  if (!rawApp || rawApp.trim() === "") return null;
  if (!rawBundleId || rawBundleId.trim() === "") {
    console.error(
      "[FlowScout E2E] ERROR: FLOWSCOUT_FIXTURE_BUNDLE_ID is required when FLOWSCOUT_FIXTURE_APP is set.",
    );
    process.exit(1);
  }
  return { fixtureApp: rawApp.trim(), fixtureBundleId: rawBundleId.trim() };
}

// ---------------------------------------------------------------------------
// runRealRoundTrip — drives real simulator with no-orphan assertion
// ---------------------------------------------------------------------------

/**
 * Execute the round-trip against the real driver and assert no orphaned sims.
 * Extracted from main() to satisfy the max-lines-per-function gate.
 */
async function runRealRoundTrip(fixture: FixtureConfig): Promise<void> {
  ensureArtifactsDir(ARTIFACTS_DIR);
  console.log(`[FlowScout E2E] Artifacts dir: ${ARTIFACTS_DIR}`);

  const { driverConfig } = loadMobileMcpConfig();
  // T5: log only command name + timeouts, not the full config object.
  console.log(
    `[FlowScout E2E] MCP command: ${String(driverConfig.server.serverCommand[0])} ` +
      `(connect=${String(driverConfig.server.connectTimeoutMs)}ms, ` +
      `call=${String(driverConfig.server.callTimeoutMs)}ms)`,
  );

  const udid = resolveSimulatorUdid();
  console.log(`[FlowScout E2E] Using simulator UDID: ${udid}`);

  const preRunBootedSims = getBootedSimUdids();
  console.log(`[FlowScout E2E] Pre-run booted sims: ${preRunBootedSims.join(", ") || "(none)"}`);

  // SWAP POINT: change MobileMcpDriver to a different driver implementation here.
  const driver = new MobileMcpDriver(driverConfig);

  try {
    const report = await roundTrip(driver, {
      udid,
      appBundlePath: fixture.fixtureApp,
      bundleId: fixture.fixtureBundleId,
      iterations: REQUIRED_ITERATIONS,
      maxReadinessAttempts: 15,
      readinessPollIntervalMs: 2000,
      artifactsDir: ARTIFACTS_DIR,
    });
    console.log(
      `[FlowScout E2E] Report: ${String(report.totalIterations)} iterations, ` +
        `allSucceeded=${String(report.allSucceeded)}, teardownCalled=${String(report.teardownCalled)}`,
    );
    if (!report.allSucceeded) throw new Error("[FlowScout E2E] One or more iterations failed.");
    if (!report.teardownCalled) throw new Error("[FlowScout E2E] Teardown not called — bug.");
  } finally {
    assertNoOrphanedSims(preRunBootedSims);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const fixture = resolveFixtureConfig();
  if (fixture === null) {
    console.log(
      "[FlowScout E2E] SKIP: FLOWSCOUT_FIXTURE_APP is not set.\n" +
        "  To run the real macOS round-trip, set:\n" +
        "    FLOWSCOUT_FIXTURE_APP=/path/to/MyApp.app (inside FLOWSCOUT_APP_BUNDLE_DIR)\n" +
        "    FLOWSCOUT_FIXTURE_BUNDLE_ID=com.example.myapp\n" +
        "    FLOWSCOUT_APP_BUNDLE_DIR=/path/to/builds\n" +
        "  Fixture .app MUST be secret/PII-free (T9). Building it is OQ3 (issue #18).",
    );
    return;
  }

  console.log("[FlowScout E2E] Starting Layer B real-simulator round-trip.");
  console.log(`[FlowScout E2E] Iterations: ${String(REQUIRED_ITERATIONS)}`);
  console.log(`[FlowScout E2E] Fixture: ${fixture.fixtureApp}`);
  console.log(`[FlowScout E2E] Bundle ID: ${fixture.fixtureBundleId}`);

  await runRealRoundTrip(fixture);

  console.log("[FlowScout E2E] Round-trip E2E PASSED.");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Ensure artifacts dir exists with chmod 700 (T4 — non-world-readable).
 * Gitignored: .flowscout-e2e-artifacts/
 */
function ensureArtifactsDir(dir: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (!fs.existsSync(dir)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fs.chmodSync(dir, 0o700);
  }
}

/**
 * Resolve simulator UDID.
 * Precedence: FLOWSCOUT_E2E_SIM_UDID env → first booted sim from simctl.
 */
function resolveSimulatorUdid(): string {
  const envUdid = process.env["FLOWSCOUT_E2E_SIM_UDID"];
  if (envUdid && envUdid.trim() !== "") return envUdid.trim();
  const bootedSims = getBootedSimUdids();
  if (bootedSims.length === 0) {
    throw new Error(
      "[FlowScout E2E] No booted simulator found. " +
        "Boot one with: xcrun simctl boot <UDID>  or  set FLOWSCOUT_E2E_SIM_UDID.",
    );
  }
  const firstUdid = bootedSims[0];
  if (firstUdid === undefined) throw new Error("[FlowScout E2E] Unexpected empty sim list.");
  return firstUdid;
}

/**
 * Assert no new booted sims remain after teardown (T8, plan §3.3).
 * Throws if orphaned sims are detected.
 */
function assertNoOrphanedSims(preRunBootedSims: readonly string[]): void {
  const postRunBootedSims = getBootedSimUdids();
  const orphanedSims = postRunBootedSims.filter((u) => !preRunBootedSims.includes(u));
  if (orphanedSims.length > 0) {
    console.error(
      `[FlowScout E2E] ORPHAN WARNING: ${String(orphanedSims.length)} new booted sim(s): ` +
        orphanedSims.join(", "),
    );
    throw new Error(`E2E no-orphan assertion failed: ${orphanedSims.join(", ")}`);
  }
  console.log("[FlowScout E2E] No-orphan assertion passed.");
}

/**
 * Return UDIDs of all currently booted simulators via xcrun simctl.
 * Returns [] when simctl is unavailable (ubuntu CI, non-macOS).
 */
function getBootedSimUdids(): string[] {
  try {
    const output = childProcess.execFileSync(
      "xcrun",
      ["simctl", "list", "devices", "booted", "--json"],
      { encoding: "utf8", timeout: 10_000 },
    );
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== "object") return [];
    const devicesMap = (parsed as { devices?: Record<string, unknown> }).devices;
    if (!devicesMap) return [];
    const udids: string[] = [];
    for (const runtimeDevices of Object.values(devicesMap)) {
      if (!Array.isArray(runtimeDevices)) continue;
      for (const device of runtimeDevices as Array<Record<string, unknown>>) {
        const udid = device["udid"];
        if (typeof udid === "string") udids.push(udid);
      }
    }
    return udids;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err: unknown) => {
  console.error("[FlowScout E2E] FAILED:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
