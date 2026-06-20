// @ts-check
/**
 * Application package ESLint config.
 * Extends the shared config and excludes test files from type-aware linting
 * because the test-support directory is outside `rootDir: src` in tsconfig.json.
 * Test files are covered by vitest type-checking at test runtime.
 */
import { flowscoutEslintConfig } from "@flowscout/config/eslint";

export default [
  // Ignore test directories — they import from test-support/ which is outside rootDir
  { ignores: ["src/__tests__/**"] },
  ...flowscoutEslintConfig,
];
