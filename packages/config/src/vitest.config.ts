import { defineConfig } from "vitest/config";

/**
 * Base Vitest configuration for FlowScout packages.
 * Each package extends this with its own include paths.
 * Coverage gate: ≥80% line AND branch on domain + application (ADR-0001 §6).
 */
export const baseVitestConfig = defineConfig({
  test: {
    globals: true,
    environment: "node",
    passWithNoTests: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json"],
      // These thresholds apply per-package; domain+application gate is enforced in CI
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/*.d.ts",
        "**/*.config.*",
        "**/index.ts", // re-export barrels
      ],
    },
  },
});

export default baseVitestConfig;
