/**
 * @flowscout/adapter-mobile-mcp/testing — public test-support API.
 *
 * Exports:
 *   FakeMobileDriver        — deterministic in-memory driver for engine/unit tests.
 *   FAKE_CONTRACT_FIXTURES  — pre-built ContractFixtures for FakeMobileDriver;
 *                             pass to runDriverContractSuite when testing the Fake.
 *   runDriverContractSuite  — full-driver aggregator (thin wrapper); the Fake's existing
 *                             call site continues to use this unchanged.
 *   runLifecycleContract    — per-capability section runner for #14 (ADR-0003).
 *   runDrivingContract      — per-capability section runner for #15 (ADR-0003).
 *   runSnapshotContract     — per-capability section runner for #16 (ADR-0003).
 *   Error types             — for asserting the specific error class in tests.
 *
 * Tickets that consume this:
 *   #14 — lifecycle.contract.test.ts  imports runLifecycleContract
 *   #15 — driving.contract.test.ts    imports runDrivingContract
 *   #16 — snapshot.contract.test.ts   imports runSnapshotContract
 *   E2  — crawl engine unit tests     import FakeMobileDriver
 *   Fake — fake-driver.contract.test.ts imports runDriverContractSuite + FAKE_CONTRACT_FIXTURES
 */

export { FakeMobileDriver, DEFAULT_FAKE_UDID } from "./FakeMobileDriver.js";
export type { RecordedAction } from "./FakeMobileDriver.js";
export {
  FakeDriverError,
  UnknownDeviceError,
  SnapshotNotFoundError,
  InvalidInputError,
} from "./FakeMobileDriver.js";

export {
  runDriverContractSuite,
  runLifecycleContract,
  runDrivingContract,
  runSnapshotContract,
} from "./driver-contract.js";
export type {
  // Combined (aggregator / Fake) types — backward compatible
  FullDriver,
  DriverFactory,
  ContractFixtures,
  ContractErrorClasses,
  DriverContractSuiteOptions,
  ErrorConstructor,
  // Per-capability partial types (ADR-0003 §1.1)
  SimulatorLifecyclePartial,
  MobileDriverDrivingPartial,
  SnapshotPartial,
  // Per-capability factory types
  LifecycleFactory,
  DrivingFactory,
  SnapshotFactory,
  // Per-capability fixture types
  LifecycleFixtures,
  DrivingFixtures,
  SnapshotFixtures,
  // Per-capability error-class bundles
  LifecycleErrorClasses,
  DrivingErrorClasses,
  SnapshotErrorClasses,
} from "./driver-contract.js";

// ---------------------------------------------------------------------------
// FAKE_CONTRACT_FIXTURES — ready-made fixtures for FakeMobileDriver
//
// Wave-1 tickets (#14-#16) import this and supply it to runDriverContractSuite
// when they want to run the shared suite against the Fake for comparison, OR
// they supply their own adapter-specific fixtures for the real adapter.
// ---------------------------------------------------------------------------

import {
  UnknownDeviceError as _UnknownDeviceError,
  SnapshotNotFoundError as _SnapshotNotFoundError,
  InvalidInputError as _InvalidInputError,
  DEFAULT_FAKE_UDID as _DEFAULT_FAKE_UDID,
} from "./FakeMobileDriver.js";
import type { ContractFixtures as _ContractFixtures } from "./driver-contract.js";

/**
 * Pre-built ContractFixtures for FakeMobileDriver.
 *
 * Usage:
 * ```ts
 * import { runDriverContractSuite, FAKE_CONTRACT_FIXTURES, FakeMobileDriver }
 *   from '@flowscout/adapter-mobile-mcp/testing';
 *
 * runDriverContractSuite({
 *   createDriver: () => new FakeMobileDriver(),
 *   fixtures: FAKE_CONTRACT_FIXTURES,
 * });
 * ```
 */
export const FAKE_CONTRACT_FIXTURES: _ContractFixtures = {
  validUdid: _DEFAULT_FAKE_UDID,
  validBundleId: "com.example.flowscout.fixture",
  installablePath: "/fake/builds/Fixture.app",
  knownSnapshotName: "clean-state",
  knownSnapshotName2: "after-login",
  unknownUdid: "00000000-0000-0000-0000-FFFFFFFFFFFF",
  errorClasses: {
    unknownDevice: _UnknownDeviceError,
    invalidInput: _InvalidInputError,
    snapshotNotFound: _SnapshotNotFoundError,
  },
};
