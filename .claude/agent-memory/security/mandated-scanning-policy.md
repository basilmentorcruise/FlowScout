---
name: mandated-scanning-policy
description: FlowScout mandated security automation — gitleaks + dependency SCA + SAST in CI and pre-commit, with thresholds.
metadata:
  type: project
---

Mandated automation the security agent owns (architect/developer wire it for the TS/Node stack), run
in **both CI and pre-commit hooks**:

- **Secret scanning:** gitleaks (already mandated in ADR-0001 §6) — any finding fails.
- **Dependency SCA:** `pnpm audit` (or osv-scanner / Snyk). High/Critical advisory fails the build;
  Moderate becomes a tracked follow-up. Especially gates mobile-mcp + `@modelcontextprotocol/sdk` +
  transitive WebDriverAgent (the top dependency risk).
- **SAST:** typescript-eslint strict + `eslint-plugin-security` — flags `child_process` string-exec,
  non-literal fs paths, `eval`. This is the concrete lever for the injection/traversal risks in the
  mobile-mcp adapter.
- **Lockfile integrity:** `pnpm install --frozen-lockfile`; exact version pins (no `^`/`~`) on the
  mobile-mcp + MCP SDK deps.

**Verdict policy reminder:** Critical/High → FAIL (block); Medium → must-fix or tracked follow-up
(never silently dropped); Low → note. See [[recurring-risks-mobile-mcp]].

**How to apply:** at each security gate, verify these run and are green; don't re-derive thresholds.
Confirm exact pins in `packages/adapters/mobile-mcp/package.json` and a committed lockfile.

**Current wiring status (verify before relying on it):** As of #18, all three controls are wired
in `.github/workflows/ci.yml`: gitleaks (final step), **SCA** (`pnpm audit`), and **SAST**
(`eslint-plugin-security` in `packages/config/src/eslint.config.mjs`, run via `pnpm turbo run lint`).

**SCA is `--prod`-scoped by policy (accepted):** the gate step is `pnpm audit --audit-level=high
--prod` (fails on High/Critical in the _production_ dep tree); a second `pnpm audit --audit-level=high
|| true` step reports _all_ deps non-blocking. Rationale (verified at #18 gate): the only High/Critical
advisories are dev/build-time only — `handlebars` (1 crit + 4 high) via `eslint-plugin-boundaries`,
and `vite` (high) via `vitest`. Neither executes in the running product, so `--prod` scoping does not
hide a real risk. These dev-dep advisories are tracked follow-ups (the report-only step keeps them
visible), not gate failures. **Re-judge if a High/Critical ever appears in a `--prod` path** — that
must FAIL.

**SAST rule tuning:** `detect-child-process` and `detect-eval-with-expression` run as **errors**;
`detect-non-literal-fs-filename` / `detect-non-literal-regexp` / `detect-object-injection` are **warns**
(they fire on the T2 `realpath` + allowlist-regex mitigation code itself — demoting avoids blocking the
secure fix). `detect-child-process` correctly does NOT fire on `execFile(<literal>, argv[])` (the safe
T1 pattern), so the lint passes safe shell-out code while still catching string-exec/non-literal commands.
Two scoped file overrides exist in `eslint.config.mjs` (simctl.ts, SimulatorLifecycleManager.ts) — both
reviewed and security-justified in-comment.
