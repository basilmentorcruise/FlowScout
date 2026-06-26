/**
 * @flowscout/application test-support — deterministic test doubles.
 *
 * Test-only utilities. NOT re-exported from the application barrel (`src/index.ts`) —
 * production code must never depend on these. Imported directly by `__tests__` suites and,
 * later, by cross-package integration tests at the composition root.
 */
export { FakeLlmPort } from "./FakeLlmPort.js";
export type { FakeLlmResponse, FakeLlmCall } from "./FakeLlmPort.js";
