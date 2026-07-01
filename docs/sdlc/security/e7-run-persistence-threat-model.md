# Threat Model — E7: Run persistence (durable run store)

- **Mode:** threat-model (design-time, per epic). **Epic:** #7 — run persistence.
  Tickets: **#83** (E7.1 durable SQLite store), **#84** (E7.2 auto-persist write path), **#85** (E7.3 run-history queries).
- **Author agent:** security. **Date:** 2026-07-02.
- **Aligns with:** `PRD-e7-run-persistence.md` (NFR4 no-secrets-persisted, NFR1 durability, NFR5 large graphs),
  `ADR-0008-e7-run-store.md` (embedded SQLite via `better-sqlite3`, WAL, hybrid schema = indexed columns + one
  deterministic JSON `payload` per aggregate, codec §5, cursor pagination §4) and `e7-plan.md`.
- **Builds on / inherits:** `docs/sdlc/security/e2-crawl-engine-threat-model.md` (the redaction boundary TB-A) and
  `docs/sdlc/security/e3-semantic-workflow-mapping-threat-model.md` (**T7**: all `WorkflowMap` strings are
  untrusted-origin data, output-encoded by E4 on render). See [[recurring-risks-redaction-2fa-noprod]],
  [[recurring-risks-e3-semantic-egress]], [[scope-boundaries]], [[mandated-scanning-policy]].
- **Standards applied:** OWASP Top 10 (2021) + ASVS v4 L1/L2 (named inline), CWE.

---

## Scope boundary — what E7 newly introduces

E7 is the **durable data backbone**: it turns the three in-memory aggregates (`Run`, `StateGraph`, `Report`
wrapping the finalized `WorkflowMap`) into **rows in a local SQLite file on the developer's Mac**
(`FLOWSCOUT_DB_PATH`, default `./.flowscout/flowscout.db`; WAL). E7 does **not** drive the simulator, call the
LLM/embedding providers, render HTML, or expose HTTP routes.

What E7 newly introduces, and what this model is about:

1. **A durable at-rest sink.** E2/E3 exposure of on-screen content was transient (in-memory graph, one LLM call).
   E7 writes that content — `StateNode.a11ySnapshot`, `StateNode.label`, `StateEdge.actionPayload`, and every
   inferred `WorkflowMap` string — to a **file that survives the process**. A redaction miss upstream is no longer
   ephemeral: it becomes cleartext-at-rest.
2. **A local SQL surface.** `appId`, `runId` (both app-name/build-derived, i.e. untrusted-origin) and an opaque
   pagination cursor flow into `WHERE` clauses → SQL-injection surface. The JSON `payload` is `JSON.parse`d and
   rebuilt into `Map`/`Set` on reload → deserialization surface.
3. **A file on the filesystem + a native dependency.** DB placement/permissions, and the `better-sqlite3` native
   addon's install-time supply chain.

**Explicitly out of scope (boundary notes, not E7 defects):**

- **The redaction _mechanism_.** Redaction is enforced **upstream** in E2's crawl loop
  (`CredentialRedactor.redact` at TB-A, before the graph is built — see [[recurring-risks-redaction-2fa-noprod]]).
  E7 persists an **already-redacted** graph. E7's obligation is narrow: **introduce no new secret sink and never
  de-redact** (NFR4), plus a defense-in-depth save-time check (T1).
- **Credentials themselves are E6 (vault) scope.** E7 must **NEVER** persist raw credentials — the vault owns
  them, encrypted, under E6's at-rest controls. E7 stores only the redacted a11y graph; it must not become a
  shadow credential store.
- **HTML output-encoding (XSS).** E4 owns context-encoding of every persisted `WorkflowMap`/label string on
  render. E7's obligation is to store the strings **raw and inert** (T7). Enforcement bites in **E4's** gate.
- **HTTP routes + dashboard UI** — E5. E7 ships application-layer query use-cases only.
- **Retention / GC / quota, cross-run diffing, migrations tooling** — explicit PRD non-goals.
- **No PCI/payments or regulated domain** — internal developer/tester tooling. See [[scope-boundaries]].

---

## Assets

