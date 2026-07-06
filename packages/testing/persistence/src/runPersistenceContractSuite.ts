/**
 * Aggregator: runs all three per-port conformance sections (ADR-0008 §7).
 */
import {
  runRunRepositoryContract,
  type RunRepositoryContractOptions,
} from "./runRunRepositoryContract.js";
import {
  runStateGraphRepositoryContract,
  type StateGraphRepositoryContractOptions,
} from "./runStateGraphRepositoryContract.js";
import {
  runReportRepositoryContract,
  type ReportRepositoryContractOptions,
} from "./runReportRepositoryContract.js";

export interface PersistenceContractSuiteOptions {
  run: RunRepositoryContractOptions;
  graph: StateGraphRepositoryContractOptions;
  report: ReportRepositoryContractOptions;
}

export function runPersistenceContractSuite(options: PersistenceContractSuiteOptions): void {
  runRunRepositoryContract(options.run);
  runStateGraphRepositoryContract(options.graph);
  runReportRepositoryContract(options.report);
}
