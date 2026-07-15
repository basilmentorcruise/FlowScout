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

// The deprecated Prisma* throwing stubs were DELETED by #84 (E7.2) — the
// composition root now constructs the Sqlite* repositories above (ADR-0008).
