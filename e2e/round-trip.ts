/**
 * round-trip.ts — pure orchestration function for the E1.7 (#18) round-trip exercise.
 *
 * Design (E1.7-composition-e2e-plan §3.1):
 *   - `roundTrip(driver, opts)` is a pure orchestration function: it takes a
 *     driver instance and options and returns a RoundTripReport.
 *   - It does NOT import concrete adapters — the caller (Layer A test or Layer B script)
 *     supplies the driver, which can be FakeMobileDriver or MobileMcpDriver.
 *   - Step sequence: boot → readiness-poll → install → launch → snapshot →
 *     tap → screenshot + a11y → reset → (repeat N times from clean state).
 *   - teardown in try/finally: shutdownSimulator runs even on assertion failure (T8).
 *
 * Readiness strategy (§3.4 — readiness not on the public port):
 *   Poll snapshotAccessibilityTree until it succeeds or pollAttempts are exhausted.
 *   This is portable across FakeMobileDriver (instant success) and MobileMcpDriver
 *   (waits for WDA/app ready), with no surface change to the ports.
 *
 * Security:
 *   - Artifacts (screenshots) are written to the caller-supplied artifactsDir,
 *     which MUST be gitignored and chmod 700 (T4 — see Layer B harness).
 *   - No secrets, full env, or full config are logged (T5).
 *   - appBundlePath is an operation argument, not driver construction config (§2.3).
 */

import type { MobileDriverPort, SimulatorLifecycle } from "@flowscout/domain";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single iteration result within the round-trip. */
export interface IterationResult {
  readonly iteration: number;
  readonly bootedAt: Date;
  readonly snapshotName: string;
  readonly tapSucceeded: boolean;
  readonly screenshotByteLength: number;
  readonly a11yLength: number;
  readonly resetSucceeded: boolean;
}

/** Overall result returned by roundTrip(). */
export interface RoundTripReport {
  readonly iterations: readonly IterationResult[];
  readonly totalIterations: number;
  readonly allSucceeded: boolean;
  readonly teardownCalled: boolean;
}

/** Options for roundTrip(). */
export interface RoundTripOptions {
  /** UDID of the simulator to use. */
  readonly udid: string;
  /** Path to the fixture .app bundle (must be inside FLOWSCOUT_APP_BUNDLE_DIR). */
  readonly appBundlePath: string;
  /** Bundle ID of the fixture app. */
  readonly bundleId: string;
  /** Number of iterations (must be ≥ 1; the plan requires ≥ 3 for real runs). */
  readonly iterations: number;
  /**
   * Maximum number of readiness poll attempts before giving up.
   * Each attempt calls snapshotAccessibilityTree; FakeMobileDriver succeeds instantly.
   * Default: 1 (Layer A / Fake). Layer B typically sets this to 10+.
   */
  readonly maxReadinessAttempts?: number;
  /**
   * Delay (ms) between readiness poll attempts.
   * Default: 0 (immediate, for unit tests). Layer B sets this to 2000+.
   */
  readonly readinessPollIntervalMs?: number;
  /**
   * Directory where artifacts (screenshots) are written.
   * Must exist and be chmod 700 before calling (Layer B responsibility — T4).
   * If undefined, artifacts are not written to disk (Layer A / unit mode).
   */
  readonly artifactsDir?: string;
  /**
   * Snapshot name prefix. Full name: `${prefix}-iter-${n}`.
   * Default: "clean-state".
   */
  readonly snapshotPrefix?: string;
}

// ---------------------------------------------------------------------------
// Core orchestration
// ---------------------------------------------------------------------------

/**
 * Run the E1.7 round-trip exercise N times against the supplied driver.
 *
 * Layer A: called with FakeMobileDriver + iterations≥3, artifactsDir undefined.
 * Layer B: called with MobileMcpDriver + iterations≥3, artifactsDir set to a
 *          gitignored chmod-700 dir (T4).
 *
 * Returns a RoundTripReport. Throws on unrecoverable errors (after teardown runs).
 */
