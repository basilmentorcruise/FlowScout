---
name: recurring-risks-e6-vault
description: E6 (credential vault + 2FA pause-and-ask, #101/#102/#103) is FlowScout's first at-rest + inbound-secret boundary; the recurring HIGH/CRITICAL controls to re-verify at every E6 gate and whenever the vault adapter, crawl typing path, or operator-response route changes.
metadata:
  type: project
---

E6 threat model: `docs/sdlc/security/e6-vault-threat-model.md` (T1–T18 + T-persist). This is the first place
FlowScout holds real (test-account) secret material **at rest** and moves it end-to-end (env key → AES-256-GCM on
disk → transient plaintext → `driver.typeText` → inbound localhost POST). Re-verify these when reviewing
`packages/adapters/vault`, the crawl credential-boundary/typing path (`StartCrawlRun`), or the #103 operator-response route:

- **Nonce (T1, CRITICAL):** fresh `randomBytes(12)` per encryption, stored alongside ciphertext, **new nonce on every
  re-store/update**. Reuse under the same GCM key = CRITICAL FAIL, not a note.
- **Key (T2, HIGH):** `FLOWSCOUT_VAULT_KEY` env-sourced (or ADR-0011 store), injected at composition root, **no default
  ever** (a defaulted key = no encryption). Fail closed on missing; 32-byte validated; never logged/in-error/on-argv.
- **Auth-tag + AAD (T3, HIGH):** decrypt calls `setAuthTag` and lets failure **throw** (no catch-return-garbage);
  **AAD-bind** ciphertext to `appId`(+label) via `setAAD` to defeat cross-entry blob swap.
- **No plaintext to disk (T4/T5, HIGH):** ciphertext-only writes; atomic temp+rename `0600` (file) or a **separate** DB
  from the E7 run DB (SQLite); path outside repo + gitignored; no `appId`/`label` in a path segment.
- **Typing-path redaction (T9, HIGH):** vault password goes real to `typeText` but redacted before every sink — the E2
  single-redaction-boundary invariant, unchanged. Caveat: `redactText` only masks OTP-shaped digits; the **password**
  graph-control is structural secure-field redaction on the snapshot, not `redactText`.
- **Screenshot-near-boundary ruling (T10):** NO screenshot captured/stored/referenced across the credential-typing
  window (detection → type/submit → immediate post-submit); `screenshotUri` stays null. The a11y redactor can't scrub a
  rasterized secret (usernames render plaintext; reveal-toggles exist) — only not-capturing is safe. Hard gate if
  screenshots ever ship for the crawl.
- **#103 route CSRF (T13/T14, HIGH):** the operator-response POST is a new state-changing localhost route → MUST inherit
  the **E5 T3/T4 Origin+Host CSRF/rebind gate** and T12 no-secret-in-URL/log; secret in POST body only, ack-only
  response, never echoed/logged/on-SSE.
- **OTP (T8, owner ruling):** one-time codes NEVER persisted anywhere; `otpSeed` if stored is encrypted like the password.
- **Pending-prompt registry (T16):** memory-only; cleared on resume/timeout/cancel; never to run DB/vault/file.
- **Cross-cutting (T18):** test secrets runtime-constructed (gitleaks-clean, established pattern); **`node:crypto` only**
  — any new crypto/TOTP dep is a MUST-justify (SCA + pin + sign-off).

**ADR-0011 (concurrent) resolves the conditional MUSTs:** key handling (env vs keychain vs KDF), at-rest store shape
(file vs SQLite), operator-response port mechanism — re-verify the chosen branch at the #101/#103 gates.
See [[recurring-risks-redaction-2fa-noprod]], [[scope-boundaries]], [[recurring-risks-e7-persistence]], [[mandated-scanning-policy]].
