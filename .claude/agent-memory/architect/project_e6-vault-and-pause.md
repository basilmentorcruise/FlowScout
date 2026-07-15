---
name: e6-vault-and-pause
description: ADR-0011 E6 rulings — scrypt+GCM file vault, resolver-chain seam (ONE StartCrawlRun refactor in #102), in-process OperatorResponseChannel; gate anchors for #101/#102/#103
metadata:
  type: project
---

E6 (epic #6, ADR-0011 + e6-plan.md, designed 2026-07-15) rulings the review gate must hold #101/#102/#103 to:

- OQ1: `FLOWSCOUT_VAULT_KEY` env → scrypt-derived AES-256 key (node:crypto only, per-vault salt); fail closed via typed errors; lazy `VaultKeySource` (API boots keyless). OQ2: single JSON file `FLOWSCOUT_VAULT_PATH` (default `./.flowscout/vault.json`), whole-entry GCM blob (username encrypted too), AAD = appId+label+version, atomic 0600 write. NOT SQLite, never the run DB.
- OQ3 / the seam: #102 does the ONE `checkCredentialBoundary` refactor → injected `CredentialBoundaryResolver` chain (optional collaborator, default `PromptAndStopResolver` = today's behaviour byte-exact, ADR-0004 §7.2 discipline). **#103 must NOT edit StartCrawlRun** — wiring terminal-swap to `InteractiveBoundaryResolver` only. `OperatorResponseChannel` is APPLICATION-layer (not a domain port — deliberate refinement of #103's issue Touches), runId-keyed, single pending prompt, no promptId.
- Owner rulings (do not reopen): OTP = interactive prompt only; no credential-management UI in MVP.
- Pause: budgets count-based ⇒ never tick while paused; only bound `FLOWSCOUT_PROMPT_TIMEOUT_MS` (300000); run row stays `running` while paused. `GET /api/runs/:runId/prompt` closes the SSE no-replay gap.
- Gate-blocking checks: #101 no-plaintext-on-disk + AAD-swap + 0600 (vault ≥90%); #102 no-secret string-scan of events+graph, synthetic redacted edge `REDACTED_CREDENTIAL_PAYLOAD` present (else E3 orphans post-login subgraph), 2fa-otp never auto-filled, MAX_VAULT_FILL_ATTEMPTS_PER_RUN=1; #103 remember-on-OTP ⇒ 400, value never logged/echoed, 409 `no_pending_prompt`.
- #101 Touches narrowed to `adapters/vault/src/**` only (no wire.ts — kept parallel with the E5 wave, which contends on wire.ts per [[e5-dashboard]] R3). Order: #101 (now, ∥ E5) → #102 → #103.

**Why:** one refactor serving two tickets was an explicit design constraint; the redacted synthetic login edge exists because a missing edge would disconnect the post-login subgraph from E3 workflow extraction.
**How to apply:** in review-gate mode on #101/#102/#103, verify these anchors literally; FAIL #103 if it touches StartCrawlRun.ts or adds a domain port for the channel.
