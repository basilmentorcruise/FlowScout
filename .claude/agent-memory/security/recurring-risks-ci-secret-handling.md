---
name: recurring-risks-ci-secret-handling
description: The e2e-macos.yml workflow handles owner secrets (FLOWSCOUT_FIXTURE_APP etc.); a recurring set of GitHub Actions secret-handling checks applies whenever it is edited.
metadata:
  type: project
---

`.github/workflows/e2e-macos.yml` is the one FlowScout workflow that consumes owner secrets
(`secrets.FLOWSCOUT_FIXTURE_APP`, `_BUNDLE_ID`, `_APP_BUNDLE_DIR`) to drive the Layer B real-sim
round-trip. Secret-handling bugs recur here; check the same set on every edit.

**Why:** these secrets point at a fixture `.app` path/bundle id; leaking them into logs, step outputs,
or `if:` conditions is the realistic exposure. GitHub Actions has two non-obvious footguns that have
already bitten this file (both fixed): secrets are not allowed in step-level `if:`, and step-level
`env:` overrides `$GITHUB_ENV` values written by an earlier step.

**How to apply** when reviewing a change to this workflow:

- Secrets read **only** via `env:` keys (mapped to `$VAR`) or inside `run:`; never in a step `if:`
  (GitHub blocks secret context in `if:`). The pattern here: a "Select owner fixture" step reads the
  secret via `env:` and branches inside `run:`, emitting only a non-secret `selected=true` step output.
- Never splice `${{ secrets.* }}` / `${{ inputs.* }}` into `run:` command **text** — pass via `env:`
  and reference as `"$VAR"` (avoids command/script injection, CWE-78).
- `echo "NAME=$VAL" >> "$GITHUB_ENV"` / `>> "$GITHUB_OUTPUT"` write to files, not the log — fine — but
  confirm no `set -x` and no `echo` of the secret value to stdout. The step OUTPUT must be a literal
  (e.g. `selected=true`), never the secret value.
- Cross-step value passing uses `$GITHUB_ENV` (built-fixture path flows step→step that way); do NOT
  redeclare those names in a later step's `env:` block — step `env:` shadows `$GITHUB_ENV` and would
  blank them. This precedence is the subtle bug to watch for.
- `upload-artifact` (`if: always()`) must only capture the artifact dir (`.flowscout-e2e-artifacts/`),
  never a secret-bearing env dump.

See [[recurring-risks-mobile-mcp]] (T2/T9) and [[mandated-scanning-policy]].
