// @ts-check
/**
 * ESLint config for @flowscout/adapter-mobile-mcp.
 * Extends the shared config; excludes test files from type-aware linting.
 */
import { flowscoutEslintConfig } from "@flowscout/config/eslint";

export default [
  { ignores: ["src/__tests__/**"] },
  ...flowscoutEslintConfig,
];
