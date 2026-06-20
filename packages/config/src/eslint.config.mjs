// @ts-check
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettierConfig from "eslint-config-prettier";
import boundaries from "eslint-plugin-boundaries";

/**
 * Shared ESLint flat-config for all FlowScout packages.
 * Enforces typescript-eslint strict + boundaries (hexagonal dependency rule).
 * @type {import("eslint").Linter.Config[]}
 */
export const flowscoutEslintConfig = [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/*.d.ts",
      "**/vite.config.*",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      boundaries,
    },
    rules: {
      // TypeScript strict rules
      ...tseslint.configs["strict-type-checked"].rules,

      // Allow intentionally-unused stub params prefixed with `_`
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Complexity / smell guards (from ADR-0001 §6)
      complexity: ["error", { max: 10 }],
      "max-depth": ["error", { max: 4 }],
      "max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true }],
      "no-magic-numbers": [
        "warn",
        {
          ignore: [0, 1, -1],
          ignoreDefaultValues: true,
          ignoreClassFieldInitialValues: true,
        },
      ],

      // Hexagonal boundary enforcement
      "boundaries/element-types": [
        "error",
        {
          default: "disallow",
          rules: [
            // domain depends on nothing internal
            { from: "domain", allow: [] },
            // application depends only on domain
            { from: "application", allow: ["domain"] },
            // adapters depend on domain + their own scope
            { from: "adapter-mobile-mcp", allow: ["domain"] },
            { from: "adapter-llm", allow: ["domain"] },
            { from: "adapter-persistence", allow: ["domain"] },
            { from: "adapter-vault", allow: ["domain"] },
            { from: "adapter-report-html", allow: ["domain"] },
            // api wires application + adapters (composition root)
            { from: "api", allow: ["domain", "application", "adapter-*"] },
            // web imports domain types and api contract only
            { from: "web", allow: ["domain"] },
            // config has no boundaries restriction
            { from: "config", allow: ["*"] },
          ],
        },
      ],
    },
    settings: {
      "boundaries/elements": [
        { type: "domain", pattern: "packages/domain/src/**" },
        { type: "application", pattern: "packages/application/src/**" },
        { type: "adapter-mobile-mcp", pattern: "packages/adapters/mobile-mcp/src/**" },
        { type: "adapter-llm", pattern: "packages/adapters/llm/src/**" },
        { type: "adapter-persistence", pattern: "packages/adapters/persistence/src/**" },
        { type: "adapter-vault", pattern: "packages/adapters/vault/src/**" },
        { type: "adapter-report-html", pattern: "packages/adapters/report-html/src/**" },
        { type: "api", pattern: "packages/api/src/**" },
        { type: "web", pattern: "packages/web/src/**" },
        { type: "config", pattern: "packages/config/src/**" },
      ],
    },
  },
  // Disable type-aware rules for JS config files
  {
    files: ["**/*.mjs", "**/*.cjs", "**/*.js"],
    ...prettierConfig,
  },
  // Apply prettier last to disable conflicting formatting rules
  prettierConfig,
];

export default flowscoutEslintConfig;
