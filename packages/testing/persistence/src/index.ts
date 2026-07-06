/**
 * @flowscout/testing-persistence — public API barrel.
 *
 * Shared port-conformance suite for the persistence repository ports (ADR-0008 §7).
 * Neutral test-support package: depends on @flowscout/domain ONLY (layering — must
 * not live under packages/adapters/**). Consumed as a devDependency by both the
 * durable SQLite adapter and the application in-memory reference implementations.
 */
export {
  runRunRepositoryContract,
  type RunRepositoryContractOptions,
} from "./runRunRepositoryContract.js";
export {
  runStateGraphRepositoryContract,
  type StateGraphRepositoryContractOptions,
} from "./runStateGraphRepositoryContract.js";
export {
  runReportRepositoryContract,
  type ReportRepositoryContractOptions,
} from "./runReportRepositoryContract.js";
export {
  runPersistenceContractSuite,
  type PersistenceContractSuiteOptions,
} from "./runPersistenceContractSuite.js";
export {
  defaultRunFixtures,
  defaultGraphFixtures,
  defaultReportFixtures,
  REDACTED_MARKER,
  HOSTILE_MARKUP,
  SQLI_PROBE_ID,
  type RunFixtures,
  type GraphFixtures,
  type ReportFixtures,
} from "./fixtures.js";
