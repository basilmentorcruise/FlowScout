// @ts-check
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettierConfig from "eslint-config-prettier";
import boundaries from "eslint-plugin-boundaries";
import securityPlugin from "eslint-plugin-security";

/**
 * Shared ESLint flat-config for all FlowScout packages.
 * Enforces typescript-eslint strict + boundaries (hexagonal dependency rule)
 * + eslint-plugin-security SAST rules (T1 cmd injection, T2 path traversal, T5 secrets).
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
      security: securityPlugin,
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

      // SAST — eslint-plugin-security (E1.7 #18, per threat model §4.2)
      // High-value rules are errors; noisy/false-positive-heavy rules are warns.
      //
      // detect-child-process: "error" — detects T1 string-exec patterns (real risk).
      //   Usage of child_process with a non-literal first arg flags potential injection.
      "security/detect-child-process": "error",
      // detect-non-literal-fs-filename: "warn" — flags any non-literal path arg to fs.*,
      //   including realpath() which IS the T2 mitigation (canonicalize before access).
      //   Demoted to warn to avoid blocking secure T2 fix code; the T2 control is the
      //   realpath + allowlist pattern, not absence of dynamic paths (OWASP A01 CWE-22).
      "security/detect-non-literal-fs-filename": "warn",
      "security/detect-eval-with-expression": "error",
      // detect-non-literal-regexp: "warn" — fires on all RegExp(str) incl. allowlist patterns.
      "security/detect-non-literal-regexp": "warn",
      // detect-unsafe-regex: "error" — ReDoS is a real risk; any flagged pattern is reviewed.
      "security/detect-unsafe-regex": "error",
      "security/detect-buffer-noassert": "error",
      "security/detect-new-buffer": "error",
      "security/detect-no-csrf-before-method-override": "error",
      // detect-object-injection: "warn" — fires on every obj[key] access including validated maps.
      "security/detect-object-injection": "warn",
      "security/detect-non-literal-require": "error",
      "security/detect-possible-timing-attacks": "warn",
      "security/detect-pseudoRandomBytes": "error",
      "security/detect-disable-mustache-escape": "error",
      "security/detect-bidi-characters": "error",

      // Hexagonal boundary enforcement
      "boundaries/element-types": [
        "error",
        {
          default: "disallow",
          rules: [
            // domain depends on nothing internal
            { from: "domain", allow: [] },
            // application depends only on domain (+ the neutral persistence
            // conformance suite, test-only devDependency — ADR-0008 §7)
            { from: "application", allow: ["domain", "testing-persistence"] },
            // adapters depend on domain + their own scope
            { from: "adapter-mobile-mcp", allow: ["domain"] },
            { from: "adapter-llm", allow: ["domain"] },
            { from: "adapter-persistence", allow: ["domain", "testing-persistence"] },
            { from: "adapter-vault", allow: ["domain"] },
            { from: "adapter-report-html", allow: ["domain"] },
            // api wires application + adapters (composition root)
            { from: "api", allow: ["domain", "application", "adapter-*"] },
            // web imports domain types and api contract only
            { from: "web", allow: ["domain"] },
            // config has no boundaries restriction
            { from: "config", allow: ["*"] },
            // neutral test-support: shared port-conformance suite (ADR-0008 §7)
            // — depends on domain ONLY (must NOT import application/adapters)
            { from: "testing-persistence", allow: ["domain"] },
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
        { type: "testing-persistence", pattern: "packages/testing/persistence/src/**" },
      ],
    },
  },
  // Disable type-aware rules for JS config files
  {
    files: ["**/*.mjs", "**/*.cjs", "**/*.js"],
    ...prettierConfig,
  },
  // SAST overrides — frozen adapter-mobile-mcp files reviewed + secured in #12/#14.
  //
  // simctl.ts: detect-child-process fires on `require("node:child_process")` in
  //   createDefaultExec(). The implementation uses execFile + shell:false (T1 secure).
  //   The rule targets dynamic require() patterns; this is a static, known module.
  {
    files: ["**/adapters/mobile-mcp/src/simctl.ts"],
    rules: {
      "security/detect-child-process": "off",
    },
  },
  // SimulatorLifecycleManager.ts: detect-unsafe-regex fires on the SimRuntime key parser
  //   `/SimRuntime\.([A-Za-z]+)-(\d+(?:-\d+)*)$/` — reviewed; input is xcrun simctl JSON
  //   output (bounded by the OS), not user-controlled. Not a ReDoS surface in practice.
  {
    files: ["**/adapters/mobile-mcp/src/lifecycle/SimulatorLifecycleManager.ts"],
    rules: {
      "security/detect-unsafe-regex": "off",
    },
  },
  // A11ySignatureStrategy.ts: detect-unsafe-regex fires on the volatile-content normalisation
  // patterns (ISO timestamp, clock time, currency, digit-run). These operate on a11y label
  // strings — input is bounded by MAX_SNAPSHOT_BYTES and parsed from a controlled JSON tree,
  // not raw user-controlled text. Reviewed: no exponential backtracking on realistic a11y input.
  {
    files: ["**/models/state-identity/A11ySignatureStrategy.ts"],
    rules: {
      "security/detect-unsafe-regex": "off",
    },
  },
  // Apply prettier last to disable conflicting formatting rules
  prettierConfig,
];

export default flowscoutEslintConfig;
