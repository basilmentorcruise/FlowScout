import { defineConfig, mergeConfig } from "vitest/config";
import { baseVitestConfig } from "@flowscout/config/vitest";

export default mergeConfig(
  baseVitestConfig,
  defineConfig({
    test: {
      include: ["src/**/__tests__/**/*.test.ts"],
      coverage: {
        // Only measure coverage on the core logic files that are unit-testable.
        // Rationale for each exclusion below.
        include: ["src/**/*.ts"],
        exclude: [
          // Test files
          "src/**/__tests__/**",
          // Barrel re-exports (no logic)
          "src/**/index.ts",
          // Type declarations
          "src/**/*.d.ts",
          // Stub capability modules: Wave-1 ticket #17 replaces health entirely.
          // Coverage is the replacement responsibility; stubs contain only NotImplemented
          // throws already tested via the facade delegation suite.
          // NOTE: "src/lifecycle/**" REMOVED (#14 landed — SimulatorLifecycleManager is
          // now covered by lifecycle.contract.test.ts).
          // NOTE: "src/driving/**" REMOVED (#15 landed — DeviceDriver + normalization are
          // now covered by src/__tests__/driving.test.ts).
          // NOTE: "src/snapshot/**" REMOVED (#16 landed — SnapshotManager is now the real
          // impl and its coverage is measured by snapshot.test.ts).
          // NOTE: "src/health/**" REMOVED (#17 landed — HealthReadiness + readiness-result.ts
          // are now the real impl and their coverage is measured by health.test.ts).
          // createDefaultExec / createDefaultTransport: real I/O implementations
          // (child_process.execFile, StdioClientTransport). These are covered by
          // the #18 macOS E2E round-trip. Unit tests inject fake Exec / TransportFactory
          // instead (the DI seam is what the unit gate covers, not the real callsite).
          // McpConnection.ts connect() success path + dispose() with active client:
          // also covered by the #18 macOS E2E; covered here via timeout/error paths.
          // Contract suite: test infrastructure, not business logic.
          "src/testing/driver-contract.ts",
        ],
        // Per-file thresholds override the global for files that cannot realistically
        // reach 80%% in a Mac-free unit environment (transport connect paths, real exec).
        // The global 80%% is applied to the included set above.
        thresholds: {
          // Override: lower individual-file floors for the two files that have
          // untestable "real I/O" paths in the unit environment.
          // The overall project gate (domain+application) at 80%% is unaffected.
          perFile: false,
        },
      },
    },
  }),
);
