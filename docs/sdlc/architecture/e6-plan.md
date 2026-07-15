# E6 — Credential vault + 2FA pause-and-ask: per-ticket plan (#101 / #102 / #103)

- **Mode:** plan (design-time, epic #6). **ADR:** `docs/sdlc/architecture/ADR-0011-e6-vault-and-pause.md`
  (OQ1/OQ2/OQ3 + pause-semantics rulings live there; this plan is the work breakdown).
- **Inputs:** `docs/sdlc/prd/PRD-e6-credential-vault.md` · issues #101/#102/#103 · ADR-0004 (frozen shell +
  §7.2 additive-collaborator precedent) · ADR-0008 (run DB ≠ credential store) · ADR-0010 + `e5-plan.md`
  (D5 route/envelope/gate conventions, #94 verbatim-SSE E6 seam, 4-registration-line concurrency model).
- **Owner rulings (binding):** OTP = interactive prompt only (no TOTP from stored seed); no
  credential-management UI in MVP.
- Working-tree draft — do NOT commit with code; lands via the docs PR.

## 1. Rulings (rationale in ADR-0011; restated for the developers)

- **D1 (OQ1):** master secret from `FLOWSCOUT_VAULT_KEY` env; AES-256 key derived via **scrypt**
  (`node:crypto`, zero new deps; N=16384/r=8/p=1/32B key/16B salt as named constants); per-vault salt in the
  file header; fail closed on missing key (`VaultKeyMissingError`) / wrong key or tamper
  (`VaultIntegrityError`); lazy `VaultKeySource` injection so the API boots keyless (demo path); Keychain
  upgrade = swap the key source only.
- **D2 (OQ2):** one encrypted **JSON file** at `FLOWSCOUT_VAULT_PATH` (default `./.flowscout/vault.json`),
  **never** the run DB and not a second SQLite. Per-entry AES-256-GCM blob over `{username, password,
otpSeed}` (username encrypted too — PII); plaintext only `appId`/`label`/IV/tag/KDF header; **AAD binds
  `appId+label+version`**; deterministic serialization; atomic `tmp+rename`, file `0600`, dir `0700`.
- **D3 (OQ3):** `checkCredentialBoundary` delegates to an injected **`CredentialBoundaryResolver`** —
  Chain of Responsibility: `VaultBoundaryResolver → (terminal)`. Terminal is `PromptAndStopResolver`
  (today's behaviour, default) until #103 swaps it for `InteractiveBoundaryResolver` at the composition
  root. **One `StartCrawlRun` refactor (in #102); #103 edits wiring only.** Inbound responses via an
  **application-layer in-process `OperatorResponseChannel`** keyed by `runId` (single pending prompt per
  run — no promptId), injected timer for timeout tests. NOT a domain port (no infra boundary crossed;
  refines #103's Touches guess).
- **D4 (pause semantics):** budgets are count-based ⇒ **no budget ticks while paused**; the only pause bound
  is `FLOWSCOUT_PROMPT_TIMEOUT_MS` (default 300000). Timeout ⇒ `blocked-on-2fa` terminal (today's shape);
  cancel ⇒ graceful `partial`/`blocked-on-2fa`, nothing stored. Run row stays `running` while paused;
  "paused" is presentation state from `credential:prompt` + `GET /api/runs/:runId/prompt` (reconnect
  reconciliation — closes the ADR-0010 no-replay gap for pauses).
- **D5 (secret flow):** fill executes directly against `MobileDriverPort` (tap field → typeText → optional
  tap submit) — plaintext never enters candidates/decisions/events/LLM. The login edge is recorded via the
  existing `recordTransition` with a **synthetic redacted action** (`REDACTED_CREDENTIAL_PAYLOAD =
'{"text":"«credential»"}'`) so E3 extraction never orphans the post-login subgraph. OTP never persisted
  (`remember` on `2fa-otp` ⇒ 400). `remember` merges into the `DEFAULT_CREDENTIAL_LABEL = "default"` entry.
- **D6 (bounded retries):** `MAX_VAULT_FILL_ATTEMPTS_PER_RUN = 1` (re-detected boundary after a vault fill ⇒
  the credential failed ⇒ pass down-chain, never re-type it); `MAX_INTERACTIVE_PROMPTS_PER_RUN = 3` ⇒ then
  `stop/partial`. Constants named, config-liftable later.

## 2. Shared seam design (#102 lands it; #103 consumes it)

1. **Detector extension (additive):** `CredentialBoundaryResult` gains optional `usernameFieldId?`,
   `secureFieldId?`, `otpFieldId?`, `submitElementId?` — captured during the existing walk (element ids +
   primary-button label patterns `sign in / log in / continue / submit / verify`). Detection stays
   structural (NFR5); no field **values** are ever read.
2. **`CredentialBoundaryResolver` contract + chain** in `packages/application/src/crawl/twofa/` (shape in
   ADR-0011 §4): `resolve(ctx) → fill | stop`.
3. **`StartCrawlRun` edit (the one sanctioned edit, ADR-0004 §7.2 discipline):** `checkCredentialBoundary`
   body becomes detect → build ctx (needs `appId` added to the internal `LoopState` — private type, not a
   frozen surface) → `resolver.resolve` → on `fill`: execute taps/typeText, `stepCount++`, record synthetic
   redacted edge, return true (loop re-observes); on `stop`: set termination, stop loop (today's tail).
   Constructor + `defaultCollaborators` required args **unchanged**; new optional collaborator
   `boundaryResolver` defaults to `PromptAndStopResolver(crawlEventStream)` ⇒ all existing shell tests pass
   unmodified.
4. **`OperatorResponseChannel`** (`packages/application/src/crawl/twofa/OperatorResponseChannel.ts`):
   interface + `InProcessOperatorResponseChannel` (#103). `awaitResponse` races submit/cancel/timeout;
   `getPending` feeds the reconnect route; injected timer.

## 3. Per-ticket plans

### #101 — E6.1: Encrypted vault storage · branch `fs-101-vault-aes-gcm` · Depends-on: none

Pure adapter-package work — **no domain edit, no wire.ts edit** (refines the issue's Touches: the port
contract already suffices — whole-blob encryption makes the at-rest record adapter-internal, and wiring the
adapter into the crawl belongs to #102; keeping #101 out of `wire.ts` makes it fully concurrent with the
in-flight E5 wave, which is contending on that file).

- Replace the `VaultAdapter` stub: `store` (merge/overwrite by `appId+label`) / `retrieve` (null on miss) /
  `listLabels` (header-only, no decrypt) / `delete` — per D1/D2. Internal modules (SRP): `VaultCrypto`
  (scrypt + GCM seal/open with AAD), `VaultFileStore` (load/parse/validate + atomic 0600 write),
  `vaultConfig.ts` (`resolveVaultConfig(env)` → path + `VaultKeySource`; exported for #102's composition
  root), typed errors (`VaultKeyMissingError`, `VaultIntegrityError`).
- Constructor: `new VaultAdapter({ vaultPath, keySource })` — DI, no `process.env` reads inside the adapter
  class (only in `vaultConfig.ts`).
- **Tests (≥90% line+branch):** every #101 AC — round-trip incl. `otpSeed`; per-app isolation; label
  listing exposes no ciphertext; delete removes bytes from disk; missing/empty/wrong key ⇒ typed error, no
  plaintext in message; tampered ciphertext/tag ⇒ `VaultIntegrityError`; **AAD swap** (entry A's blob under
  entry B's keys) ⇒ fails; persisted bytes contain no plaintext (grep the file for the fixture secret); file
  mode `0600`; atomicity (tmp cleaned up); deterministic bytes for identical content; unknown `version` ⇒
  fail closed.
- **Touches:** `packages/adapters/vault/src/**` (adapter + internal modules + `__tests__` + barrel) ·
  `packages/adapters/vault/package.json` only if test tooling needs it (expected: none).

### #102 — E6.2: Autonomous vault auth + resume · branch `fs-102-vault-autonomous-auth` · Depends-on: #101

Lands the §2 seam (the single `StartCrawlRun` refactor) + the vault chain element + wiring.

- **Application:** §2 items 1–3. `VaultBoundaryResolver(vault, next)`: username/password → retrieve
  (`DEFAULT_CREDENTIAL_LABEL`, fallback first `listLabels` entry) → `fill` (username field + secure field +
  submit if detected; degrade gracefully when field ids are missing — fill what was found; nothing found ⇒
  pass to next); `2fa-otp` ⇒ always pass to next (owner ruling); miss/keyless/attempt-exhausted (D6) ⇒ next.
  `PromptAndStopResolver` extracted from today's `checkCredentialBoundary` body verbatim.
- **Wiring:** `wire.ts` — construct `VaultAdapter` from `resolveVaultConfig(process.env)`, build the chain
  `VaultBoundaryResolver(vault, PromptAndStopResolver(stream))`, pass as `boundaryResolver` into
  `defaultCollaborators` at the existing `StartCrawlRun` construction site. **Coordinate:** `wire.ts` is
  also touched by E5 #93 (e5-plan R3) — serialize or accept a one-line rebase; coordinator owns ordering.
- **Redaction invariants (gate-blocking):** plaintext only to `MobileDriverPort`; synthetic redacted edge
  (D5); post-fill snapshots pass the unchanged `CredentialRedactor` boundary.
- **Tests (≥85% on `crawl/twofa` + shell delta):** vaulted cred ⇒ fill + loop continues + post-login states
  recorded (fake driver whose post-fill snapshot changes); vault miss ⇒ today's prompt+terminate byte-exact;
  `2fa-otp` ⇒ never auto-filled; wrong credential (state re-detected) ⇒ exactly one fill then blocked, no
  unbounded retry; **no-secret suite:** fixture password appears in zero events / graph nodes / edges
  (string-scan the persisted graph + captured events); synthetic edge present with
  `REDACTED_CREDENTIAL_PAYLOAD`; existing `StartCrawlRun` tests pass unmodified (default resolver).
- **Touches:** `packages/application/src/crawl/StartCrawlRun.ts` (checkCredentialBoundary body + LoopState
  appId + fill executor) · `packages/application/src/crawl/collaborators.ts` (optional `boundaryResolver`)
  · `packages/application/src/crawl/twofa/**` (detector extension, resolver contract, 2 resolvers, tests) ·
  `packages/api/src/composition-root/wire.ts` (vault + chain block).

### #103 — E6.3: Pause-and-ask via dashboard · branch `fs-103-pause-and-ask` · Depends-on: #102, #93, #94

Wiring-swap + one route file + one web feature — **no `StartCrawlRun` edit** (the #102 seam absorbs it).
Needs-designer: yes — the prompt modal/banner spec (copy, tokens, focus rules) comes from the designer
against PRD "UX notes"; this plan pins the contracts.

- **Application:** `InteractiveBoundaryResolver(channel, vault, stream, timeoutMs)` — publish
  `credential:prompt` → `channel.awaitResponse` → submit ⇒ optional remember-merge (never OTP, D5) + `fill`
  into the detected field; cancel/timeout ⇒ `stop` (D4); re-prompt bound D6.
  `InProcessOperatorResponseChannel` (§2.4).
- **API** (ADR-0010 D5 conventions inherited — envelope, origin gate on non-GET, no logging of bodies):
  `routes/prompt.ts` (new):
  - `POST /api/runs/:runId/credential-response` — body `{action:"submit", value, remember?} |
{action:"cancel"}`; `value` non-empty, max length (e.g. 512), control-chars rejected; `remember` on an
    OTP prompt ⇒ `400 invalid_input`; no pending prompt ⇒ `409` new envelope code `no_pending_prompt`
    (additive to the D5 code set); success ⇒ `204`. The value is **never** logged or echoed.
  - `GET /api/runs/:runId/prompt` — pending `{promptType, requestedAt}` or `404 no_pending_prompt` (D4
    reconnect reconciliation).
  - `prompt` slice added to `ApiDeps` (`{ channel: OperatorResponseChannel }`) + the e5-plan §4 registration
    lines.
- **Wiring:** `wire.ts` — construct the channel, swap the chain terminal `PromptAndStopResolver` →
  `InteractiveBoundaryResolver` (one-line chain change), expose the channel to `buildApiDeps`.
- **Web (MVVM, ADR-0010 D6 idiom):** `model/api/prompt.ts` (submit/cancel/getPending) + one `ApiClient`
  facade line · `features/prompt/` — `usePromptViewModel` (triggered by `credential:prompt` from the live
  VM's event feed + `getPending` on mount/reconnect; states: hidden/awaiting-input/submitting/error) +
  `PromptPanel` per designer spec (masked input, promptType badge, remember checkbox hidden for OTP, submit
  - cancel, paused/resumed status tied to the live panel). Integration = one import in #94's `LivePanel`
    (the established #94/#95-style soft seam).
- **Tests (≥85% each layer):** channel (submit-before/after-await, timeout via fake timer, cancel,
  single-pending invariant); resolver (OTP-remember never stores — vault spy; remember merges; timeout ⇒
  blocked terminal); route (409/400/204 matrix, foreign Origin ⇒ 403 inherited, response/logs contain no
  submitted value — capture logger and assert); web VM states + reconnect-pending fetch; E2E-ish
  application test: boundary → prompt event → submit via channel → post-boundary state discovered → **no
  secret anywhere** (string-scan events/graph as in #102).
- **Touches:** `packages/application/src/crawl/twofa/{InteractiveBoundaryResolver,OperatorResponseChannel}`
  (+tests) · `packages/api/src/routes/prompt.ts` (new) + reg lines (`routes/index.ts`, `buildApiDeps.ts`) ·
  `packages/api/src/composition-root/wire.ts` (channel + terminal swap) · `packages/web/src/{model/api/
prompt.ts (new), model/ApiClient.ts (one line), features/prompt/ (new), features/live (one import)}`.

## 4. Parallelization & merge order

- **#101 starts now** — disjoint from everything in flight (only `packages/adapters/vault/**`; E5 never
  touches it). Safe concurrent with #93–#97.
- **#102 after #101 merges.** File-disjoint from E5 web/route work; the only contention is one `wire.ts`
  block (shared with #93/#85/#89 — e5-plan R3): coordinator serializes `wire.ts` landings or rebases the
  one block.
- **#103 after #102 + #93 + #94** (needs the seam, the route conventions/`ApiDeps`, and the live panel +
  SSE relay). Concurrent-safe with #95–#97 by the e5-plan §4 registration-line model (adds its own route
  file / model module / feature dir + the 4 one-line appends, plus the one-import LivePanel seam shared
  with #94 — #94 lands first by dependency, so no race).
- Order: **#101 → #102 → #103**; #101 ∥ E5 wave; #102/#103 interleave with E5 per the above.

## 5. Risks

- **R1 — `wire.ts` contention** with E5 (#93) and E7 (#85)/E4 (#89): one shared file, multiple epics.
  Mitigation: #102/#103 each add one self-contained block; coordinator orders merges; trivial rebase.
- **R2 — tap-to-focus/typeText assumption:** iOS fill relies on `tap(field)` focusing before `typeText`.
  The Dime demo has no login, so this is validated against a login-bearing app (PRD success metric), with
  fake-driver tests in CI. Fallback if a field id is missing: fill what was detected; unresolvable ⇒
  down-chain ⇒ prompt/blocked — degraded, never wrong-field typing of a secret without a target.
- **R3 — detector field-id recall:** heuristic extraction may miss ids on exotic a11y trees ⇒ same graceful
  degradation as R2 (never a crash, never a leak).
- **R4 — missing login edge orphaning post-login workflows:** mitigated by the synthetic redacted edge (D5);
  architecture gate checks the edge exists in the #102 fixture graph.
- **R5 — long pause with idle simulator/MCP session:** no in-flight call while paused, but a 5-min idle sim
  is unexercised territory; timeout default keeps it bounded; config knob exists.
- **R6 — JS string zeroization impossible:** NFR4 is best-effort by language reality; Buffers are zeroed,
  strings are not — recorded in ADR-0011 §3 as the accepted bound.

## Per-ticket Touches summary (coordinator batching)

| Ticket | Touches (disjoint except `wire.ts` blocks + e5-plan reg lines)                                                                                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #101   | `adapters/vault/src/**` only                                                                                                                                                                                                                                        |
| #102   | `application/src/crawl/{StartCrawlRun.ts, collaborators.ts, twofa/**}` · `api/src/composition-root/wire.ts` (one block)                                                                                                                                             |
| #103   | `application/src/crawl/twofa/{InteractiveBoundaryResolver, OperatorResponseChannel}` · `api/src/routes/prompt.ts` (new) + 2 reg lines · `api/wire.ts` (terminal swap) · `web/src/{model/api/prompt.ts, features/prompt/, ApiClient.ts +1, features/live +1 import}` |
