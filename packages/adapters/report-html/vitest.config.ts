import { defineConfig, mergeConfig } from "vitest/config";
import { baseVitestConfig } from "@flowscout/config/vitest";

export default mergeConfig(
  baseVitestConfig,
  defineConfig({
    test: {
      include: ["src/**/__tests__/**/*.test.ts"],
      coverage: {
        include: ["src/**/*.ts"],
        exclude: ["src/**/__tests__/**", "src/**/index.ts", "src/**/*.d.ts"],
        // Coverage gate for this package (e4-plan.md): ≥85% line + branch.
        thresholds: {
          lines: 85,
          branches: 85,
          functions: 85,
          statements: 85,
        },
      },
    },
  }),
);
