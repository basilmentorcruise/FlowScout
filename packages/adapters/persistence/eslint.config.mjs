// @ts-check
/**
 * Persistence-adapter package ESLint config.
 *
 * Extends the shared config and — like packages/application — excludes `__tests__`
 * from linting: the SQLite contract/durability tests are long `describe` bodies with
 * literal seed values by design. All src/ (non-test) code keeps every security and
 * boundary rule fully enforced.
 */
import { flowscoutEslintConfig } from "@flowscout/config/eslint";

export default [...flowscoutEslintConfig, { ignores: ["src/**/__tests__/**"] }];
