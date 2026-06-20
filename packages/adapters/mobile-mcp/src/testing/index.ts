/**
 * @flowscout/adapter-mobile-mcp/testing — public test-support API.
 *
 * Exports:
 *   FakeMobileDriver  — deterministic in-memory driver for engine/unit tests.
 *   runDriverContractSuite — parameterised Vitest suite; import + call in any
 *                            adapter test file to assert port conformance.
 *   Error types       — for asserting the specific error class in tests.
 *
 * Tickets that consume this:
 *   #14 — lifecycle.contract.test.ts  imports runDriverContractSuite
 *   #15 — driving.contract.test.ts    imports runDriverContractSuite
 *   #16 — snapshot.contract.test.ts   imports runDriverContractSuite
 *   E2  — crawl engine unit tests     import FakeMobileDriver
 */

export { FakeMobileDriver, DEFAULT_FAKE_UDID } from "./FakeMobileDriver.js";
export type { RecordedAction } from "./FakeMobileDriver.js";
export {
  FakeDriverError,
  UnknownDeviceError,
  SnapshotNotFoundError,
  InvalidInputError,
} from "./FakeMobileDriver.js";

export { runDriverContractSuite } from "./driver-contract.js";
export type { FullDriver, DriverFactory } from "./driver-contract.js";
