# PRD — E6: Encrypted credential vault + 2FA pause-and-ask

Epic: #6 · Tier: MVP · Owner: product

## Problem & users

Most real apps gate their interesting workflows behind login, and many behind 2FA/OTP. A zero-context
autonomous crawl stalls at the sign-in wall, so the most valuable post-auth surfaces never get mapped. Users
are internal **developers and testers** who want FlowScout to authenticate with a test account, reach
logged-in workflows, and — for the one step that cannot be automated — pause and ask them for a one-time code,
then continue. Credentials must be stored securely and reused across runs, and must never leak into the state
graph, report, logs, or run database.

Note: the demo app (Dime) has **no login**, so E6 is **not on the demo critical path**. Slices are kept minimal
and independent; the vault + pause-and-ask is proven against a login-bearing app, not the demo golden path.

## Goals / non-goals

**Goals**

- An encrypted-at-rest, per-app credential vault (store / retrieve / list / delete) with plaintext existing only
  transiently in memory at use time.
- The crawl **reuses** vaulted credentials to authenticate autonomously (no human) at a detected credential
  boundary, then resumes and maps post-login surfaces.
- When the vault cannot resolve a credential (first run) or a one-time OTP is required, the crawl **pauses**,
  the dashboard **prompts** the user, the user submits the value, the crawl **types** it and **resumes**.
- Secrets never appear in the state graph, report, logs, events, or the run DB. OTP values are never stored.

**Non-goals (this epic)**

- Multi-user / team credential sharing, RBAC, cloud sync, and biometrics.
- A dedicated credential-management screen (list/edit/delete credentials in the dashboard) — MVP puts secrets
  into the vault via the pause-and-ask "remember this credential" path, not a management UI. See open questions.
- Autonomous TOTP-code generation from a stored seed (MVP OTP path is the interactive prompt). See open questions.
- Key-derivation / keychain / passphrase mechanism selection — architect rules this (single-machine pragmatic).

## Requirements

### Functional

- **FR1 — Vault CRUD.** Store, retrieve, list-labels, and delete app credentials, scoped per `appId` + `label`
  (`CredentialVaultPort` already defines the contract; the adapter is a stub to implement).
- **FR2 — Encryption at rest.** Credentials are persisted encrypted with AES-256-GCM (per STATUS.md epic table);
  the encryption key is sourced only from env / secret store, never committed and never defaulted.
- **FR3 — Reuse (autonomous auth).** At a detected credential boundary, the crawl resolves username/password
  from the vault, fills the field, and continues instead of terminating; later runs reuse the same entry.
- **FR4 — Pause-and-ask loop.** When the vault has no matching entry or an OTP is required, the crawl emits a
  `credential:prompt` event (already in the `CrawlEventStream` contract), enters a blocked state, and awaits an
  operator response through an inbound response channel.
- **FR5 — Resume.** On operator response, the crawl types the supplied value into the detected field and resumes
  the crawl loop; the run completes normally afterward.
- **FR6 — OTP one-time path.** An OTP value is used once and is **never** written to the vault or any store.
- **FR7 — Optional persist-for-reuse.** A supplied non-OTP credential (username/password) may be persisted to the
  vault (operator opt-in) so the next run authenticates via FR3 without a prompt.

### Non-functional

- **NFR1 — No plaintext on disk, ever.** No plaintext credential or OTP is written to any file at any time.
- **NFR2 — Never in graph/report/logs/events/run-DB.** The existing `CredentialRedactor` boundary keeps secrets
  out of snapshots, edges, and events; E6 must preserve that invariant for every new path (typed value, resume,
  persist). The run DB (E7 SQLite) MUST NOT store any credential material — the vault is its own storage.
- **NFR3 — Fail closed.** A missing/wrong key, a tampered ciphertext (GCM auth-tag failure), or a decrypt error
  must fail without exposing plaintext and without silently continuing with an empty credential.
- **NFR4 — Memory hygiene (best-effort).** Plaintext credential buffers are held as briefly as possible and
  best-effort zeroized/dropped after use; no long-lived plaintext caches.
- **NFR5 — Structural detection only.** Credential-surface detection stays structural (already implemented) and
  never reads credential field values.

## UX notes (UI — E6.3 only)

- The dashboard surfaces a pause banner/modal when a `credential:prompt` event arrives, showing the `promptType`
  (`username` | `password` | `2fa-otp`) and a redacted, non-sensitive message. It must not display any field
  values from the app.
- One input to submit the value; masked entry; an explicit submit and an explicit cancel.
- For non-OTP prompts, an optional "remember this credential for future runs" affordance (FR7). OTP prompts show
  no remember option.
- Clear paused/resumed status feedback tied to the live-watch panel (E5.2).

## Success metrics

- FlowScout logs into a login-bearing app using vaulted credentials, pauses and requests an OTP when prompted,
  resumes after the user provides it, and maps the post-login workflows — with **zero** secret appearing in the
  report, state graph, logs, events, or run DB.

## Edge cases & error states

- **Wrong credential** (app rejects login): the crawl detects it is still on / back on a credential surface and
  re-enters the pause-and-ask loop (does not loop infinitely — bounded re-prompts, then ends as partial).
- **Crawl timeout while paused**: if no operator response arrives within the wait window, the run ends as
  `partial`/`blocked-on-2fa` with a redacted reason; no secret is stored, no leak.
- **User cancels the prompt**: the crawl ends gracefully (blocked/partial), maps whatever pre-login surface it
  has, and stores nothing.
- **Missing/empty vault key**: vault operations fail closed with a clear, secret-free error (NFR3).
- **Tampered vault file**: GCM auth-tag verification fails; retrieve errors rather than returning garbage.
- **OTP-only boundary with no stored seed**: routed to the interactive prompt (FR4), never auto-filled.

## Open questions

- **OQ1 (architect):** Key handling for single-machine MVP — env var vs OS keychain vs derived-from-passphrase.
  Steer: pragmatic; architect rules the key-derivation/keychain detail in the E6 ADR.
- **OQ2 (architect):** Vault at-rest storage location/format — a dedicated encrypted file/store separate from the
  E7 run DB (security ruled the run DB must never be a credential store). Confirm the separate-store shape.
- **OQ3 (architect):** Inbound operator-response mechanism — the channel by which a paused crawl receives the
  submitted value (e.g., a domain `OperatorResponsePort` + in-process bus paired with the existing outbound
  `CrawlEventStream`). Product specifies the requirement; architect picks the mechanism.
- **OQ4 (owner/architect):** Is autonomous TOTP-code generation from a stored `encryptedOtpSeed` in MVP, or is
  all OTP handled via the interactive prompt? PRD assumes prompt-only for MVP; the port already carries a seed
  field for a later slice.
- **OQ5 (owner):** Is a dedicated credential-management UI needed for MVP, or is the pause-and-ask "remember"
  path sufficient? PRD assumes the latter (management UI deferred).

## Ticket breakdown (links to issues)

- **E6.1 (#101)** — Encrypted vault storage (AES-256-GCM, per-app CRUD, TOTP seed) — engine/vault only, no E5 dep.
- **E6.2 (#102)** — Crawl reuses vaulted credentials to authenticate & resume (autonomous, no prompt) — depends #101.
- **E6.3 (#103)** — 2FA/credential pause-and-ask via the dashboard (prompt → response → resume) — depends #102, E5 #93, #94.
  </content>
  </invoke>
