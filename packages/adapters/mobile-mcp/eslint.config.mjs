// @ts-check
/**
 * ESLint config for @flowscout/adapter-mobile-mcp.
 * Extends the shared config; excludes test files from type-aware linting.
 * Adds SAST overrides for frozen files that use secure patterns flagged as false positives.
 */
import { flowscoutEslintConfig } from "@flowscout/config/eslint";

export default [
  { ignores: ["src/__tests__/**"] },
  ...flowscoutEslintConfig,
  // SAST override — simctl.ts (frozen, #12):
  //   detect-child-process fires on `require("node:child_process")` in createDefaultExec().
  //   The implementation uses execFile + shell:false (T1 secure pattern). The rule targets
  //   dynamic shell-execution; this is a static require for a known Node.js module.
  {
    files: ["src/simctl.ts"],
    rules: {
      "security/detect-child-process": "off",
    },
  },
  // SAST override — SimulatorLifecycleManager.ts (frozen, #14):
  //   detect-unsafe-regex fires on the SimRuntime key parser regex.
  //   Input is xcrun simctl JSON output (OS-controlled, bounded), not user-supplied. Reviewed.
  {
    files: ["src/lifecycle/SimulatorLifecycleManager.ts"],
    rules: {
      "security/detect-unsafe-regex": "off",
    },
  },
];
