---
name: recurring-risks-ci-scan-ordering
description: CI runs steps fail-fast (bash -e); an early Format/Lint failure aborts the job BEFORE gitleaks/SAST/depcruise run, leaving the diff unscanned
metadata:
  type: project
---

The PR CI job (`.github` ci workflow) runs steps sequentially under `bash -e`, so the FIRST
failing step aborts the whole job and every later step is skipped. Step order is roughly:
SCA → Format check → Lint(+SAST) → Typecheck → depcruise(circular/arch) → Duplication → Test →
Build → **Secret scan (gitleaks)**.

gitleaks runs LAST and SAST/depcruise run mid-pipeline, so a trivial early failure (e.g. a
prettier **Format check** failure on style-only files) leaves the security scans **NOT RUN** even
though nothing security-relevant changed.

**Why:** the security gate's BLOCKED condition is "required scans did not run." A red CI does not
imply the scans ran — it can mean they were skipped upstream. SCA ran ≠ gitleaks/SAST ran.

**How to apply:** in the security gate, always inspect `gh run view <id>` step-by-step (or
`pnpm format:check`/lint/gitleaks results individually) to confirm gitleaks + SAST + depcruise
actually executed. If an early step aborted the job before them, verdict is **BLOCKED** (route to
developer to fix the early failure and re-run) — do NOT PASS on a manually-reviewed-but-unscanned
diff, and do NOT FAIL on the security content. See [[mandated-scanning-policy]].
