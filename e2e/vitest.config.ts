import { defineConfig, mergeConfig } from "vitest/config";
import { baseVitestConfig } from "@flowscout/config/vitest";

export default mergeConfig(
  baseVitestConfig,
  defineConfig({
    test: {
      // Only Layer A orchestration tests run in the normal test suite.
      // The .e2e.ts script (Layer B) is run by the separate macOS workflow.
      include: ["**/*.orchestration.test.ts"],
      coverage: {
        include: ["round-trip.ts"],
        exclude: [
          // Layer B script: real I/O + macOS-only; covered by the macOS CI job.
          "round-trip.e2e.ts",
          // Test files themselves
          "**/*.test.ts",
        ],
      },
    },
  }),
);
