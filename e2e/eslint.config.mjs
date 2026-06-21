// @ts-check
import { flowscoutEslintConfig } from "@flowscout/config/eslint";

/**
 * ESLint config for the e2e harness.
 * Extends the shared config with relaxed rules for test files.
 */
export default [
  ...flowscoutEslintConfig,
  // Test file overrides: relax structural rules that are impractical in test files.
  {
    files: ["**/*.test.ts", "**/*.orchestration.test.ts"],
    rules: {
      // describe() callbacks typically exceed 60 lines in test suites.
      // The rule guards production functions; tests are exempt.
      "max-lines-per-function": "off",
      // Type assertions like `as never` are idiomatic in TypeScript test mocks.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      // Mock implementations may use async () => {} for interface compatibility.
      "@typescript-eslint/require-await": "off",
    },
  },
];
