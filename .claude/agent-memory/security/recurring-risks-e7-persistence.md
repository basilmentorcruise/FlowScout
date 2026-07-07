---
name: recurring-risks-e7-persistence
description: E7 (run persistence) is the durable at-rest boundary — a local SQLite file (better-sqlite3, WAL) that persists the run graph + WorkflowMap. Recurring risks: cleartext-at-rest from an upstream redaction miss, DB-in-repo/perms, SQLi via appId/runId/cursor, prototype-pollution on payload decode, native-addon supply chain, and the carried-forward E4 XSS handoff.
metadata:
  type: project
---

E7 (#7, tickets #83 store / #84 write path / #85 read path; ADR-0008) makes the three aggregates
(`Run`, `StateGraph`, `Report`+`WorkflowMap`) **durable** in a local SQLite file
(`better-sqlite3`, WAL, `FLOWSCOUT_DB_PATH` default `./.flowscout/flowscout.db`; hybrid schema =
indexed scalar columns + one deterministic JSON `payload` per aggregate). It does NOT drive the
simulator, call the LLM, render HTML, or expose HTTP routes.

**Why E7 matters for security — it is the first _durable at-rest_ boundary.** E2/E3 exposure of
on-screen content was transient; E7 writes `a11ySnapshot`/`label`/`actionPayload`/inferred
`WorkflowMap` strings to a file that survives the process. A redaction miss upstream stops being
ephemeral — it becomes cleartext-at-rest. Redaction itself stays UPSTREAM in E2's crawl loop
(`CredentialRedactor.redact` at TB-A — see [[recurring-risks-redaction-2fa-noprod]]); E7's obligation
is narrow: **introduce no new secret sink, never de-redact** (NFR4).

**How to apply** — when gating any E7 ticket touching `packages/adapters/persistence/**`,
`packages/application/src/run/**`, or the persistence codec (full detail in
`docs/sdlc/security/e7-run-persistence-threat-model.md`):

- **HIGH — no unredacted secret in the persisted payload (T1, A02/CWE-312).** #84's write-path test
  must drive a **seeded-secret fixture** (reuse E3 markers `hunter2-SECRET` + `482913`) through
  `RunAndPersist` and assert the RELOADED graph AND report payloads contain no secret/OTP and
  `[REDACTED]` is present. #83's codec has a redaction-marker passthrough test; a save-time
  secure-field scan is a SHOULD (defense-in-depth). No de-redaction, no payload logging.
- **HIGH — DB placement + perms (T2, A05/CWE-552/276).** DB **and** its `-wal`/`-shm` sidecars must
  be gitignored (`.flowscout/`, `*.db*`) so they never land in git; dir/file created 0700/0600.
  E7 must NOT derive filesystem paths from `appId`/`runId` (single file from env); `screenshotUri`/
  `artifactUri` are opaque strings E7 never dereferences → path traversal prevented by construction.
- **HIGH — SQLi (T3, A03/CWE-89).** `appId`/`runId` (app-name-derived) and the cursor (client-origin
  via E5) flow into WHERE clauses. Prepared statements with bound `?`/named params ONLY; table/column
  names static literals; grep the persistence package for any concatenated/interpolated SQL (must be
  none). Applies to #85's list query too.
- **MEDIUM — cursor input validation (T4, CWE-20/502).** Opaque cursor, defensively decoded (validate
  shape/type; malformed → first page, never a throw/stack leak); decoded values only as bound params;
  no eval/unsafe reviver.
- **MEDIUM — prototype pollution on payload decode (T5, CWE-1321).** The JSON `payload` is parsed and
  rebuilt into Map/Set; decode must skip `__proto__`/`constructor`/`prototype` and use
  null-proto/allow-listed reconstruction; no eval/Function on payload.
- **MEDIUM — better-sqlite3 native-addon supply chain (T8, A06/CWE-1104).** Exact-pin (no `^`/`~`) +
  `@types`; lockfile integrity committed; SCA clean; verify a darwin-arm64 prebuild exists (ADR R-A;
  Prisma+SQLite is the documented fallback). See [[mandated-scanning-policy]].
- **MEDIUM — XSS is an E4 handoff (T7, CWE-79).** Persisted `WorkflowMap`/label strings are
  untrusted-origin; E7 stores them RAW/inert (byte-equal round-trip, no pre-escape — pre-escaping
  corrupts the data contract) and records the handoff; output-encoding enforcement bites in **E4's**
  gate. Carried forward from E3 T7 — see [[recurring-risks-e3-semantic-egress]].
- **LOW — WAL/transaction integrity (T9, CWE-662).** `PRAGMA journal_mode=WAL` at init + one
  transaction per `save*`; the reopen/durability conformance test (NFR1) covers it.

**T1 save-time guard scope (settled on #83):** the E7 `redactionGuard` (`assertNoUnredactedSecureField`)
scans each node's parsed `a11ySnapshot` for a `secureTextField` with a non-`[REDACTED]`/non-empty value —
it does **not** scan edge `actionPayload`. That is acceptable, not a T1 gap: (1) the guard is the M83.5
**SHOULD** (defense-in-depth), not the T1 MUST — the MUST is "no new sink, no de-redaction," which holds;
(2) `actionPayload` **is** redacted **upstream** at edge-record time — `StartCrawlRun.redactAction` runs
`redactor.redactText(p.text)` and records the redacted payload onto the edge before the graph E7 persists is
built. **Residual (routed to E2, not E7):** `redactText` only masks **OTP-shaped digit runs** (4–8 digits),
so a non-numeric secret typed into a secure field would pass through unmasked; today's typeText payloads are
enumerated with empty text, so no live leak. A cheap symmetry win is to extend the E7 save-time guard to also
scan `actionPayload` — a follow-up SHOULD, non-blocking.

**Scope note:** raw credentials are E6 (vault) scope — E7 must NEVER persist them; the run DB must not
become a shadow credential store. At-rest **encryption** of the run DB (beyond redaction) is deferred
(E6/platform decision), not E7. See [[scope-boundaries]].