export async function roundTrip(
  driver: MobileDriverPort & SimulatorLifecycle,
  opts: RoundTripOptions,
): Promise<RoundTripReport> {
  const {
    udid,
    appBundlePath,
    bundleId,
    iterations,
    maxReadinessAttempts = 1,
    readinessPollIntervalMs = 0,
    artifactsDir,
    snapshotPrefix = "clean-state",
  } = opts;

  const results: IterationResult[] = [];
  let teardownCalled = false;

  try {
    for (let i = 1; i <= iterations; i++) {
      const iterResult = await runIteration(driver, {
        udid,
        appBundlePath,
        bundleId,
        iteration: i,
        maxReadinessAttempts,
        readinessPollIntervalMs,
        artifactsDir,
        snapshotPrefix,
      });
      results.push(iterResult);
    }
  } finally {
    // T8: teardown in finally — runs even on assertion failure.
    // Shutdown the simulator regardless of success/failure.
    teardownCalled = true;
    try {
      await driver.shutdownSimulator(udid);
    } catch {
      // Teardown errors are not re-thrown — we want the original error to propagate.
      // Caller's Layer B harness asserts no orphaned sims post-teardown.
    }
  }

  const allSucceeded = results.every((r) => r.tapSucceeded && r.resetSucceeded);
  return {
    iterations: results,
    totalIterations: results.length,
    allSucceeded,
    teardownCalled,
  };
}

// ---------------------------------------------------------------------------
// Single iteration
// ---------------------------------------------------------------------------

interface IterationOpts {
  udid: string;
  appBundlePath: string;
  bundleId: string;
  iteration: number;
  maxReadinessAttempts: number;
  readinessPollIntervalMs: number;
  artifactsDir: string | undefined;
  snapshotPrefix: string;
}

async function runIteration(
  driver: MobileDriverPort & SimulatorLifecycle,
  opts: IterationOpts,
): Promise<IterationResult> {
  const {
    udid,
    appBundlePath,
    bundleId,
    iteration,
    maxReadinessAttempts,
    readinessPollIntervalMs,
    artifactsDir,
    snapshotPrefix,
  } = opts;

  const snapshotName = `${snapshotPrefix}-iter-${String(iteration)}`;

  // Step 1: Boot simulator
  const bootedAt = new Date();
  await driver.bootSimulator(udid);

  // Step 2: Readiness poll — bounded retry of snapshotAccessibilityTree (§3.4)
  await pollReadiness(driver, udid, maxReadinessAttempts, readinessPollIntervalMs);

  // Step 3: Install and launch the fixture app
  await driver.installApp(udid, appBundlePath);
  await driver.launchApp(udid, bundleId);

  // Step 4: Take a clean-state snapshot (so reset can return to this state)
  await driver.takeSnapshot(udid, snapshotName);

  // Step 5: Tap (simulates a UI interaction)
  await driver.tap(udid, { kind: "coordinate", x: 0, y: 0 });
  const tapSucceeded = true;

  // Step 6: Screenshot + a11y snapshot (verify driving works post-tap)
  const screenshotBytes = await driver.screenshot(udid);
  const a11ySnapshot = await driver.snapshotAccessibilityTree(udid);

  // Write artifact if artifactsDir is provided (Layer B only — T4)
  if (artifactsDir !== undefined) {
    const screenshotPath = path.join(artifactsDir, `screenshot-iter-${String(iteration)}.png`);
    fs.writeFileSync(screenshotPath, Buffer.from(screenshotBytes));
  }

  // Step 7: Reset to the clean snapshot
  await driver.resetToSnapshot(udid, snapshotName);
  const resetSucceeded = true;

  return {
    iteration,
    bootedAt,
    snapshotName,
    tapSucceeded,
    screenshotByteLength: screenshotBytes.byteLength,
    a11yLength: a11ySnapshot.length,
    resetSucceeded,
  };
}

// ---------------------------------------------------------------------------
// Readiness polling (§3.1 / §3.4 — portable across Layer A and B)
// ---------------------------------------------------------------------------

/**
 * Poll readiness by calling snapshotAccessibilityTree until it succeeds or
 * maxAttempts are exhausted. Throws ReadinessTimeoutError on exhaustion.
 *
 * FakeMobileDriver: succeeds on attempt 1 (no delay needed in Layer A tests).
 * MobileMcpDriver: retries until WDA is ready or timeout, then throws.
 */
async function pollReadiness(
  driver: MobileDriverPort,
  udid: string,
  maxAttempts: number,
  pollIntervalMs: number,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await driver.snapshotAccessibilityTree(udid);
      return; // Success — driver is ready
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts && pollIntervalMs > 0) {
        await sleep(pollIntervalMs);
      }
    }
  }
  throw new ReadinessTimeoutError(
    `Driver not ready after ${String(maxAttempts)} attempt(s); udid=${udid}`,
    lastError,
  );
}

/** Async sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when readiness polling exhausts all attempts. */
export class ReadinessTimeoutError extends Error {
  /** The last error from the readiness poll attempt. */
  public readonly underlyingCause: unknown;

  constructor(message: string, underlyingCause?: unknown) {
    super(message);
    this.name = "ReadinessTimeoutError";
    this.underlyingCause = underlyingCause;
  }
}
