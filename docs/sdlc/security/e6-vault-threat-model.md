# Threat Model — E6: Encrypted credential vault + 2FA pause-and-ask (epic #6)

Status: pre-implementation (written before #101/#102/#103 build). Tickets: **#101** (E6.1 vault at rest),
**#102** (E6.2 autonomous reuse / typing path), **#103** (E6.3 pause-and-ask prompt loop).
Sources: `PRD-e6-credential-vault.md`, `CredentialVaultPort`, `CredentialRedactor`, `StartCrawlRun.checkCredentialBoundary`,
E5 dashboard TM (T3/T4/T12), E7 run-store TM (NFR4: run DB is never a credential store), ADR-0010 (SSE contract).
**Store-shape-agnostic** where ADR-0011 (key handling / at-rest store shape / operator-response port) is still open —
conditional MUSTs are marked _(if file-based …)_ / _(if SQLite …)_.

This epic is the **first place FlowScout holds real (test-account) secret material at rest and moves it end-to-end**:
env-sourced key → AES-256-GCM ciphertext on the developer's disk → transient plaintext in memory → `driver.typeText`
into the simulator → (E6.3) an inbound localhost POST carrying an operator-typed value. Every earlier epic's job was to
leave _clean sinks_ (redaction boundary, no secrets in logs/screenshots/argv) so E6 can carry secrets through them
safely. E6 must both **preserve** those invariants and **add** the at-rest + transport controls below.

---

## Assets

| ID  | Asset                                                                                                        | Why it matters                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | **Vault ciphertext store** (file or SQLite blob, per ADR-0011) + its nonce/tag metadata                      | The durable secret-at-rest. Confidentiality (contents), integrity (GCM tag), placement (never repo/git, never world-readable), and separation from the E7 run DB.       |
| A2  | **`FLOWSCOUT_VAULT_KEY`** (AES-256 master key, env-sourced)                                                  | Compromise = full vault decrypt. Must never reach code/repo/logs/argv/error text or a default.                                                                          |
| A3  | **Transient plaintext** — `PlaintextCredential` (username/password/otpSeed) and operator-typed OTP in memory | Exists only at use time; leaks via error messages, stack traces, long-lived buffers, or heap dumps.                                                                     |
| A4  | **The typed value in transit** through `driver.typeText` into the simulator                                  | Real plaintext crosses the redaction boundary here by design — the recorded/graph/event form must be redacted; the live typed form must not be logged or screenshotted. |
| A5  | **Operator-response payload** (#103) — credential/OTP submitted via localhost POST                           | New inbound network-borne secret; must not enter URL/query, log line, SSE relay, or error envelope.                                                                     |
| A6  | **Pending-prompt registry** (#103) — in-memory map of paused runs awaiting input                             | If it caches the submitted secret or outlives the resume, it becomes an unmanaged plaintext store.                                                                      |
| A7  | **OTP one-time values**                                                                                      | Owner ruling: never persisted anywhere (vault included) — prompt-only.                                                                                                  |

---

## Trust boundaries

```
 TB-KEY   process env ─► resolved vault key (composition root)          (T2)
          key never defaulted, never logged, never written to disk in cleartext

 TB-REST  transient plaintext ─[AES-256-GCM encrypt]─► A1 ciphertext store   (T1/T3/T4/T5/T6)
          adapters/vault  ·  file 0600 / dir 0700, outside repo, separate from E7 run DB

 TB-MEM   ciphertext ─[decrypt]─► transient plaintext (bounded lifetime)      (T7/T8)
          best-effort zeroize; never into error/stack/log

 TB-RED   real plaintext ─► driver.typeText(udid, text) ─► simulator          (T9/T10)
          |  recorded/graph/event/report form = redacted (CredentialRedactor, E2 invariant)
          |  no screenshot captured across the credential-typing window

 TB-NET   browser ─[localhost POST operator-response]─► api route             (T13/T14/T15/T16)
   (#103)  inherits E5 T3 (loopback bind) + T4 (Origin/Host CSRF+rebind gate); body never echoed/logged/URL'd
```

Two boundaries are **reused, not re-invented**: TB-RED is E2's single redaction boundary (`CredentialRedactor`
upstream of every sink, `redactText` on typeText payloads); TB-NET's CSRF gate is E5's T3/T4 control. E6's _new_
boundaries are TB-KEY, TB-REST, TB-MEM.

---

## Threats (STRIDE / OWASP / CWE) and mitigations

### Group 1 — Vault at rest (#101)

### T1 — Nonce/IV reuse under the same key → GCM catastrophic failure (CRITICAL)

- **Class:** Info Disclosure / Tampering. **OWASP A02 · CWE-323 (Reusing a Nonce/Key Pair in Encryption).**
- **Threat:** AES-256-GCM is a stream/CTR-mode cipher. Reusing a 96-bit nonce with the same key leaks the XOR of two
  plaintexts **and** allows forging the auth tag — it collapses both confidentiality and integrity. A fixed/zero IV,
  a counter that resets on restart, or a nonce derived from a low-entropy input all trigger this.
- **Mitigation (MUST, #101):**
  1. **Nonce is generated fresh per encryption from `crypto.randomBytes(12)`** — a unique 96-bit random nonce for
     **every** `store()` call (re-store of the same label = new nonce). **NEVER** a constant, zero, hardcoded, or
     counter-derived IV, and never reused across two ciphertexts under the same key.
  2. The nonce is stored **alongside** the ciphertext (it is not secret) and read back for decrypt — never
     re-derived from the plaintext, appId, or label.
  3. **RULING:** re-encrypting an updated credential (the #102 vault-update flow) MUST draw a new random nonce; an
     implementation that reuses the previous entry's nonce is a **CRITICAL FAIL**.
- **Owning ticket:** #101. **Gate check:** read the encrypt path — nonce = `randomBytes(12)` per call; grep for
  `Buffer.alloc`/fixed-IV/`createCipheriv(..., iv)` where `iv` is a constant or reused; a unit test asserts two
  `store()`s of the _same_ plaintext produce _different_ ciphertext+nonce.

### T2 — Master key leakage / weak-key sourcing (HIGH)

- **Class:** Info Disclosure. **OWASP A02/A05 · CWE-798 (Hardcoded Credentials), CWE-321 (Hardcoded Crypto Key),
  CWE-312 (Cleartext Storage).**
- **Threat:** the AES key ends up in source, the repo, a log line, an error message, `process.argv`, a committed
  `.env`, or is silently defaulted to a constant when the env var is missing (a default key = no encryption).
- **Mitigation (MUST, #101 — key resolution wired at composition root):**
  1. Key is sourced **only** from `FLOWSCOUT_VAULT_KEY` (env / secret store per ADR-0011), resolved once at the
     composition root and injected into `VaultAdapter` — **never** a literal in code, **never** a default/fallback value.
  2. Missing/empty/malformed key → **fail closed** with a **secret-free** error (see T3/NFR3); the vault does not
     silently operate with a degraded or absent key.
  3. Key is **validated for length** (32 bytes for AES-256; if a passphrase/hex/base64 is accepted per ADR-0011, it is
     decoded/derived to 32 bytes via a documented KDF — the raw passphrase is never used directly as the key).
  4. The key value is **never logged, never included in an error message, never written to disk in cleartext**, and
     never passed on argv.
  - _(Conditional, ADR-0011):_ if ADR-0011 picks OS-keychain over env, the same MUSTs apply to the keychain handle;
    if derived-from-passphrase, the KDF MUST be a memory-hard/standard construction (e.g. scrypt/PBKDF2 from
    `node:crypto`) with a stored random salt — the salt is not secret, the passphrase never persists.
- **Owning ticket:** #101 (+ `wire.ts`). **Gate check:** gitleaks clean on the diff; grep the adapter for any string
  literal used as a key or default; confirm the constructor throws (not defaults) on absent key; confirm no key in any
  log/error string.

### T3 — Auth-tag not verified / fail-open decrypt / missing AAD binding (HIGH)

- **Class:** Tampering / Info Disclosure. **OWASP A02/A08 · CWE-347 (Improper Verification of Cryptographic Signature),
  CWE-354 (Improper Validation of Integrity Check Value).**
- **Threat:** GCM only protects integrity if `decipher.setAuthTag(tag)` is called and the `final()` failure is allowed
  to throw. Swallowing the auth-tag exception, or not calling `setAuthTag`, returns attacker-mutated "plaintext". A
  tampered/truncated store, or a ciphertext copied between labels/apps, is then accepted as genuine.
- **Mitigation (MUST, #101):**
  1. Decrypt **always** calls `setAuthTag(storedTag)` and lets a tag-verification failure **propagate as a thrown
     error** — never caught-and-return-garbage, never return partial plaintext.
  2. **AAD binding (MUST):** bind each ciphertext to its identity by passing `appId` (and `label`) as GCM
     **additional authenticated data** (`setAAD`). This prevents a ciphertext-swap (copying app A's blob under app B's
     entry) from decrypting cleanly — it authenticates _which_ entry the blob belongs to. Decrypt supplies the same
     AAD; a mismatch fails the tag.
  3. Tag and nonce are stored per entry and length-checked before use (16-byte tag, 12-byte nonce).
- **Owning ticket:** #101. **Gate check:** read decrypt — `setAuthTag` present, no `try/catch` that converts a GCM
  failure into a value; `setAAD(appId…)` on both encrypt and decrypt; a unit test flips one ciphertext/tag byte and one
  AAD field and asserts each **throws** (maps to the PRD "tampered vault file" AC).

### T4 — Plaintext credential reaching disk (temp files / non-atomic write / swap) (HIGH)

- **Class:** Info Disclosure. **OWASP A02 · CWE-312 (Cleartext Storage), CWE-459 (Incomplete Cleanup).**
- **Threat:** NFR1 = _no plaintext on disk, ever_. Violations: writing a plaintext scratch/temp file before encrypting,
  serializing `PlaintextCredential` to a debug dump, a non-atomic write that leaves a half-written/rolled-back file, or
  logging the object.
- **Mitigation (MUST, #101):**
  1. Plaintext is encrypted **in memory**; only ciphertext+nonce+tag(+AAD-identity) are ever written. No plaintext temp
     file, no plaintext journal, no `JSON.stringify(plaintextCredential)` to any sink.
  2. _(If file-based, ADR-0011):_ writes are **atomic** — write to a temp file **in the same directory** created with
     `0600`, `fsync`, then `rename()` over the target (rename is atomic on same filesystem). No partial/plaintext window.
  3. _(If SQLite, ADR-0011):_ the vault is a **separate DB file** from the E7 run DB (E7 NFR4 — the run store must never
     hold credential material); credential columns hold **ciphertext only**; the vault DB is not attached to or joined
     with the run DB.
- **Owning ticket:** #101. **Gate check:** read the write path — no plaintext to any fs API; atomic temp+rename (file
  mode) or a distinct DB file with ciphertext-only columns (SQLite mode); confirm no plaintext in any debug/log line.

### T5 — File permissions & placement (world-readable / committed into git / co-located with run DB) (HIGH)

- **Class:** Info Disclosure. **OWASP A05 · CWE-732 (Incorrect Permission Assignment), CWE-552 (Files Accessible to
  External Parties).**
- **Threat:** a vault file under the repo tree can be `git add`-ed and pushed (leaking every stored ciphertext into
  history); a file created with default umask is readable by other local accounts; co-locating with the E7 run DB blurs
  the "run DB is never a credential store" boundary.
- **Mitigation (MUST, #101):**
  1. The vault store lives at a **configurable path outside the repo** (e.g. under the OS app-data/home dir, per
     ADR-0011), and its directory/glob is in `.gitignore`. **No `appId`/`label` spliced into the filesystem path**
     (path-traversal + leakage — reuse E7's discipline).
  2. Directory created `0700`, file created `0600` (owner-only) — or the documented OS-default rationale if the store
     mechanism enforces equivalent isolation (keychain).
  3. The vault store is **physically separate** from the E7 run DB file (distinct path); neither references the other.
- **Owning ticket:** #101. **Gate check:** confirm the path is outside the repo and gitignored; the create path sets
  0700/0600; grep that no `appId`/`label` reaches a path segment; confirm the path differs from `FLOWSCOUT_DB_PATH`.

### T6 — Deletion that doesn't actually remove ciphertext (MEDIUM)

- **Class:** Info Disclosure / Repudiation. **OWASP A02 · CWE-459 (Incomplete Cleanup), CWE-212 (Improper Removal of
  Sensitive Info).**
- **Threat:** `delete(appId, label)` that only unsets an in-memory index, or tombstones a row while leaving the
  ciphertext bytes recoverable, leaves the secret retrievable (PRD AC: after delete, retrieve returns null **and** the
  ciphertext is removed from the persisted store).
- **Mitigation (MUST, #101):** `delete` removes the entry's ciphertext from the **persisted** store (file re-written
  without the entry / row hard-deleted), then `retrieve` returns `null`. _(SHOULD)_ best-effort overwrite of the removed
  bytes before unlink where the store shape allows; acknowledge honestly that on modern SSDs/copy-on-write filesystems
  and SQLite WAL, secure-erase guarantees are limited — the primary control is encryption-at-rest (T1–T3), so a removed
  ciphertext without the key is already unreadable.
- **Owning ticket:** #101. **Gate check:** a test stores→deletes→retrieves (null) **and** asserts the ciphertext is
  absent from the persisted bytes.

### T7 — Transient-plaintext lifetime, zeroization, and secrets in errors/stack traces (MEDIUM)

- **Class:** Info Disclosure. **OWASP A02/A09 · CWE-316 (Cleartext Storage in Memory), CWE-209 (Info Exposure Through an
  Error Message).**
- **Threat:** plaintext buffers held longer than needed (module-level caches, closures, memoized decrypts) widen the
  heap-dump/coredump window; a secret interpolated into an `Error(...)` message or thrown object surfaces in stack
  traces, logs, and (via #103) error envelopes.
- **Mitigation (MUST, #101/#102):**
  1. Decrypted plaintext is held in a **narrow scope**, used, then dropped; **no long-lived plaintext cache** (NFR4).
  2. Errors and thrown objects **never interpolate** the plaintext, the key, the nonce, or the ciphertext — messages are
     structural ("decrypt failed for <appId>/<label>", identity only).
  3. **(SHOULD, best-effort — honest JS limit):** where plaintext is held in a `Buffer`, `buffer.fill(0)` after use.
     **Acknowledged limitation:** V8 may have copied the value into immutable `string`s / intermediate heap objects that
     cannot be zeroized, and GC timing is not controllable — `fill(0)` is defense-in-depth, **not** a guarantee. The
     load-bearing controls remain encryption-at-rest + bounded lifetime + no-leak-to-sinks, not memory scrubbing.
- **Owning ticket:** #101 (adapter) / #102 (crawl use-site). **Gate check:** grep for module/instance-level plaintext
  caches; confirm no secret in any `Error`/template string; note zeroization as best-effort.

### T8 — OTP one-time values / OTP seed persistence (MEDIUM→HIGH on breach)

- **Class:** Info Disclosure. **OWASP A02 · CWE-312 (Cleartext Storage).**
- **Threat:** an operator-entered **OTP code** is a one-time value; persisting it anywhere (vault, run DB, cache, log) is
  both useless and a leak (owner ruling: OTP is prompt-only, never stored). Separately, the optional `otpSeed` (TOTP
  secret) is a _long-lived_ secret — if stored (a later slice, OQ4) it MUST be encrypted like the password, never
  plaintext.
- **Mitigation (MUST):**
  1. **(#103)** An operator-entered OTP **code** is used once for the typing step and is **NEVER** written to the vault,
     run DB, or any store (PRD FR6; AC: a later vault list shows no OTP entry).
  2. **(#101)** If `otpSeed` is present it round-trips **encrypted** exactly like `encryptedPassword` (same T1–T3
     controls); it is never persisted in plaintext. Autonomous TOTP generation from the seed is out of scope (OQ4) — MVP
     OTP is prompt-only.
- **Owning ticket:** #103 (one-time code) / #101 (seed storage). **Gate check:** confirm no code path writes the OTP code
  to any store; seed persistence uses the encrypt path; a test asserts OTP absence from vault + run DB after use.

### Group 2 — The typing / reuse path (#102)

### T9 — Vaulted plaintext leaking into graph / events / logs / report via the typing path (HIGH)

- **Class:** Info Disclosure. **OWASP A09/A02 · CWE-532 (Info Exposure Through Log Files), CWE-312.**
- **Threat:** #102 introduces a _real_ plaintext into the loop (`driver.typeText(udid, vaultedPassword)`). The recorded
  action, the state edge `actionPayload`, the `ActionTakenEvent`, the decision-context snapshot reaching the LLM, and
  the E7-persisted graph must all carry the **redacted** form — a regression that records the raw typed text leaks it
  to every downstream sink at once. This is the E2 single-redaction-boundary invariant applied to a vault-sourced value.
- **Mitigation (MUST, #102 — preserve the existing invariant):**
  1. The typed value is passed **real** to `driver.typeText` but the recorded action goes through
     `redactor.redactText(...)` before any edge/event/graph write — exactly the existing E2.7 path
     (`StartCrawlRun` line ~316). E6 adds a vault source; it does **not** add a new sink and **does not** bypass or move
     the redaction boundary.
  2. The `credential:prompt` event and any pause/resume event carry **no** field value — descriptors only (`promptType`,
     `stateId`, redacted message), per the existing `checkCredentialBoundary` shape.
  3. **RULING (redaction-coverage caveat):** `CredentialRedactor.redactText` reliably redacts **OTP-shaped** (4–8 digit)
     values but a free-form **password** is NOT digit-shaped and is passed through by `redactText`. Therefore the
     password must **never be routed through the recorded-action text at all** — the redaction that keeps a password out
     of the graph is the **secure-field / secure-node structural redaction on the snapshot** (`isSecureNode`), not
     `redactText`. #102 MUST confirm the typed password's on-screen reflection lands in a secure-entry node (so
     `redact()` masks it) and MUST NOT log/record the raw typed string on the typeText path. Flag to the developer:
     do not rely on `redactText` alone to scrub a password.
- **Owning ticket:** #102. **Gate check:** confirm redaction stays upstream of all sinks (E2 invariant intact); a test
  types a known vault password and asserts it is absent from events, edges, graph, logs, **and** the captured LLM
  payload (closes the E2 assertion gap noted in memory for this new source).

### T10 — Screenshot captured across the credential-typing window (MEDIUM→HIGH if screenshots ship)

- **Class:** Info Disclosure. **OWASP A02 · CWE-200 (Exposure of Sensitive Info), CWE-312.**
- **Threat:** a raw screenshot PNG is **not** covered by the a11y redactor. A screenshot taken immediately after
  `typeText` into a credential field can capture the secret — password fields render masked dots, but **username/email
  fields render plaintext**, and some apps have a "reveal password" toggle or briefly echo the last-typed character.
  The `MobileDriverPort.screenshot()` capability exists and `screenshotUri` is a reserved field; if a future slice
  captures screenshots per step this becomes a live secret-at-rest leak.
- **Mitigation (MUST, #102 — screenshot policy around the credential boundary):**
  1. **RULING — no screenshot across the credential-typing window.** From the moment a credential boundary is detected
     (`checkCredentialBoundary` true) through the type-and-submit of the credential/OTP and the immediate post-submit
     transition, **no screenshot is captured, stored, or referenced** (`screenshotUri` stays `null` across that window).
     This holds for both the autonomous (#102) and interactive (#103) paths.
  2. If a screenshot capability is later enabled for the crawl, the credential-window suppression above is a **hard gate**
     — screenshots resume only once the loop is past the credential surface and on a non-secure state.
  3. Rationale: the a11y redactor cannot scrub a rasterized secret; the only safe control is **not capturing** across the
     window. Current code already sets `screenshotUri: null`, so #102 must not regress this at the credential boundary.
- **Owning ticket:** #102 (+ inherited by #103). **Gate check:** confirm no `driver.screenshot(...)` call sits between
  boundary-detection and post-submit; `screenshotUri` remains null across the credential window; a test asserts no
  screenshot artifact references a credential state.

### T11 — Unbounded retry with a wrong/stale credential → infinite typing loop / account lockout (MEDIUM)

- **Class:** Denial of Service / Repudiation. **OWASP A04 · CWE-307 (Improper Restriction of Excessive Auth Attempts),
  CWE-834 (Excessive Iteration).**
- **Threat:** if a vaulted credential is wrong/stale, the app stays on / returns to the credential surface. A loop that
  re-resolves the same failing credential and re-types it forever burns budget and can **lock the test account** at the
  app's own rate limiter (an app-side rejection loop we do not control).
- **Mitigation (MUST, #102):**
  1. The credential-typing retry is **bounded** — after N (small, e.g. 1–2) failed attempts with the same vault entry at
     the same boundary, the crawl **stops retrying**, ends `partial`/`blocked-on-2fa` with a **secret-free** reason, and
     does **not** re-type the known-bad credential unbounded (PRD edge case + #102 AC).
  2. Detection of "still on a credential surface after typing" reuses the structural `CredentialBoundaryDetector` — no
     value-reading to decide failure.
- **Owning ticket:** #102. **Gate check:** a test with a rejecting fake app asserts the loop stops after the bound and
  terminates with a redacted reason; confirm no unbounded `while` around the type-credential step.

### T12 — Vault-update / overwrite flow (stale entry, silent partial overwrite) (LOW→MEDIUM)

- **Class:** Integrity. **OWASP A08 · CWE-345 (Insufficient Verification of Data Authenticity).**
- **Threat:** updating a stored credential (new password after rotation) must fully replace the entry under a **new
  nonce** (T1) and not leave a mix of old+new fields or a second stale ciphertext for the same appId+label.
- **Mitigation (SHOULD, #102/#101):** `store()` for an existing appId+label is a full overwrite (single entry per key)
  with a fresh nonce and re-encrypted payload; no orphaned prior ciphertext remains readable. Ties to T1's new-nonce ruling.
- **Owning ticket:** #101 (store semantics) / #102 (update trigger). **Gate check:** a test overwrites a label and asserts
  a single current entry, new nonce, old plaintext no longer retrievable.

### Group 3 — The pause-and-ask prompt loop (#103)

### T13 — Drive-by CSRF against the operator-response route (HIGH)

- **Class:** CSRF. **OWASP A01/A05 · CWE-352 (CSRF), CWE-350 (Untrusted DNS), CWE-1385 (Missing Origin Validation).**
- **Threat:** #103's inbound operator-response endpoint is a **new state-changing localhost POST** — any web page the
  operator has open can `fetch('http://localhost:<port>/…', {method:'POST'})` to inject a bogus credential/OTP into a
  paused run, or DNS-rebind to bypass a naive Host check (E5's classic localhost-API attack, restated for this route).
- **Mitigation (MUST, #103 — inherit the E5 T4 gate for THIS route specifically):**
  1. The operator-response route **enforces the E5 Origin/Referer allowlist** (dashboard origin only) **and** the
     **loopback `Host`-header check** (anti-DNS-rebind) — it is not exempt from the gate just because it is an E6 route.
  2. The listener is **loopback-bound only** (E5 T3) — inherited, not re-opened.
  3. **CORS stays closed** (no wildcard, no credentialed wildcard) — inherited from E5 M93.4.
- **Owning ticket:** #103. **Gate check:** a test hits the operator-response route with a foreign `Origin` and an
  attacker `Host` and asserts **rejection**; confirm the route registers under the same Origin/Host middleware as the
  other write routes (not bypassed).

### T14 — Submitted secret echoed back in response body / SSE / logs / error envelope / URL (HIGH)

- **Class:** Info Disclosure. **OWASP A09/A02 · CWE-598 (Info Exposure via Query String), CWE-532 (Log Files),
  CWE-209 (Error Message).**
- **Threat:** the operator's typed credential/OTP travels the inbound write path. It must not be reflected back in the
  POST response body, re-broadcast on the SSE stream, written to a log line, placed in a URL/query string, or leaked in
  an error envelope on a validation/processing failure.
- **Mitigation (MUST, #103 — restate E5 T12 for the inbound value):**
  1. The submitted value travels in the **POST body only** — **never** a query string / URL path segment
     (no-secret-in-URL, CWE-598).
  2. The response is an **acknowledgement only** (status / run-state) — it **never echoes** the submitted value.
  3. The value is **never logged** (no request-body logging on this route) and **never re-emitted on the SSE relay** —
     `credential:prompt`/pause/resume events carry descriptors only (T15). Error envelopes on this route are
     **structural** — they never include the submitted value or a decrypt/typing exception carrying it.
- **Owning ticket:** #103. **Gate check:** a test submits a known value and asserts it is absent from the response body,
  the SSE stream, all logs, and any error response; confirm no request-body logging middleware covers this route.

### T15 — Prompt event carrying secret material outbound (MEDIUM)

- **Class:** Info Disclosure. **OWASP A02 · CWE-200.**
- **Threat:** the outbound `credential:prompt` (and pause/resume) events flow to the browser over SSE; if they carry any
  app field value or the pending secret, they leak it to the dashboard surface (and E4/E5 render sinks).
- **Mitigation (MUST, #103):** prompt/pause/resume events carry **only field descriptors** — `promptType`
  (`username`|`password`|`2fa-otp`), `stateId`, a redacted non-sensitive `message`, timestamp — **never** an app field
  value and **never** the value the operator will/did submit. (Existing `checkCredentialBoundary` already emits this
  shape; #103 must not enrich it with values.)
- **Owning ticket:** #103. **Gate check:** confirm the event shape carries no value field; the dashboard prompt UI shows
  `promptType`+redacted message only (PRD UX note), never app field values.

### T16 — Pending-prompt registry: plaintext persistence / stale retention (MEDIUM)

- **Class:** Info Disclosure. **OWASP A02 · CWE-312, CWE-459 (Incomplete Cleanup).**
- **Threat:** the map/registry that tracks paused runs awaiting input (the OperatorResponsePort backing per OQ3) could
  cache the submitted secret and outlive the resume, or persist to disk, becoming an unmanaged plaintext store.
- **Mitigation (MUST, #103):**
  1. The pending-prompt registry is **memory-only** (in-process; never written to the run DB, the vault, or any file).
  2. The submitted value lives in the registry only for the **narrow window** between receipt and typing; the entry is
     **cleared on resume, on timeout, and on cancel** (all three PRD termination paths) — no stale secret retained.
  3. On timeout/cancel the run ends `partial`/`blocked-on-2fa` with a redacted reason and **stores nothing** (unless the
     non-OTP "remember" opt-in fired first — T-persist, below).
  - _(Conditional, ADR-0011 operator-response port):_ whatever mechanism ADR-0011 picks (in-process bus / port impl),
    it MUST NOT serialize the pending value to a durable sink.
- **Owning ticket:** #103. **Gate check:** confirm the registry is in-memory; tests for resume/timeout/cancel each assert
  the entry (and its value) is cleared; confirm no persistence of the pending value.

### T17 — Repeated wrong OTP/credential at the prompt → app-side lockout / re-prompt storm (LOW→MEDIUM)

- **Class:** Denial of Service. **OWASP A04 · CWE-307.**
- **Threat:** repeated wrong operator submissions re-type into the app and can trip the app's own lockout on the test
  account; an unbounded re-prompt loop also wedges the run.
- **Mitigation (SHOULD, #103):** re-prompts on repeated app rejection are **bounded** (reuse the T11 bound); after the
  bound the run ends `partial`/`blocked-on-2fa` with a redacted reason rather than re-prompting indefinitely. This is an
  app-side rejection loop we do not control — the control is our re-prompt bound, not the app's limiter.
- **Owning ticket:** #103. **Gate check:** a test with repeated rejects asserts bounded re-prompts then graceful partial.

### T-persist — Optional "remember" persistence path (#103 → #101 store) (MEDIUM)

- **Class:** Info Disclosure. **OWASP A02 · CWE-312.**
- **Threat:** FR7 lets a **non-OTP** credential be persisted for reuse. This path must (a) route only through the #101
  encrypt path (never a plaintext write), (b) **never** fire for an OTP prompt, and (c) persist only on explicit opt-in.
- **Mitigation (MUST, #103):**
  1. "Remember" persistence calls `CredentialVaultPort.store(...)` (T1–T5 controls) — no side-channel plaintext write.
  2. The "remember" affordance is **absent** on `2fa-otp` prompts; an OTP value can never reach `store()` (T8).
  3. Persist happens **only** on explicit operator opt-in; "not selected" = used-for-this-run-only, nothing persisted.
- **Owning ticket:** #103. **Gate check:** a test asserts opt-in persists via the vault encrypt path; OTP prompt offers
  no remember + never persists; opt-out persists nothing.

### Group 4 — Cross-cutting (mandated automation)

### T18 — Test fixtures tripping gitleaks / a new crypto dependency (MEDIUM)

- **Class:** Supply chain / Secret hygiene. **OWASP A05/A06 · CWE-798, CWE-1104 (Unmaintained Third-Party Components).**
- **Threat:** vault tests need realistic credential/key/nonce fixtures; hardcoding a plausible secret trips gitleaks and
  risks a real-looking value in history. Separately, reaching for a third-party crypto/2FA library (e.g. an AES wrapper
  or TOTP lib) adds an unvetted dependency to the most sensitive code in the product.
- **Mitigation (MUST):**
  1. **Test secrets are runtime-constructed** (generated in-test via `randomBytes`/fixture builders), **never**
     hardcoded literals — the established FlowScout pattern; keeps gitleaks clean.
  2. **`node:crypto` only** for AES-256-GCM and any KDF (scrypt/PBKDF2) — **no new crypto/2FA dependency**. Any proposed
     crypto or TOTP dependency is a **MUST-justify**: flag it at the gate, require SCA (`pnpm audit --prod`, High/Critical
     fails) + an exact version pin + an explicit security sign-off before it lands. Prefer `node:crypto` TOTP-from-seed
     (HMAC) over a library if OQ4 ever ships.
- **Owning ticket:** #101/#102/#103. **Gate check:** gitleaks clean; grep for hardcoded key/nonce/password literals in
  tests; confirm `packages/adapters/vault/package.json` adds **no** runtime crypto dep (node:crypto only) — flag any.

---

## Threat → ticket summary

| T         | Threat                                                | Sev      | OWASP / CWE                | Owning ticket |
| --------- | ----------------------------------------------------- | -------- | -------------------------- | ------------- |
| T1        | Nonce/IV reuse under same key (GCM)                   | CRITICAL | A02 / CWE-323              | #101          |
| T2        | Master key leakage / weak-key sourcing                | HIGH     | A02,A05 / CWE-798,321,312  | #101 (+wire)  |
| T3        | Auth-tag not verified / no AAD binding                | HIGH     | A02,A08 / CWE-347,354      | #101          |
| T4        | Plaintext to disk (temp/non-atomic)                   | HIGH     | A02 / CWE-312,459          | #101          |
| T5        | File perms / placement / git / co-located w/ run DB   | HIGH     | A05 / CWE-732,552          | #101          |
| T6        | Deletion doesn't remove ciphertext                    | MEDIUM   | A02 / CWE-459,212          | #101          |
| T7        | Plaintext lifetime / zeroize / secret in error+stack  | MEDIUM   | A02,A09 / CWE-316,209      | #101/#102     |
| T8        | OTP one-time value / seed persistence                 | MED→HIGH | A02 / CWE-312              | #103/#101     |
| T9        | Vaulted plaintext leaking via typing path             | HIGH     | A09,A02 / CWE-532,312      | #102          |
| T10       | Screenshot across credential-typing window            | MED→HIGH | A02 / CWE-200,312          | #102          |
| T11       | Unbounded wrong-credential retry / lockout            | MEDIUM   | A04 / CWE-307,834          | #102          |
| T12       | Vault-update / overwrite (stale entry)                | LOW→MED  | A08 / CWE-345              | #101/#102     |
| T13       | CSRF on operator-response route                       | HIGH     | A01,A05 / CWE-352,350,1385 | #103          |
| T14       | Submitted secret echoed to body/SSE/log/URL/error     | HIGH     | A09,A02 / CWE-598,532,209  | #103          |
| T15       | Prompt event carrying secret outbound                 | MEDIUM   | A02 / CWE-200              | #103          |
| T16       | Pending-prompt registry persistence / stale retention | MEDIUM   | A02 / CWE-312,459          | #103          |
| T17       | Repeated wrong OTP/cred → lockout / re-prompt storm   | LOW→MED  | A04 / CWE-307              | #103          |
| T-persist | Optional "remember" persistence path                  | MEDIUM   | A02 / CWE-312              | #103          |
| T18       | Test fixtures trip gitleaks / new crypto dep          | MEDIUM   | A05,A06 / CWE-798,1104     | all           |

## Per-ticket security requirements (verbatim MUST lists — commented onto each ticket)

### #101 — Encrypted vault at rest (MUST)

- M1 (T1) Fresh `crypto.randomBytes(12)` nonce **per encryption** — never constant/zero/counter/reused; re-store = new nonce.
- M2 (T2) Key **only** from `FLOWSCOUT_VAULT_KEY` (ADR-0011), injected at composition root; no literal, no default; fail closed on missing.
- M3 (T2) Key length-validated to 32 bytes (or documented KDF from passphrase); key never logged / in error / on argv / on disk cleartext.
- M4 (T3) Decrypt calls `setAuthTag` and lets tag failure **throw**; no catch-return-garbage; no partial plaintext.
- M5 (T3) **AAD-bind** ciphertext to `appId`(+`label`) via `setAAD` on encrypt+decrypt (defeats cross-entry ciphertext swap).
- M6 (T4) Only ciphertext+nonce+tag written; no plaintext temp/journal/dump; _(file-based)_ atomic temp+`0600`+fsync+rename; _(SQLite)_ separate DB, ciphertext-only columns.
- M7 (T5) Store path **outside repo** + gitignored; dir `0700`/file `0600`; **no `appId`/`label` in any path segment**; **separate file from the E7 run DB**.
- M8 (T6) `delete` removes ciphertext from the persisted store (retrieve→null after); best-effort overwrite where the store allows.
- M9 (T7) No long-lived plaintext cache; errors are structural (identity only), never carry secret/key/nonce/ciphertext; best-effort `Buffer.fill(0)` (honest JS limit).
- M10 (T8/T12) `otpSeed` round-trips **encrypted** like the password; `store` for an existing appId+label is a full overwrite under a new nonce.
- M11 (T18) Test key/nonce/credential fixtures **runtime-constructed**, never hardcoded; **`node:crypto` only** — no new runtime crypto dep (any dep = MUST-justify).

### #102 — Autonomous reuse / typing path (MUST)

- M12 (T9) Preserve the E2 single-redaction boundary: typed value real to `driver.typeText`, recorded action redacted **before** any edge/event/graph/LLM sink; E6 adds a source, not a sink, and does not move the boundary.
- M13 (T9) Password (non-digit) MUST NOT be relied on being scrubbed by `redactText`; keep the raw typed password out of any recorded/logged string — structural secure-field redaction on the snapshot is the graph control.
- M14 (T10) **No screenshot captured/stored/referenced across the credential-typing window** (detection → type → immediate post-submit); `screenshotUri` stays null there.
- M15 (T11) **Bounded** wrong-credential retry — do not re-type a known-bad vault entry unbounded; end `partial`/`blocked-on-2fa` with a secret-free reason after the bound.
- M16 (T7) Decrypted plaintext held in narrow scope at the use-site; dropped after typing; no secret in crawl logs/events/errors.
- M17 (verify) Assert the typed vault password is absent from events, edges, graph, logs, **and** the captured LLM payload (closes the E2 assertion gap for this new source).

### #103 — Pause-and-ask prompt loop (MUST)

- M18 (T13) Operator-response route enforces the **E5 T4 Origin/Referer allowlist + loopback Host check**, loopback-bound (T3), CORS closed — not exempt as an E6 route.
- M19 (T14) Submitted secret travels in the **POST body only** (never URL/query); response is ack-only (never echoes value); never logged; never re-emitted on SSE; error envelopes structural (no value).
- M20 (T15) Prompt/pause/resume events carry **descriptors only** (`promptType`, `stateId`, redacted message) — never an app field value or the submitted secret.
- M21 (T16) Pending-prompt registry is **memory-only**; the submitted value is cleared on **resume, timeout, and cancel**; never persisted to run DB / vault / file.
- M22 (T8) An operator-entered **OTP code is used once, never persisted** anywhere (vault/run DB/cache/log); a later vault list shows no OTP entry.
- M23 (T-persist) "Remember" persists a **non-OTP** credential only, **only** via the #101 encrypt path, **only** on explicit opt-in; the remember affordance is absent on OTP prompts; opt-out persists nothing.
- M24 (T14/T10) No request-body logging on this route; no screenshot across the interactive credential window (inherits M14).
- M25 (T17) Bounded re-prompts on repeated app rejection; then graceful `partial`/`blocked-on-2fa` with a redacted reason.

---

## Key rulings (called out)

- **Nonce (T1):** fresh `randomBytes(12)` per encryption, stored alongside ciphertext, never reused with the same key,
  **new nonce on every re-store/update**. Nonce reuse under the same key = **CRITICAL FAIL** (not a Medium note).
- **Key (T2):** env-sourced (`FLOWSCOUT_VAULT_KEY` / ADR-0011 store), **no default ever** — a defaulted key is "no
  encryption" and fails the gate. Fail closed on missing/empty/wrong; secret-free errors; 32-byte validated.
- **AAD (T3):** bind ciphertext to `appId`(+`label`) so a copied blob can't decrypt under another entry. MUST, not SHOULD.
- **Screenshot-near-boundary (T10):** **no screenshot is captured, stored, or referenced across the credential-typing
  window** (detection → type/submit → immediate post-submit) on both the autonomous and interactive paths — the a11y
  redactor cannot scrub a rasterized secret (usernames render plaintext; reveal-toggles exist), so the only safe control
  is not capturing. `screenshotUri` stays null there. Hard gate if screenshots ever ship for the crawl.
- **OTP (T8):** one-time codes **never persisted anywhere** (owner ruling); the TOTP `otpSeed`, if stored, is encrypted
  like the password. Autonomous TOTP-from-seed is out of MVP scope (OQ4).
- **redactText caveat (T9):** `redactText` reliably masks OTP-shaped digits but passes through free-form passwords; the
  graph-level password control is **structural secure-field redaction on the snapshot**, not `redactText`. Flagged to devs.

## Gate verification method (E6 security gate, per ticket, post-impl)

- **Verdict policy:** Critical/High unmet → **FAIL** (block, route to developer). HIGH+CRITICAL controls: **T1** (nonce),
  **T2** (key), **T3** (auth-tag+AAD), **T4** (no plaintext disk), **T5** (perms/placement), **T9** (typing-path
  redaction), **T13** (CSRF gate), **T14** (secret echo). Medium → must-fix or tracked follow-up + PASS-with-conditions
  (never silently dropped). Low → note.
- **Scans (mandated, must have run — else BLOCKED):** gitleaks (any finding fails; test fixtures runtime-constructed),
  SCA `pnpm audit --audit-level=high --prod` (High/Critical in prod tree fails; a new crypto dep is MUST-justify),
  SAST typescript-eslint + `eslint-plugin-security`. Mind CI scan ordering — an early Lint/Format failure can abort the
  job before gitleaks/SAST run → diff unscanned → **BLOCKED** (do not PASS an unscanned diff).
- **Evidence per ticket:** read the actual encrypt/decrypt/write/delete code (not just tests); confirm the unit tests
  named in each T's gate-check exist and assert the invariant; confirm no key/secret in any log/error string; confirm
  the vault path is outside-repo + gitignored + separate from `FLOWSCOUT_DB_PATH`.

## Handoffs flagged

- **→ E5 (#93/#94 owner, restated as MUST for #103's route):** the operator-response endpoint is a **new
  state-changing localhost route** and MUST register under the **existing E5 T3/T4 Origin+Host CSRF+rebind gate** (not a
  bypass) and the **T12 no-secret-in-URL/log** invariant. The submitted credential/OTP must **never** enter a query
  string, a log line, or the SSE relay. (Matches the E5 TM's own "→ E6 flag".)
- **→ E2 (#37 redaction boundary owner):** #102 adds a **vault-sourced real plaintext** to the typing path — the single
  redaction boundary + detect-before-decide invariants MUST hold unchanged; and the new source is the occasion to
  **close the known E2 assertion gap** (assert the typed secret absent from the **captured LLM payload**, not just
  events+graph). Note the `redactText` password caveat (T9): structural secure-field redaction is the password control.
- **→ E7 (#83 run-store owner):** reaffirm NFR4 — the run DB **never** stores credential/OTP material; the vault is a
  **separate file** (T4/T5). E7's defense-in-depth save-time "no credential marker" assert is the backstop if a typed
  secret ever slips into the persisted graph.
- **→ Architect (ADR-0011, concurrent):** this TM is store-shape-agnostic where marked. When ADR-0011 lands (key
  handling / at-rest store shape / operator-response port), the conditional MUSTs (T2 keychain/KDF, T4 file-vs-SQLite,
  T16 operator-response mechanism) resolve to their chosen branch — re-verify at the #101/#103 gates.