| #   | Asset                                                                                         | Why it matters                                                                                                            |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| A1  | **The SQLite DB file + `-wal`/`-shm` sidecars** on local disk                                 | The durable system of record. Confidentiality (contents), integrity (torn writes), and placement (never in the repo/git). |
| A2  | **Persisted `StateNode.a11ySnapshot` / `label` / `StateEdge.actionPayload`** (JSON `payload`) | The bulk of at-rest content. Redacted upstream, but this is where a redaction miss becomes cleartext-at-rest.             |
| A3  | **Persisted `Report` / `WorkflowMap` strings** (name, description, intent, purpose, group)    | Untrusted-origin (app content + LLM output). Report-bound → E4 renders them (T7).                                         |
| A4  | **`appId` / `runId` / pagination `cursor`** as query inputs                                   | App-name/build- and client-derived → SQL-injection + malformed-input surface into the store.                              |
| A5  | **The JSON `payload` on reload** (`JSON.parse` → `Map`/`Set` rebuild)                         | Deserialization surface; app content can carry `__proto__`-style keys → prototype pollution.                              |
| A6  | **`better-sqlite3` native addon + prebuilt binary + transitive deps**                         | Native code executed on the host at install/first-run — supply-chain (RCE/exfil) surface.                                 |

## Trust boundaries

```
 [Finalized StateGraph + assembled Report — ALREADY redacted upstream at E2 TB-A]
                                   │
   RunAndPersist orchestrator (#84, application, ports-only)                 [untrusted-origin:
     save(run running/null) → crawl persists graph → assembleReport → save    appId/runId/cursor,
                                   │                                            a11y/label/payload]
                                   ▼
 ┌────────────────────────────────────────────────────────────────────────────────────┐
 │  packages/adapters/persistence — Sqlite{Run,StateGraph,Report}Repository (#83)       │
 │                                                                                      │
 │   TB-SQL (query boundary): appId/runId/cursor → ONLY as bound `?` params;            │
 │            static SQL text; prepared statements (better-sqlite3)          (T3/T4)     │
 │   TB-COD (codec boundary): encode = deterministic; decode = proto-safe,              │
 │            no eval, allow-listed fields; strings stored RAW/inert          (T5/T7)    │
 │   TB-RED' (defense-in-depth): save-time assert no credential/OTP marker              │
 │            survives into payload — E7 adds NO new secret sink              (T1)       │
 │                                   │                                                  │
 │                                   ▼  ONE transaction / save · PRAGMA journal_mode=WAL │
 │                    SQLite file @ FLOWSCOUT_DB_PATH (outside repo, 0600)     (T2/T9)   │
 └────────────────────────────────────────────────────────────────────────────────────┘
                                   │
     ListRunHistory / GetRunDetail read use-cases (#85) → E5 dashboard → E4 HTML render (encodes, T7)
```

---

## Threats (STRIDE / OWASP / CWE) and mitigations

Each threat: **class · standard/CWE · testable mitigation (MUST/SHOULD) · owning ticket(s) · how the gate verifies.**

### T1 — Unredacted PII/secret persisted into the graph/report → cleartext at rest (HIGH)

- **Class:** Information Disclosure. **OWASP A02 · CWE-312 (Cleartext Storage of Sensitive Info), CWE-359, CWE-212
  (Improper Removal of Sensitive Info Before Storage).**
- **Threat:** the a11y snapshot / label / action-payload / inferred `WorkflowMap` strings (A2/A3) can carry
  test-account PII or credential/OTP material rendered on screen. If the upstream redactor missed something (or a
  future caller bypasses it), E7 writes it to a **durable file** — the miss is no longer transient.
- **Invariant:** only **upstream-redacted** data is ever persisted; **E7 introduces no new secret sink and never
  de-redacts** (NFR4).
- **Enforcement point:** redaction stays in E2's crawl loop (`CredentialRedactor.redact` at TB-A, upstream of the
  graph — [[recurring-risks-redaction-2fa-noprod]]). The graph E7 receives is already clean; E7 must not re-derive
  raw text from any pre-redaction source and must not log/echo payloads.
