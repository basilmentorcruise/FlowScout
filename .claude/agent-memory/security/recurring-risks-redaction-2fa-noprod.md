---
name: recurring-risks-redaction-2fa-noprod
description: E2's three non-LLM safety controls (redaction boundary, 2FA boundary, no-production/reset guard) — how they are wired in the crawl loop and the recurring review checks + posture caveats that recur whenever the loop or composition root changes.
metadata:
  type: project
---

The E2.7 capstone (#37) landed FlowScout's three non-LLM safety controls in
`packages/application/src/crawl`. When reviewing any later change to the crawl loop
(`StartCrawlRun.ts`), `collaborators.ts`, or the composition root (`packages/api/.../wire.ts`),
re-verify these (full detail in `docs/sdlc/security/e2-crawl-engine-threat-model.md` T3/T4/T7/T8):

- **Single redaction boundary (T3/T7/T8).** `CredentialRedactor.redact(rawSnapshot)` must run in
  `runLoop` immediately after `driver.snapshotAccessibilityTree()` and BEFORE every sink: identify,
  state-node record, 2FA detect, candidate enumeration, and the decision context (`a11ySnapshot`)
  that reaches the LLM. typeText is recorded redacted (`redactAction`/`redactText`) but typed real
  into the driver. `redactor`/`credentialBoundary` are REQUIRED collaborators with real defaults —
  redaction is never skippable. Recurring check: confirm the redact call stays upstream of ALL
  sinks if the loop is reordered.

- **2FA boundary (T8).** `CredentialBoundaryDetector.detect(safeSnapshot)` runs on the REDACTED
  snapshot, BEFORE `decide()`; on detection it emits `credential:prompt` (promptType + redacted
  message + stateId, no values), sets `blocked-on-2fa`, stops the loop — so the credential surface
  never reaches the LLM. Detection is structural (roles/traits/label patterns), not value-reading.

- **No-production + reset-safety-net (T4).** Engine guard is `runSafety !== undefined &&
!runSafety.nonProduction → abort` and `simulatorLifecycle.takeSnapshot(...)` before the loop
  (abort on throw). **Posture caveat (note, not a blocker):** both `runSafety` and
  `simulatorLifecycle` are OPTIONAL collaborators — when undefined the engine SKIPS the guard
  (fail-open at the engine level). Production safety therefore depends on the composition root
  always wiring them (it does: `FLOWSCOUT_NON_PRODUCTION` env + lifecycle). Recurring check: if a
  new caller constructs `StartCrawlRun` directly, confirm it supplies `runSafety` — the engine will
  not protect it otherwise. A future hardening would make the guard fail-closed in the engine.

**Why:** these are the accepted safety net for the no-in-flow-guardrails posture (ADR-0001 F6) on
real test-account data. **How to apply:** treat redaction-upstream-of-all-sinks and
detect-before-decide as invariants; flag any reordering that moves a sink ahead of redaction or
`decide()` ahead of the 2FA check. See [[recurring-risks-llm-boundary]] and [[scope-boundaries]].

**Known E2E coverage gap (tracked as Medium follow-up on #37):** the capstone E2E asserts the
synthetic OTP token absent from events + graph, but does NOT assert absence from the captured LLM
payload (`CapstonePolicy.capturedSnapshots` exists for this but is unused) nor from the decision
cache — though the threat-model #37 MUST names "events, graph, cache, AND the LLM payload." The
control itself is implemented + unit-tested (redactor) and the LLM-payload path is protected
(redaction upstream + 2FA-stops-before-decide), so this is an assertion gap, not a control
regression.
