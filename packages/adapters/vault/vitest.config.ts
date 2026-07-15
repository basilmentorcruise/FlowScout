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
        // ADR-0011 §8: packages/adapters/vault gate is ≥90% line + branch.
        thresholds: {
          lines: 90,
          branches: 90,
          functions: 90,
          statements: 90,
        },
      },
    },
  }),
);
