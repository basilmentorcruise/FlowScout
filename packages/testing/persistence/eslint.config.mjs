// @ts-check
/**
 * Testing-persistence package ESLint config.
 *
 * Extends the shared config but relaxes the function-length/magic-number smell guards:
 * this package IS test code (the shared port-conformance suite of ADR-0008 §7 — section
 * runners are long `describe` bodies by design, and fixtures contain literal seed values).
 * Application/api packages exclude their `__tests__` from linting for the same reason;
 * here the whole `src/` is test support, so the relaxation is scoped to the package.
 * All security and boundary rules remain fully enforced.
 */
import { flowscoutEslintConfig } from "@flowscout/config/eslint";

export default [
  ...flowscoutEslintConfig,
  {
    files: ["src/**/*.ts"],
    rules: {
      "max-lines-per-function": "off",
      "no-magic-numbers": "off",
    },
  },
];