- **Defense-in-depth (testable):**
  1. **(MUST, #84)** The write-path test feeds a **seeded-secret fixture** graph (reuse the E3 markers:
     `hunter2-SECRET` secure-field value + `482913` OTP-in-label) through `RunAndPersist` and asserts the
     **persisted** `StateGraph` **and** `Report` payloads (as reloaded from the store) contain **no** secret/OTP
     value and that `[REDACTED]` is present where expected — this is ticket #84's existing NFR4 AC, made concrete.
  2. **(MUST, #83)** The codec has a **redaction-marker passthrough** unit test (ADR §5): a `[REDACTED]` marker
     round-trips unchanged — the codec introduces no new sink and does not un-mask.
  3. **(SHOULD, #83)** A cheap **save-time assertion** in the repo/codec — scan the serialized payload for a
     secure-field node whose value is neither `[REDACTED]` nor empty; on a hit, fail the save with a typed error
     (defense-in-depth against a future upstream regression). Proportionate: a scan, not a second redactor.
- **Owning tickets:** #84 (primary), #83 (codec). **Gate check:** the seeded-secret persisted-payload test exists
  and passes; grep the persistence + orchestrator path confirms no de-redaction and no payload logging; gitleaks
  green on the diff.

### T2 — DB file inside the repo / world-readable at rest (HIGH)

- **Class:** Information Disclosure / Misconfiguration. **OWASP A05 · CWE-552 (Files Accessible to External
  Parties), CWE-276 (Incorrect Default Permissions), CWE-538.**
- **Threat:** the default `FLOWSCOUT_DB_PATH=./.flowscout/flowscout.db` is **relative to cwd**. If cwd is the repo
  checkout, the DB (plus its `flowscout.db-wal` / `flowscout.db-shm` sidecars) lands **inside the working tree**
  and can be **committed** — leaking at-rest run content (A1/A2/A3) into git history. Separately, a file created
  with default perms is readable by other local accounts.
- **Mitigation (testable):**
  1. **(MUST, #83)** `.gitignore` covers the store: `.flowscout/` **and** `*.db` / `*.db-wal` / `*.db-shm`, so the
     DB is never committed. Verify `git status` is clean after a run that creates the DB.
  2. **(MUST, #83)** The store dir/file is created with **restrictive permissions** (dir `0700`, file `0600`) so
     other local users cannot read it — or, if relying on OS defaults, document why that is acceptable for the
     single-user demo. Prefer an app-data dir over cwd for the production default where feasible.
  3. **(MUST, #83 — by construction)** E7 **does not derive filesystem paths from `appId`/`runId`** (single file
     from env). `screenshotUri`/`artifactUri` are stored as **opaque strings E7 never dereferences** — path
     traversal via ids is prevented by construction; keep it that way (no `path.join(appId, …)` in the store).
- **Owning tickets:** #83. **Gate check:** confirm `.gitignore` entries (db + both sidecars); confirm the create
  path sets 0700/0600 (or the documented rationale); confirm no id is spliced into a filesystem path.

### T3 — SQL injection via `appId` / `runId` / cursor (HIGH)

- **Class:** Injection. **OWASP A03 · CWE-89.**
- **Threat:** `appId` and `runId` are derived from the app name/build (attacker-influenceable), and the cursor is
  ultimately client-supplied via the E5 dashboard. If any statement is built by string concatenation/template
  interpolation, a crafted value is SQL injection against the local store.
- **Mitigation (testable):**
  1. **(MUST, #83, #85)** **Prepared statements with bound parameters only** — every runtime value is a `?` /
     named bind; **table and column names are static string literals** (never interpolated from input). No
     `db.prepare(\`… ${value} …\`)` and no concatenated SQL.
  2. **(MUST, #85)** The decoded cursor `(started_at, id)` values enter the `WHERE (started_at,id) < (?,?)` clause
     as **bound params**, not spliced text.
- **Owning tickets:** #83 (repos), #85 (list query). **Gate check:** grep the persistence package for
  interpolated/concatenated SQL into `.prepare(`/`.exec(` (must be none — every value is a bind param); a
  malicious-`appId`/`runId` test (`'; DROP TABLE runs;--`) returns an empty/null result, not an error or effect.

### T4 — Malformed / hostile pagination cursor: crash or unsafe decode (MEDIUM)

- **Class:** Improper Input Validation. **OWASP A03/A04 · CWE-20, CWE-502 (if decode is unsafe).**
- **Threat:** the opaque cursor decodes to `(started_at, id)`. A malformed, oversized, or crafted cursor
  (client-origin via E5) could crash the query, leak a stack trace, or — if decoded via an unsafe mechanism — be a
  deserialization/injection vector.
- **Mitigation (testable):**
  1. **(MUST, #83/#85)** Cursor is an **opaque token** (e.g. base64 of the two scalar fields), decoded
     **defensively**: validate the shape and field types **after** decode; on any failure treat as **first page**
     (or return an explicit typed not-found), **never** throw an unhandled error that leaks internals.
  2. **(MUST, #83/#85)** Decode uses a **plain, bounded parse** (no `eval`/`Function`, no arbitrary object
     reviver); decoded values flow only into **bound params** (T3).
- **Owning tickets:** #83 (cursor codec), #85 (list use-case). **Gate check:** a malformed/oversized-cursor test
  returns a graceful empty/first page (no throw, no stack leak); confirm decode validates before use.

### T5 — JSON payload deserialization → prototype pollution on reload (MEDIUM)

- **Class:** Deserialization. **OWASP A08 · CWE-1321 (Prototype Pollution), CWE-502.**
- **Threat:** the `payload` TEXT is `JSON.parse`d and rebuilt into `Map`/`Set`/objects on reload (A5). App content
  that flowed into a11y/label strings can contain `__proto__` / `constructor` / `prototype` keys; a decoder that
  copies payload keys onto plain objects can pollute `Object.prototype`.
- **Mitigation (testable):**
  1. **(MUST, #83)** The codec's `decode` reconstructs via **`Map`/`Set` and null-prototype / allow-listed
     objects**, and **skips `__proto__` / `constructor` / `prototype`** keys — never assigns attacker-controllable
     keys onto a live prototype.
  2. **(MUST, #83 — by construction)** **No `eval` / `new Function` / unsafe reviver** on the payload (ADR §5 —
     the codec is pure encode/decode).
- **Owning tickets:** #83 (codec). **Gate check:** a decode test with a `__proto__`-laden payload asserts
  `Object.prototype` is un-polluted after reload; SAST shows no eval on payload; confirm safe reconstruction.

### T6 — Oversized payload / unbounded resource on save-load (MEDIUM/LOW)

- **Class:** Denial of Service (local resource). **OWASP A04 · CWE-400, CWE-770.**
- **Threat:** a pathological crawl (explosive graph, very large a11y blobs) yields a payload that exhausts
  memory/disk on save/reload or exceeds SQLite's `SQLITE_MAX_LENGTH` (~1 GB) as an uncaught error, corrupting the
  run lifecycle. NFR5 mandates "hundreds of nodes" round-trip; beyond that there is no bound. Proportionate: this
  is a **local single-user availability** concern, not exfil — retention/GC is an explicit non-goal.
- **Mitigation (testable):**
  1. **(SHOULD, #83)** A **config-driven soft bound** (payload size or node/edge count, no magic number) with a
     **typed graceful failure** on breach — or an explicit **accepted-risk note** documenting the SQLite limit
     assumption. A breach must not leave a **torn** DB (single transaction, T9).
  2. **(SHOULD, #84)** The orchestrator maps a save failure to `status:"error"` + `finishedAt:now` (the run is
     recorded as failed, not silently lost — FR4).
- **Owning tickets:** #83 (guard), #84 (failure handling). **Gate check:** confirm either a config-bounded guard
  or a documented accepted-risk; the large-graph (NFR5) test round-trips and an oversized case fails safe (no torn
  row, no unhandled crash).

### T7 — Persisted untrusted-origin strings → stored XSS when E4 renders (MEDIUM, cross-epic handoff)

- **Class:** Injection. **OWASP A03 (XSS) · CWE-79, CWE-116.** (Carried forward from **E3 T7**.)
- **Threat:** the persisted `WorkflowMap` strings and `StateNode.label` (A3, app-/LLM-controlled) are later
  **rendered into the HTML report by E4**. If E4 does not context-encode, markup in a persisted string becomes
  **stored XSS** — and persistence makes the tainted string durable.
- **Boundary note (why it's here, not dropped):** **output-encoding is E4's responsibility**, not E7's. E7's
  storage-side obligation is the inverse: **store the strings RAW and inert** — E7 must **not** pre-escape (that
  corrupts the data contract and breaks byte-stable round-trip) and must **not** HTML-interpret/execute them.
- **Mitigation (testable):** **(MUST, #83/#84)** E7 persists strings verbatim (round-trip is byte-equal; no
  transform on write); **flag to E4/arch-review** that **all** persisted `WorkflowMap` + label + a11y string
  fields are untrusted-origin and MUST be context-encoded on render. **Store raw, encode at render.**
- **Owning tickets:** #83/#84 (keep inert + record handoff); **enforcement is E4's gate.** **Gate check:** confirm
  the round-trip is byte-equal (no escaping on write) and the E3→E4 untrusted-string handoff is restated in the
  #84 PR / arch-review.

### T8 — `better-sqlite3` native addon: supply chain (MEDIUM)

- **Class:** Tampering / supply chain. **OWASP A06 · CWE-1104 (Unmaintained/Untrusted Component), CWE-1357.**
- **Threat:** `better-sqlite3` is a **native addon** (A6) whose prebuilt binary executes on the host at
  install/first-run. A compromised, typosquatted, or unpinned version is an install-time RCE/exfil vector (ADR R-A).
- **Mitigation (testable):**
  1. **(MUST, #83)** **Exact-pin** `better-sqlite3` (and `@types/better-sqlite3`) — no `^`/`~`; the committed
     **lockfile carries integrity hashes**; SCA gate passes with **no high/critical** advisory. See
     [[mandated-scanning-policy]].
  2. **(MUST, #83)** Confirm the pinned version has a **darwin-arm64 prebuild** (ADR R-A) so the demo Mac needs no
     from-source toolchain; document the Prisma+SQLite fallback (same ports) if prebuild friction appears.
- **Owning tickets:** #83. **Gate check:** SCA clean; exact pin present in `package.json`; lockfile integrity
  present; the resolved version has a known-good prebuild.

### T9 — WAL / transaction integrity: torn run on crash (LOW)

- **Class:** Integrity / availability. **CWE-662 (Improper Synchronization), OWASP A04.**
- **Threat:** FR4's crash-safety guarantee (a killed run leaves a **discoverable, non-torn** row) depends on WAL +
  one transaction per save actually being wired. If `PRAGMA journal_mode=WAL` isn't set at init, or a `save*` spans
  multiple non-transactional statements, a crash can leave a half-written aggregate.
- **Mitigation (testable):** **(MUST, #83)** `PRAGMA journal_mode=WAL` at init; **each `save*` in ONE
  `better-sqlite3` transaction** (all-or-nothing, ADR §5); the reopen-after-write durability test (NFR1) proves
  rows are intact and non-torn.
- **Owning tickets:** #83. **Gate check:** confirm the WAL pragma at init and single-transaction saves; the
  reopen/durability conformance section passes. LOW: correctness/availability, covered by functional ACs.

---

## Severity summary

| Threat | Title                                                    | Severity   | Primary ref            |
| ------ | -------------------------------------------------------- | ---------- | ---------------------- |
| T1     | Unredacted PII/secret persisted → cleartext at rest      | HIGH       | A02 / CWE-312          |
| T2     | DB file inside repo / world-readable                     | HIGH       | A05 / CWE-552, CWE-276 |
| T3     | SQL injection via appId/runId/cursor                     | HIGH       | A03 / CWE-89           |
| T4     | Malformed/hostile pagination cursor                      | MEDIUM     | CWE-20 / CWE-502       |
| T5     | JSON payload → prototype pollution on reload             | MEDIUM     | A08 / CWE-1321         |
| T6     | Oversized payload / unbounded resource                   | MEDIUM/LOW | A04 / CWE-770          |
| T7     | Persisted untrusted strings → stored XSS in E4 (handoff) | MEDIUM     | A03 XSS / CWE-79       |
| T8     | `better-sqlite3` native addon supply chain               | MEDIUM     | A06 / CWE-1104         |
| T9     | WAL/transaction integrity — torn run on crash            | LOW        | CWE-662                |

---

## Per-ticket MUST controls (the security gate enforces these)

### #83 — E7.1: Durable SQLite store (`packages/adapters/persistence` + additive domain + conformance suite)

- **M83.1 (T3)** Every statement is a **prepared statement with bound `?`/named params**; table/column names are
  static literals; **no concatenated/interpolated SQL**. (grep clean + malicious-id test)
- **M83.2 (T2)** DB + `-wal`/`-shm` sidecars are **gitignored** (`.flowscout/`, `*.db*`); the store dir/file is
  created **0700/0600** (or documented OS-default rationale); **no `appId`/`runId` in any filesystem path**.
- **M83.3 (T5)** Codec `decode` is **prototype-pollution-safe** (skip `__proto__`/`constructor`/`prototype`;
  `Map`/`Set`/null-proto reconstruction; allow-listed fields); **no `eval`/`Function`/unsafe reviver** on payload.
- **M83.4 (T4)** The pagination **cursor codec** is opaque + **defensively decoded** (shape/type validated;
  malformed → first page, never a throw); decoded values used only as bound params.
- **M83.5 (T1)** Codec **redaction-marker passthrough** unit test (`[REDACTED]` round-trips unchanged); **SHOULD**
  add a save-time secure-field-value scan that fails the save on an un-redacted value (defense-in-depth).
- **M83.6 (T8)** `better-sqlite3` + `@types` **exact-pinned**; lockfile integrity committed; **SCA clean**; pinned
  version has a darwin-arm64 prebuild.
- **M83.7 (T9)** `PRAGMA journal_mode=WAL` at init + **one transaction per `save*`**; reopen/durability test passes.
- **M83.8 (T7)** Strings persisted **raw/inert** — byte-equal round-trip, **no escaping/transform on write**.

### #84 — E7.2: Auto-persist write path (`RunAndPersist` orchestrator + wiring)

- **M84.1 (T1 — the clean gate)** A **seeded-secret fixture** graph driven through `RunAndPersist` asserts the
  **reloaded** persisted graph **and** report contain **no** credential/OTP value (this is the ticket's NFR4 AC
  made concrete); **no de-redaction, no payload logging** in the orchestrator. gitleaks green.
- **M84.2 (T6)** A store save failure is mapped to `status:"error"` + `finishedAt:now` (run recorded as failed,
  never silently lost — FR4); no torn DB.
- **M84.3 (T7)** Keeps `WorkflowMap`/label strings **inert** on write; **records the E7→E4 untrusted-string
  handoff** to arch-review (restating E3 T7).

### #85 — E7.3: Run-history queries (`ListRunHistory` / `GetRunDetail`, read-only)

- **M85.1 (T3)** The list query passes `appId` and the decoded cursor as **bound params only** (no interpolation).
- **M85.2 (T4)** A malformed/oversized cursor from a caller yields a **graceful empty/first page** — never a throw
  or stack leak; unknown id → `null` (FR7), not an error.

---

## Cross-epic handoffs (do not drop)

- **→ E4 (HTML report):** every persisted `WorkflowMap` string + `StateNode.label` + a11y excerpt is
  **untrusted-origin** and MUST be **context-encoded on render** (T7, CWE-79). E7 stores raw; E4's gate enforces
  the encoding. Recorded so it survives the epic boundary.
- **→ E6 (vault):** raw credentials are **vault scope** — E7 must **NEVER** persist them (NFR4). If E6 later
  persists secrets, its at-rest encryption + perms are E6's; the E7 SQLite file must not become a shadow
  credential store. Any at-rest **encryption** of the run DB (beyond redaction) is deferred and would be an E6/
  platform decision, not E7.

---

## Verdict policy for the E7 security gate (per ticket, post-implementation)

- **Critical / High → FAIL** (block, route to developer). The HIGH controls are **T1 (no unredacted secret in the
  persisted payload)**, **T2 (DB never in the repo / not world-readable)**, **T3 (parameterized SQL only)** — a
  seeded-secret value surviving into a reloaded payload, a DB/sidecar committable into git, or any
  string-concatenated SQL is a **FAIL**.
- **Medium → must fix, or open a tracked follow-up and PASS-with-conditions** (never silently dropped) — T4 cursor
  validation, T5 prototype-pollution-safe decode, T6 size bound/accepted-risk, T7 handoff note, T8 SCA/pin.
- **Low → note** in the verdict (T9 WAL/transaction integrity — covered by the durability ACs).
- **Required scans did not run (gitleaks / SCA / SAST results absent) → BLOCKED** — do not PASS an unscanned diff.
- **T7's XSS enforcement bites in E4's gate**, not E7's; E7's gate only verifies strings are stored inert and the
  handoff is recorded.
