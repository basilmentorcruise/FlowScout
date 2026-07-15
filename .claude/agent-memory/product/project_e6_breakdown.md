---
name: project-e6-breakdown
description: How E6 (encrypted credential vault + 2FA pause-and-ask) was sliced into #101-#103, the engine/vault-only vs E5-dependent split, and what was deferred to the E6 ADR
metadata:
  type: project
---

E6 (epic #6, encrypted credential vault + 2FA pause-and-ask) was broken into 3 vertical slices. PRD:
docs/sdlc/prd/PRD-e6-credential-vault.md. E6 is NOT on the demo critical path — the demo app (Dime) has no
login — so slices were kept minimal and proven against a login-bearing app, not the golden path.

- #101 E6.1 Encrypted vault storage — implement the `VaultAdapter` stub (AES-256-GCM at rest, key from env only,
  per-app store/retrieve/list/delete, TOTP-seed round-trip, fail-closed on wrong key / tampered GCM tag).
  Depends-on NONE. Engine/vault only, no designer. type:feature.
- #102 E6.2 Crawl reuses vaulted credentials to authenticate & resume — autonomous no-prompt path: at a detected
  credential boundary, resolve username/password from vault, fill field, CONTINUE the loop instead of terminating
  `blocked-on-2fa`; bounded re-attempt on wrong credential. Depends-on #101. Engine/vault only, no designer.
- #103 E6.3 2FA/credential pause-and-ask via dashboard — interactive path: pause, emit `credential:prompt`,
  dashboard prompt UI, operator submits value via inbound response channel, type + resume; OTP never stored;
  non-OTP optionally persisted ("remember") → next run uses #102 path. Depends-on #102 + E5 #93 (API surface for
  the response route) + #94 (SSE passthrough of `credential:prompt`). Needs designer. type:feature.

**Why this cut (grounding on main):**

- `CredentialVaultPort` (packages/domain/src/ports/CredentialVaultPort.ts) already defines store/retrieve/
  listLabels/delete + AppCredential/PlaintextCredential incl. `encryptedOtpSeed`. `VaultAdapter`
  (packages/adapters/vault/src/VaultAdapter.ts) is a stub whose methods reject "not yet implemented — see TODO
  (E6)". So E6.1 is a real adapter impl behind an existing port.
- `CredentialBoundaryDetector` + `CredentialRedactor` (packages/application/src/crawl/twofa|redaction) already
  exist and are wired via CrawlCollaborators. `StartCrawlRun.checkCredentialBoundary` CURRENTLY emits
  `credential:prompt` and TERMINATES (`ls.termination = "blocked-on-2fa"; ls.running = false`). E6.2 changes
  this to resolve+fill+continue; E6.3 changes it to pause+await+resume. Redaction boundary (TB-A) must be
  preserved on every new path.
- `CredentialPromptEvent` is already in the `CrawlEventStream` contract and already emitted — the dashboard SEAM
  is designed-in. E5 #94's SSE relay passes it through (unknown-kind passthrough per ADR-0010). So E6.3 does NOT
  change the stream contract; it ADDS an inbound operator-response channel + the prompt UI.

**Key scope decisions (don't let downstream contradict):**

- ENGINE/VAULT-ONLY vs E5-DEPENDENT split is the load-bearing cut: #101 + #102 have no E5 dependency and can run
  while E5 #93/#94 land; only #103 needs #93 (response route) + #94 (prompt passthrough). This was the explicit
  product steer.
- Run DB (E7 SQLite) MUST NEVER store credential material — the vault is its own encrypted-at-rest store
  (security ruling). NFR: no secret in graph/report/logs/events/run-DB; OTP never persisted anywhere.
- MVP OTP path is the interactive PROMPT (#103), NOT autonomous TOTP-code generation from the stored seed
  (deferred, OQ4 — port carries the seed field for a later slice).
- Dedicated credential-management UI (list/edit/delete in dashboard) is OUT for MVP (OQ5) — secrets enter the
  vault via the #103 "remember this credential" affordance, not a management screen.
- Open questions (PRD): OQ1 architect (key handling — env vs keychain vs passphrase, single-machine pragmatic),
  OQ2 architect (at-rest store shape, separate from run DB), OQ3 architect (inbound operator-response mechanism,
  e.g. an OperatorResponsePort paired with outbound CrawlEventStream), OQ4 owner/architect (TOTP-seed autonomy),
  OQ5 owner (management UI need). Architect refines `Touches:`.

E6 is the LAST un-broken-down MVP epic. See [[project-e5-breakdown]], [[project-e7-breakdown]],
[[project-flowscout-sdlc-pipeline]]. All 3 issues on Project #4 Status=Todo, labels mvp + type:feature, linked
to epic #6 via a checklist comment.
