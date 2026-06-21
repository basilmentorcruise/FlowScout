import { defineConfig, mergeConfig } from "vitest/config";
import { baseVitestConfig } from "@flowscout/config/vitest";

export default mergeConfig(
  baseVitestConfig,
  defineConfig({
    test: {
      include: ["src/**/__tests__/**/*.test.ts"],
      coverage: {
        include: ["src/**/*.ts"],
        exclude: [
          // Test files
          "src/**/__tests__/**",
          // Barrel re-exports
          "src/**/index.ts",
          // Type declarations
          "src/**/*.d.ts",
          // Composition root: thin DI wiring with no testable logic
          // (logic-free — all parsing lives in config/; tested there)
          "src/composition-root/**",
          // Server entry point: I/O + Fastify startup; covered by E2E
          "src/index.ts",
          // Route handlers: thin transport layer; integration-tested separately
          "src/routes/**",
        ],
      },
    },
  }),
);
