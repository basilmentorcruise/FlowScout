/**
 * @flowscout/adapter-persistence — public API barrel.
 *
 * Durable run store (E7.1 / #83, ADR-0008): embedded SQLite via better-sqlite3.
 * The composition root opens ONE handle via `openDatabase` and injects it into
 * the three Sqlite* repositories (one connection per process — DI).
 */
export {
  openDatabase,
  resolveDatabasePath,
  FLOWSCOUT_DB_PATH_ENV,
  DEFAULT_DB_PATH,
  type SqliteDatabase,
} from "./sqlite/Database.js";
export { SqliteRunRepository } from "./sqlite/SqliteRunRepository.js";
export { SqliteStateGraphRepository } from "./sqlite/SqliteStateGraphRepository.js";
export { SqliteReportRepository } from "./sqlite/SqliteReportRepository.js";
export { UnredactedSecretError } from "./sqlite/redactionGuard.js";
export { PayloadCodecError } from "./sqlite/codec/primitives.js";

// DEPRECATED throwing stubs — still constructed by the composition root
// (`packages/api/src/composition-root/wire.ts`, frozen for this ticket).
// #84 (E7.2) owns the wire.ts swap to the Sqlite* repositories and removes these.
export {
  PrismaRunRepository,
  PrismaStateGraphRepository,
  PrismaReportRepository,
} from "./PersistenceAdapters.js";
