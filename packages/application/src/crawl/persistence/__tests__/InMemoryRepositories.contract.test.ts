/**
 * In-memory reference implementations vs the shared port-conformance suite
 * (E7.1 / #83, ADR-0008 §7).
 *
 * No `reopen` is supplied: in-memory impls are process-scoped by design, so the
 * durability (NFR1) section is skipped — it runs against the SQLite adapter only.
 */
import {
  runPersistenceContractSuite,
  defaultRunFixtures,
  defaultGraphFixtures,
  defaultReportFixtures,
} from "@flowscout/testing-persistence";
import { InMemoryRunRepository } from "../InMemoryRunRepository.js";
import { InMemoryReportRepository } from "../InMemoryReportRepository.js";
import { InMemoryStateGraphRepository } from "../InMemoryStateGraphRepository.js";

runPersistenceContractSuite({
  run: {
    createRepository: () => new InMemoryRunRepository(),
    fixtures: defaultRunFixtures,
  },
  graph: {
    createRepository: () => new InMemoryStateGraphRepository(),
    fixtures: defaultGraphFixtures,
  },
  report: {
    createRepository: () => new InMemoryReportRepository(),
    fixtures: defaultReportFixtures,
  },
});
