# ADR-0011 — E6: Encrypted credential vault + 2FA pause-and-ask

- **Status:** accepted (design-time, epic #6 — tickets #101 / #102 / #103)
- **Inputs (binding):** `docs/sdlc/prd/PRD-e6-credential-vault.md` · `CredentialVaultPort`
  (`packages/domain/src/ports/CredentialVaultPort.ts`) · `CredentialPromptEvent`
  (`packages/domain/src/ports/CrawlEventStream.ts`) · `StartCrawlRun.checkCredentialBoundary` +
  `CredentialBoundaryDetector` + `CredentialRedactor` (#37 lineage, ADR-0004) · ADR-0008 (run store — MUST NOT
  hold credentials) · ADR-0010 + `e5-plan.md` (D5 routes/envelope/origin-gate, #94 verbatim-SSE E6 seam).
- **Owner rulings (binding, recorded here, not reopened):** MVP OTP is **interactive prompt only** — no TOTP
  generation from a stored seed (PRD OQ4). **No credential-management UI** in MVP — vault entry happens via the
  pause-and-ask "remember" path only (PRD OQ5).
- Companion plan: `docs/sdlc/architecture/e6-plan.md` (per-ticket work breakdown).

## 1. Context

The crawl today detects a credential/2FA surface structurally (redacted snapshot, T8), emits
`credential:prompt`, and terminates `blocked-on-2fa`
(`packages/application/src/crawl/StartCrawlRun.ts` — `checkCredentialBoundary`). The vault adapter is a
throwing stub (`packages/adapters/vault/src/VaultAdapter.ts`). E6 must (a) implement the encrypted vault
(#101), (b) let the crawl authenticate autonomously from the vault and continue (#102), and (c) pause, prompt
the operator via the dashboard, and resume on response (#103) — with secrets never reaching the graph,
events, logs, report, or run DB (NFR1/NFR2). The E5 dashboard surface (ADR-0010) is in flight and was
designed with a verbatim-SSE passthrough precisely so `credential:prompt` reaches the client unchanged; E6
must plug into it **additively** (new route file + registration lines), not respec it.

Three open questions were delegated to this ADR: OQ1 key handling, OQ2 at-rest store shape, OQ3 the inbound
operator-response mechanism. A fourth ruling is needed on pause semantics (budgets/timeouts while paused).

## 2. Decision — OQ1: key handling = env master secret + scrypt KDF (node:crypto only)

**Ruling.** The vault master secret comes from **`FLOWSCOUT_VAULT_KEY`** (env only — never committed, never
defaulted, per FR2). The AES-256 key is **derived** from it with **scrypt** (`node:crypto.scryptSync` —
zero new dependencies; argon2 would be a native dep, rejected under T13/supply-chain) using a **per-vault
random 16-byte salt** stored in the vault-file header. Named KDF constants (no magic values):
`SCRYPT_N = 16384`, `SCRYPT_R = 8`, `SCRYPT_P = 1`, `KEY_LENGTH_BYTES = 32`, `SALT_LENGTH_BYTES = 16`.

- Deriving (rather than requiring a raw 32-byte hex key) means the env value may be a human passphrase **or**
  a high-entropy secret — uniform handling, no format validation failure modes, and brute-force cost on a
  stolen vault file is scrypt-bound.
- **Fail closed (NFR3):** missing/empty `FLOWSCOUT_VAULT_KEY` ⇒ every vault operation rejects with a typed,
  secret-free `VaultKeyMissingError`. A wrong key surfaces as a GCM auth-tag failure ⇒ typed
  `VaultIntegrityError`. Plaintext is never partially returned; the key never appears in any error/log.
- **Lazy resolution:** the adapter receives a `VaultKeySource` (`() => string | null`) at construction; the
  key is read/derived on first use, so the API boots without a vault key configured (the Dime demo path has
  no login — E6 must not make the key a boot requirement).
- **Upgrade path (recorded, not built — YAGNI):** macOS-Keychain or passphrase-prompt sourcing later replaces
  only the injected `VaultKeySource`; file format and adapter logic are untouched. Rejected for MVP: Keychain
  needs a native dep or `security`-CLI shelling — cost without single-machine benefit.

## 3. Decision — OQ2: at-rest shape = one encrypted JSON file, separate from the run DB

**Ruling.** A **single JSON file** at **`FLOWSCOUT_VAULT_PATH`** (default `./.flowscout/vault.json`,
sibling of ADR-0008's default DB — but **never** inside it; security ruled the run DB is not a credential
store, restated as NFR2). **Not** a second SQLite database: the vault holds a handful of entries, needs no
queries/joins/migration machinery, and a file keeps the security review surface one page. Format `v1`:

```
{ "version": 1,
  "kdf": { "algo": "scrypt", "n": 16384, "r": 8, "p": 1, "salt": "<base64>" },
  "entries": [ { "appId": "...", "label": "...", "iv": "<base64,12B>",
                 "authTag": "<base64,16B>", "ciphertext": "<base64>" } ] }
```

- **Whole-entry encryption:** the ciphertext is one AES-256-GCM blob over the JSON of
  `{username, password, otpSeed}` — the username is encrypted too (usernames are routinely emails/PII;
  the port's `AppCredential` plaintext-username shape is a domain description, not the at-rest format —
  the adapter owns its record shape, `CredentialVaultPort` is unchanged). Plaintext on disk is only:
  `appId`, `label` (non-secret lookup keys — `listLabels` needs no decryption), IV, tag, KDF header.
- **AAD binding:** GCM AAD = `"<appId>\n<label>\nv1"` — a ciphertext copied between entries or a
  renamed entry fails authentication (swap/tamper resistance beyond FR2's letter).
- **Deterministic + atomic (0600):** stable key order and entries sorted by (`appId`,`label`) ⇒ reproducible
  bytes; writes go to `<path>.tmp` (mode `0600`) then `rename()` — no torn vault on crash; parent dir created
  `0700`. Fresh random IV per encryption (never reused per NIST GCM discipline).
- **Tamper (NFR3):** any bit-flip in ciphertext/tag/AAD inputs ⇒ auth-tag failure ⇒ `VaultIntegrityError`,
  never garbage plaintext. Unknown `version` ⇒ fail closed.
- **Memory hygiene (NFR4, best-effort):** derived key + intermediate plaintext held in `Buffer`s and
  `fill(0)`-ed after use where the API allows; JS strings handed to callers cannot be zeroized — recorded as
  the accepted best-effort bound.

## 4. Decision — OQ3: boundary-resolution seam = resolver chain + in-process operator-response channel

**Ruling.** `StartCrawlRun.checkCredentialBoundary` is refactored **once** (in #102) to delegate the
post-detection policy to an injected **`CredentialBoundaryResolver`** — a **Chain of Responsibility**
(applied by name) carried as a new **optional** collaborator on `CrawlCollaborators` (additive-only, per the
ADR-0004 §7.2 precedent: constructor and `defaultCollaborators({stateGraphRepository, crawlEventStream})`
unchanged; the default resolver reproduces today's emit-prompt-and-stop behaviour exactly, so all existing
shell tests pass untouched). #103 then changes **wiring only** — it swaps the chain's terminal element; it
does **not** edit `StartCrawlRun` again. One refactor, two consumers.

**Contract** (application layer, `packages/application/src/crawl/twofa/`):

```ts
interface CredentialBoundaryContext {
  runId;
  appId;
  stateId;
  promptType; // from detector
  usernameFieldId?;
  secureFieldId?;
  otpFieldId?;
  submitElementId?; // additive detector extension (#102)
}
type BoundaryResolution =
  | {
      kind: "fill";
      fields: readonly { elementId?: string; value: string }[];
      submitElementId?: string;
    }
  | { kind: "stop"; termination: "blocked-on-2fa" | "partial" };
interface CredentialBoundaryResolver {
  resolve(ctx): Promise<BoundaryResolution>;
}
```

**Chain elements:**

- `PromptAndStopResolver` (default, lands with the #102 refactor): publishes `credential:prompt`, returns
  `stop/blocked-on-2fa` — byte-for-byte today's behaviour.
- `VaultBoundaryResolver(next)` (#102): username/password boundaries → `vault.retrieve(appId, label)` (label
  = `DEFAULT_CREDENTIAL_LABEL = "default"`, falling back to the first `listLabels` entry) → `fill`.
  `2fa-otp` **always** passes to `next` (owner ruling: no TOTP autonomy). Vault miss, missing key, or
  exhausted attempts (`MAX_VAULT_FILL_ATTEMPTS_PER_RUN = 1` — a re-detected boundary after a vault fill means
  the credential failed; never re-type the same failing secret, per #102 AC) → pass to `next`.
- `InteractiveBoundaryResolver` (#103, replaces `PromptAndStopResolver` as chain terminal at the composition
  root): publishes `credential:prompt`, registers a pending prompt on the **`OperatorResponseChannel`**, and
  awaits `submit / cancel / timeout`. Submit ⇒ `fill` (+ optional vault persist — §6). Cancel/timeout ⇒
  `stop`. Bounded re-prompts: `MAX_INTERACTIVE_PROMPTS_PER_RUN = 3`, then `stop/partial` (PRD edge case).

**OperatorResponseChannel — the OQ3 inbound mechanism.** An **application-layer, in-process pending-prompt
registry keyed by `runId`**, with the invariant **at most one pending prompt per run** (the crawl loop is
sequential, so this is structural, not aspirational — no `promptId` correlation machinery, YAGNI):

```ts
interface OperatorResponseChannel {
  awaitResponse(runId, promptType, timeoutMs): Promise<OperatorOutcome>; // resolver side
  submit(runId, { value, remember }): SubmitResult; // API-route side
  cancel(runId): boolean;
  getPending(runId): PendingPromptInfo | null; // reconnect reconciliation
}
```

It is deliberately **not** a domain port: both producer (API route) and consumer (resolver) live inside one
process; no infrastructure boundary is crossed, and a domain port would add public surface with exactly one
conceivable implementation. (This refines #103's `Touches` guess of `packages/domain/src/ports`.) The
timer is injected (clock/`setTimeout` seam) for deterministic timeout tests. **Zero event-contract or SSE
changes:** `CredentialPromptEvent` already carries everything the dashboard needs (`remember` eligibility is
derivable: `promptType !== "2fa-otp"`), and ADR-0010's verbatim relay ships it as-is — the E6 seam holds.

## 5. Decision — pause semantics

- **Budgets do not tick while paused.** Every `CrawlBudget` dimension is count-based (steps / LLM calls /
  tokens / revisits / plateau-steps — ADR-0004 §8); there is no wall-clock budget, and the pause happens
  inside `resolve()` before any step is spent. No clock is added to the budget (YAGNI). The **only** bound on
  a pause is the prompt timeout.
- **Prompt timeout:** `FLOWSCOUT_PROMPT_TIMEOUT_MS`, default `300000` (5 min, named constant). Expiry ⇒
  resolver returns `stop/blocked-on-2fa`; the run finalizes through the normal path with a redacted reason —
  identical shape to today's terminal behaviour (PRD "crawl timeout while paused").
- **User cancel:** explicit dashboard action ⇒ `channel.cancel(runId)` ⇒ `stop` (graceful `partial`/
  `blocked-on-2fa`, pre-boundary map preserved, nothing stored).
- **Run-row status while paused stays `running`** (status is written at finalize — ADR-0008/#84); "paused"
  is a **presentation** state derived from `credential:prompt` on the SSE stream. Because ADR-0010 has no SSE
  replay, a client connecting mid-pause would miss the prompt — closed by `GET /api/runs/:runId/prompt`
  (reads `channel.getPending`), fetched by the client on connect/reconnect.
- **Driver/MCP idle while paused:** the loop awaits before issuing any driver call, so no MCP call is
  in-flight during a pause; SSE heartbeats (ADR-0010 T6) continue untouched.

## 6. Secret-flow invariants (NFR1/NFR2/FR6/FR7 — how each new path stays redacted)

1. **Fill execution bypasses the decision path.** `StartCrawlRun` executes `fill` directly
   (`tap(field) → typeText(value)` per field, then optional `tap(submit)`); the plaintext value goes **only**
   to `MobileDriverPort` — never into a `CandidateAction`, `PolicyDecision`, event, or the LLM.
2. **Synthetic redacted edge.** After a fill, the loop records the login transition via the existing
   `recordTransition` using a synthetic action with constant payload
   `{"text":"«credential»"}` (`REDACTED_CREDENTIAL_PAYLOAD`) — otherwise the pre-login → post-login edge
   would be missing and E3 workflow extraction would orphan the entire post-login subgraph. The value itself
   is never in the edge; the post-fill snapshot is redacted by the existing `CredentialRedactor` before
   identify/persist (unchanged TB-A boundary).
3. **OTP is never persisted (FR6):** the channel/resolver rejects `remember` for `2fa-otp` prompts (API ⇒
   `400 invalid_input`; resolver never calls `store` on the OTP path). The OTP string exists only in the
   route body → channel → resolver → driver call.
4. **Remember (FR7):** on a non-OTP submit with `remember: true`, the resolver merges into the existing
   vault entry (retrieve → set the field matching `promptType` → store) — progressive assembly across
   username/password prompts under `DEFAULT_CREDENTIAL_LABEL`.
5. **Route hygiene:** the response route never logs/echoes the body; errors use the ADR-0010 envelope; the
   Origin/Host gate applies automatically (non-GET ⇒ allowlist, D5). The run DB schema is untouched — no
   credential-adjacent column exists or is added.

## 7. Consequences & alternatives

- **+** One engine refactor serves #102 and #103; #103 becomes pure wiring + route + web work.
- **+** Zero changes to domain event contracts, the SSE relay, the run store, or any frozen surface beyond
  one sanctioned additive collaborator (recorded here, as ADR-0004 §7.2 requires).
- **–** In-process channel means a paused run cannot survive an API restart — accepted: the crawl itself is
  in-process, so the run dies with the process regardless; nothing to persist (and persisting pending
  prompts would be a secret-handling liability).
- **–** Interactive typing assumes `tap`-to-focus + `typeText` fills the intended field; validated against a
  login-bearing app (PRD success metric), not the Dime demo path.
- **Rejected:** SQLite vault (machinery without benefit, §3) · raw-32-byte-key env format (worse operator
  ergonomics, no security gain over scrypt-derived) · OS keychain now (native dep / CLI shelling; deferred
  behind `VaultKeySource`) · domain-port response channel (surface without a boundary) · promptId correlation
  (single-pending invariant makes it dead weight) · wall-clock pause budget (no clock exists in the budget
  model; the prompt timeout already bounds the pause).

## 8. Coverage gate (per-layer, line + branch)

- `packages/adapters/vault`: **≥90%** (pure, deterministic crypto/file logic — includes wrong-key, tamper,
  atomicity, and AAD-swap suites).
- `packages/application/src/crawl/twofa` (resolvers, channel, detector extension): **≥85%**.
- `packages/api` prompt routes: **≥85%** (incl. no-pending 409, OTP-remember 400, no-echo assertions).
- `packages/web` prompt VM + `model/api/prompt.ts`: **≥85%** (vitest + jsdom, per ADR-0010 conventions).
