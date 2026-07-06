# Threat Model — E5: Web dashboard (run a crawl, watch live, browse map/reports, manage runs)

- **Mode:** threat-model (design-time, per epic). **Epic:** #5 — web dashboard.
  Tickets: **#93** (E5.1 API HTTP surface + submit-a-run), **#94** (E5.2 SSE relay + live panel),
  **#95** (E5.3 runs history + run detail), **#96** (E5.4 browse workflow map),
  **#97** (E5.5 serve & open the HTML report, sandboxed + traversal-safe).
- **Author agent:** security. **Date:** 2026-07-07. (Working-tree draft — do NOT commit; no code.)
- **Aligns with:** `PRD-e5-web-dashboard.md` (FR1–FR7, NFR-SEC/NFR-WEB/NFR-LOCAL/NFR-OBS).
- **Builds on / inherits (do not re-litigate, restate the E5-layer obligation):**
  - `docs/sdlc/security/e4-html-report-threat-model.md` **"→ E5 (dashboard) — flag"**: the moment E5 serves
    the E4 artifact over `http`, an XSS regains full same-origin blast radius against the dashboard →
    **sandbox + real response-header CSP + traversal-safe `artifactUri` resolve** (this model discharges it in
    **T10/T11**). See [[recurring-risks-e4-html-report]].
  - **E1 `AppBundlePathValidator`** (`packages/adapters/mobile-mcp/src/snapshot/AppBundlePathValidator.ts`) —
    the **T2/CWE-22/CWE-88** confinement precedent for `.app` paths (leading-`-` reject, `..`-segment fast-fail,
    `.app` extension allowlist, `realpath` canonicalize, base-dir containment with trailing-`/` prefix-collision
    guard). E5's new API entry point (#93 buildPath, #97 artifactUri) **reuses this exact containment shape**.
  - **E1 `simctl` exec discipline** (`packages/adapters/mobile-mcp/src/simctl.ts`) — `execFile`/argv-array only,
    `shell:false`, never a shell string (structural T1 compliance). E5 introduces no new shell-out.
  - **E7 persistence T3/T4** (parameterized queries for `appId`/`runId`/`cursor`; malformed cursor → first page) —
    the store already defends SQLi/cursor; **T8 restates the API-layer bound-param obligation**. See
    [[recurring-risks-e7-persistence]].
  - **E2 redaction/2FA boundary** — `CredentialRedactor` runs upstream of every sink; `credential:prompt` /
    `crawl:error` events are emitted already-redacted (`CrawlEventStream.ts:62,97`). E5 must **re-introduce no
    secret** via logs/URLs/error envelopes (NFR-OBS). See [[recurring-risks-redaction-2fa-noprod]].
  - Mandated scanning: [[mandated-scanning-policy]]; scope: [[scope-boundaries]] (no PCI/payments; vault is **E6**).
- **Standards applied:** OWASP Top 10 (2021) + ASVS v4 (L1/L2, named inline), CWE.

---

## Scope boundary — what E5 newly introduces

E5 gives FlowScout's engine **its first network surface**: a **localhost HTTP API + React dashboard** that
**drives crawls of untrusted third-party apps on the operator's own Mac**. Three facts define the surface:

1. **A network listener now exists.** Today `packages/api` serves only `/health` and — critically —
   **binds `HOST = "0.0.0.0"`** (`packages/api/src/index.ts:10`). E5 adds a **run-submission POST** that
   shells an untrusted `.app` path into `simctl`-adjacent tooling. A listener + a state-changing unauthenticated
   POST + no auth (PRD non-goal) makes **binding scope and CSRF/Origin posture the load-bearing controls** (T3/T4).
2. **The dashboard renders attacker-influenceable strings.** SSE payloads (#94), workflow-map strings (#96),
   run metadata (#95) all carry crawled-app / LLM-inferred text (the E3→E7→E4 T7 lineage). React default-escapes,
   but that guarantee is one `dangerouslySetInnerHTML` away from a same-origin XSS (T5/T7/T9).
3. **The dashboard serves the E4 artifact over `http`.** This is the E4 "Flagged for E5" handoff: an XSS in the
   report that was merely local-file-read at `file://` becomes **same-origin against the live dashboard session**
   once served — so **sandbox + response-header CSP + traversal-safe resolve** are mandatory (T10/T11).

**In scope:** `packages/api` (server bootstrap + bind, new run-submit / SSE / list-get / map / report-serve routes,
composition-root injection of the wired `AppContext`), `packages/web` (`ApiClient` model boundary, view-models, views).

**Explicitly out of scope (boundary notes, not E5 defects):**

- **Auth / login / multi-user / RBAC / TLS / non-localhost hosting** — PRD non-goals; single-operator localhost.
- **Credential vault + the 2FA prompt UI + operator-response route** — **E6**. E5 only preserves the relay seam
  (FR7): unknown / `credential:prompt` event kinds are **relayed as opaque data, never dropped, never trusted-as-
  structure**. Flagged to E6 below.
- **Redaction of secrets/PII** — enforced upstream in E2 (already-redacted events). E5 introduces no new pre-
  redaction source and must not re-surface secrets via logs/URLs (NFR-OBS invariant, T2/T12).
- **Persisting runs / maps / reports; parameterized store queries** — E7 owns the store (SQLi/cursor defence);
  E5 restates the **API-layer** input-bounding obligation only (T8).
- **Generating the artifact / filling `artifactUri`** — E4 (#87 renders, #89 persists). E5 only resolves + serves.
- **Run cancellation / node-graph fidelity / export / PDF / theming** — PRD non-goals.
- **No PCI/payments or regulated domain** — internal developer/tester tooling. See [[scope-boundaries]].

---

## Assets

| #   | Asset                                                             | Why it matters                                                                                                                                                                           |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | **`.app` build path (submit input, #93)**                         | User-entered path consumed by `simctl install`-adjacent tooling → command/path/argument injection (CWE-22/CWE-78/CWE-88) into the simulator install.                                     |
| A2  | **`appName` (submit input, #93)**                                 | Untrusted string that fans out into logs, the run DB, SSE payloads, and eventually HTML → log-injection / stored-then-reflected XSS surface (CWE-117/CWE-79).                            |
| A3  | **The network listener + bind scope (#93)**                       | A state-changing unauthenticated POST reachable from any interface = remote crawl trigger / local-tooling abuse (CWE-668/CWE-1327).                                                      |
| A4  | **The browser's ambient authority against `localhost` (#93/#94)** | Any web page the operator visits can `fetch`/`EventSource` `http://localhost:3000` (drive-by CSRF); DNS-rebinding can bypass a naive origin check (CWE-352/CWE-350/CWE-1385).            |
| A5  | **SSE event payloads (#94)**                                      | `state:discovered.label`, `action:taken.action`, `crawl:error.message`, `credential:prompt.message` — crawled-app / LLM strings rendered live in the dashboard (CWE-79).                 |
| A6  | **The SSE subscription lifecycle (#94)**                          | `CrawlEventStream.subscribe` returns an unsubscribe fn (`CrawlEventStream.ts:104`); a leaked subscriber per dropped client = unbounded server resource growth (CWE-400/CWE-770).         |
| A7  | **Unknown / forward-compat event kinds (#94, FR7)**               | Relayed opaquely for E6; if the relay trusts kind/shape (switch-on-kind that renders raw, or JSON that's `eval`-parsed) it becomes an injection channel (CWE-20/CWE-79).                 |
| A8  | **`runId` + pagination `cursor` URL params (#95/#96)**            | Reach the E7 read-path use-cases; unbounded/typed-wrong values = query abuse / error-envelope leakage; malformed cursor must degrade to first page (CWE-20; SQLi is E7-covered).         |
| A9  | **Workflow-map + run-detail display strings (#95/#96)**           | `appPurpose`, workflow `name`/`description`/`featureGroup`, step `description`, `StateNode.label` rendered in React → same-origin XSS if `dangerouslySetInnerHTML` is used (CWE-79).     |
| A10 | **`ReportMetadata.artifactUri` (#97)**                            | A stored string E5 resolves to a file path under `FLOWSCOUT_ARTIFACTS_DIR`. Treated as untrusted: `..`/absolute/symlink-escape = arbitrary local-file read (CWE-22/CWE-23/CWE-73).       |
| A11 | **The served report response + the embedding context (#97)**      | Served over `http` at the dashboard origin, an in-report XSS acts on the dashboard session unless sandboxed + CSP'd; wrong MIME / directory listing widens it (CWE-1021/CWE-79/CWE-548). |
| A12 | **The chosen server framework + its transitive deps**             | The new prod-path HTTP framework (Fastify is present today) is a supply-chain + misconfig surface (CWE-1104/CWE-1035).                                                                   |
| A13 | **The live log / SSE relay as a secret sink (cross-cutting)**     | If E6 later pauses mid-flow, credential-shaped strings must never reach the stream/log/URL (NFR-OBS; relies on the E2 redaction invariant holding).                                      |

## Trust boundary

```
 Operator's browser (dashboard + ANY other page it has open)
   │  submit(appName, buildPath) POST · EventSource(SSE) · GET list/get/map/report
   │  ── A malicious page can also issue these (ambient authority, A4) ──
   ▼
 TB-NET  packages/api  (localhost listener)
   ├─ BIND: 127.0.0.1 loopback ONLY — never 0.0.0.0        (T3)   [current code binds 0.0.0.0 — must change]
   ├─ ORIGIN/HOST gate on state-changing + stream routes:
   │     Origin/Referer allowlist + Host==loopback (anti-DNS-rebind)  (T4)
   │
   ├─ #93 submit → validate(appName A2, buildPath A1) at ingress:
   │     buildPath → E1 AppBundlePathValidator containment (realpath + base-dir + .app + no '-'/'..')  (T1)
   │     appName   → bound + opaque text to all sinks (log/DB/SSE/HTML)                                 (T2)
   │        │  AppContext.startCrawlRun  → runId
   │        ▼  (adapters: execFile/argv only, shell:false — E1 simctl discipline, no new shell-out)
   │
   ├─ #94 SSE relay = CrawlEventStream.subscribe(runId, handler):
   │     envelope schema-validated · payload treated as OPAQUE TEXT (A5/A7)  (T5/T7)
   │     client disconnect → call unsubscribe (no leaked subscriber) · bounded streams  (T6)
   │
   ├─ #95/#96 read routes: runId/cursor BOUND at API layer (A8); store is E7-parameterized  (T8)
   │
   └─ #97 report-serve: resolve(artifactUri A10) contained to FLOWSCOUT_ARTIFACTS_DIR
         realpath + reject '..'/absolute/symlink-escape · MIME fixed text/html · no dir listing  (T10)
         response headers: real CSP + X-Content-Type-Options; iframe sandbox (NO allow-same-origin)  (T11)
   ▼
 packages/web  ApiClient (only HTTP layer) → view-models → passive views
   React default-escapes A5/A9 · dangerouslySetInnerHTML FORBIDDEN (T5/T7/T9)
   report embedded in <iframe sandbox> (no allow-same-origin / no allow-scripts) (T11)
```

---

## Threats (STRIDE / OWASP / CWE) and mitigations

Each threat: **class · standard/CWE · testable mitigation (MUST/SHOULD) · owning ticket(s) · gate check.**

### T1 — `.app` build-path command / path / argument injection into simulator install (HIGH)

- **Class:** Injection / Path Traversal. **OWASP A03/A01 · CWE-78, CWE-22, CWE-88.** Reuses E1 T2.
- **Threat:** #93 accepts an operator-entered `.app` **path** (A1) and hands it toward `simctl install`. A path
  with a leading `-` (arg injection into simctl flags), `..` segments / absolute path / symlink escaping the
  builds root (traversal → install/read an out-of-root bundle), or shell metacharacters (if ever concatenated
  into a shell string) subverts the install. The API is a **new caller** of the install path — the E1 validator
  only protects callers that invoke it.
- **Mitigation (testable):**
  1. **(MUST, #93)** The submitted `buildPath` is validated + confined **before** it reaches any `simctl` argv,
     via the E1 `AppBundlePathValidator` containment shape against a **config-owned builds base dir**
     (`FLOWSCOUT_APP_BUILDS_DIR` or equivalent): reject leading `-`, fast-fail any `..` segment, require `.app`
     extension, `realpath`-canonicalize, and assert the resolved path is **inside** the resolved base
     (trailing-`/` prefix-collision guard). Out-of-root / non-existent → typed validation error, **run not started**.
  2. **(MUST, #93)** No shell string is ever formed from `buildPath`/`appName`; the install path stays
     `execFile`/argv-array with `shell:false` (E1 `simctl.ts` discipline — E5 adds no new shell-out).
  3. **(MUST, #93)** Validation failure yields the **consistent JSON error envelope** (readable message, no raw
     path echoed beyond a truncated form) and creates **no partial run** (PRD edge case).
- **Owning ticket:** #93. **Gate check:** a test drives `-Fflag.app`, `../../../evil.app`, `/etc/passwd`,
  a symlink-escape, and `app.app; rm -rf` — each rejected with no run started and nothing reaching simctl with the
  hostile value; grep confirms `buildPath` reaches the install path only through the validator (single boundary) and
  that no route builds a shell string. SAST `detect-child-process` / `detect-non-literal-fs-filename` clean or
  security-justified.

### T2 — `appName` injection into log / DB / SSE / HTML sinks (MEDIUM)

- **Class:** Injection (log/output). **OWASP A03/A09 · CWE-117 (Log Injection), CWE-79.**
- **Threat:** `appName` (A2) is untrusted and fans out: into structured logs (CRLF/log-forging, forged log lines),
  the run DB (E7-parameterized — not re-litigated), SSE payloads, and eventually the run-detail / history HTML.
  Treated as trusted anywhere downstream it becomes a stored-then-reflected injection.
- **Mitigation (testable):**
  1. **(MUST, #93)** `appName` is length-bounded and validated at ingress (non-empty per FR2; a sane max length;
     reject control chars / CR / LF to defeat log-forging), then carried as **opaque text** — never interpolated
     into a log format string, a SQL string, or markup without the sink's own encoding.
  2. **(MUST, #93)** Structured logging only (fields, not concatenation); the API never logs the raw `buildPath`
     or `appName` into a message that could forge a log record.
- **Owning ticket:** #93 (with T5/T9 covering the HTML render side). **Gate check:** a test submits an `appName`
  with `\n`, `\r`, and `<script>` and asserts no forged log line and inert rendering downstream; confirm ingress
  length/charset bound and structured logging.

### T3 — Listener bound to a non-loopback interface (HIGH)

- **Class:** Security Misconfiguration. **OWASP A05 · CWE-668 (Exposure of Resource to Wrong Sphere), CWE-1327
  (Insecure Default: binding to all interfaces).**
- **Threat:** the current server binds **`HOST = "0.0.0.0"`** (`packages/api/src/index.ts:10`) — reachable from
  every network interface. With **no auth** (PRD non-goal) and a state-changing crawl-trigger POST, anyone on the
  LAN (coffee-shop / office / container network) could enumerate `/health`, submit runs, and read run history.
- **Mitigation (testable):**
  1. **(MUST, #93)** The server binds **loopback only** — `127.0.0.1` (and/or `::1`), **never `0.0.0.0`** and never
     a configurable external interface. This is a hard requirement of FR1 / NFR-LOCAL, and a change to existing code.
  2. **(SHOULD, #93)** No feature (SSE, report serving) opens a second listener on a broader interface.
- **Owning ticket:** #93. **Gate check:** grep the server bootstrap for `0.0.0.0` / any non-loopback host (must be
  gone); a test asserts the configured bind host is loopback; confirm no env knob can widen it to a public interface.

### T4 — Drive-by CSRF against the localhost API + DNS rebinding (HIGH)

- **Class:** CSRF / Server-Side Request-Origin trust. **OWASP A01/A05 · CWE-352, CWE-350 (Reliance on Untrusted
  DNS), CWE-1385 (Missing Origin Validation).** _This is THE classic localhost-API attack._
- **Threat:** even bound to loopback, any web page the operator has open can issue
  `fetch('http://localhost:3000/runs', {method:'POST', ...})` or open an `EventSource` — the browser attaches
  ambient authority and there is no auth to stop it (A4). A malicious/compromised page can silently **start crawls**,
  drive the simulator, and (for GET streams) read run data cross-origin if CORS is lax. A naive `Host`-only or
  `Origin`-substring check is further defeated by **DNS rebinding** (attacker domain re-resolves to `127.0.0.1`, so
  the request's `Host` is attacker-controlled).
- **Mitigation (testable):**
  1. **(MUST, #93)** State-changing routes (run submit; any future operator-response route) and the SSE stream
     **validate the `Origin`/`Referer`** against a **strict allowlist** of the dashboard's own origin(s)
     (e.g. `http://localhost:<uiPort>` / `http://127.0.0.1:<uiPort>`); a missing or non-allowlisted `Origin` on a
     state-changing request is **rejected**.
  2. **(MUST, #93)** **`Host`-header validation**: reject any request whose `Host` is not a loopback literal
     (`localhost` / `127.0.0.1` / `[::1]` on the expected port) — this defeats DNS-rebinding (attacker hostnames
     never match). Do not trust `Host`/`Origin` from an arbitrary domain.
  3. **(MUST, #93)** **CORS stays closed by default** — no `Access-Control-Allow-Origin: *`, no reflecting arbitrary
     origins, no `Access-Control-Allow-Credentials` with a wildcard. Only the dashboard origin is allowed.
  4. **(SHOULD, #93)** Because there are no cookies, SameSite gives no protection; the Origin/Host gate is the
     control. Prefer non-simple requests (JSON content-type / a custom header) so a preflight is forced on writes.
- **Owning ticket:** #93 (seam consumed by #94/#95/#96/#97). **Gate check:** a test issues a POST/EventSource with a
  foreign `Origin` and with an attacker `Host` and asserts rejection; confirm the allowlist is loopback-only and CORS
  is not wildcarded. This gate is **inherited by every subsequent E5 route.**

### T5 — Stored/reflected XSS via SSE payloads rendered live (HIGH→MEDIUM)

- **Class:** Injection (XSS). **OWASP A03 · CWE-79, CWE-116.** Realisation of the E3/E7/E4 **T7** lineage at the
  dashboard origin — HIGH severity by blast radius (same-origin session), mitigated to residual-low by React's
  default escaping _provided the escape hatch is never used_.
- **Threat:** SSE event strings (A5) — `state:discovered.label`, `action:taken` action/decision text,
  `crawl:error.message`, `credential:prompt.message` — are crawled-app / LLM controlled and rendered live. A payload
  like `<img src=x onerror=…>` executes **in the dashboard origin** if any live-view component renders it as raw HTML.
- **Mitigation (testable):**
  1. **(MUST, #94)** All event strings are rendered as **text via React's default-escaping JSX** —
     **`dangerouslySetInnerHTML` is FORBIDDEN** anywhere event data flows (live panel, activity log, error banner).
     No `innerHTML`, no `insertAdjacentHTML`, no rendering event strings into an `href`/`src`/`style` without scheme/
     value validation.
  2. **(MUST, #94)** The relay treats every payload field as **opaque display text** (see T7); it does not build DOM
     from event structure.
- **Owning ticket:** #94. **Gate check:** grep `packages/web` live-watch views/VMs for `dangerouslySetInnerHTML` /
  `innerHTML` (must be none on the event path); a test feeds an adversarial `label`/`message` and asserts the live
  panel DOM is inert (no injected script/handler).

### T6 — SSE subscriber leak / event-stream resource exhaustion (MEDIUM)

- **Class:** Denial of Service (local resource). **OWASP A04 · CWE-400, CWE-770, CWE-772 (Missing Release of
  Resource).**
- **Threat:** `CrawlEventStream.subscribe` returns an **unsubscribe fn** (`CrawlEventStream.ts:104`). If the SSE
  route does not call it when the client disconnects / navigates away (FR3 "stream ends cleanly on disconnect"), each
  reconnect leaks a subscriber and a held connection → unbounded growth. Unbounded concurrent streams (many browser
  tabs) compound it. Proportionate: local single-operator availability, not exfil.
- **Mitigation (testable):**
  1. **(MUST, #94)** On client disconnect / request close **and** on terminal event (`crawl:finished`/`crawl:error`),
     the route **invokes the returned unsubscribe** and closes the response — no dangling subscriber, no dangling
     socket.
  2. **(SHOULD, #94)** A sane bound on concurrent open streams (or per-runId) so a pathological client cannot exhaust
     handles; heartbeat/keepalive tuned so dead peers are detected.
- **Owning ticket:** #94. **Gate check:** a test opens then drops an SSE client and asserts unsubscribe was called and
  the subscriber set returned to baseline (no leak); confirm terminal-event teardown.

### T7 — Unknown/forward-compat event kind becomes an injection channel (MEDIUM)

- **Class:** Improper Input / Injection. **OWASP A03/A08 · CWE-20, CWE-79.**
- **Threat:** FR7 requires unknown / `credential:prompt` kinds be **relayed, not dropped**, so E6 can add a prompt
  without changing the contract (A7). If the relay trusts the envelope shape (renders unknown payloads raw, or the
  client parses the SSE `data:` line with anything other than strict JSON), a crafted event kind/payload is an
  injection vector into the dashboard.
- **Mitigation (testable):**
  1. **(MUST, #94)** The SSE envelope is **schema-validated** on relay: `kind` is a string, `runId` matches the
     subscribed run, `timestamp` well-formed; the payload is serialized as **JSON and treated as opaque data** —
     never `eval`'d, never string-concatenated into the `data:` frame, never assumed to be a known discriminant.
  2. **(MUST, #94)** On the client, unknown kinds render as an **inert generic activity-log line** (escaped text) —
     they are relayed and displayed, never used to select a raw-HTML render path or a DOM sink.
- **Owning ticket:** #94 (seam for E6). **Gate check:** a test injects an unknown-kind event with a markup payload and
  asserts it is relayed and rendered inert (no script, no crash); confirm strict JSON parse on the client and no
  raw-render branch keyed on kind.

### T8 — `runId` / pagination `cursor` param injection at the API layer (MEDIUM)

- **Class:** Improper Input Validation. **OWASP A03/A01 · CWE-20, CWE-89 (SQLi — store-side, E7-covered).**
- **Threat:** #95/#96 take `runId` and an opaque `cursor` from URL params (A8) into the E7 read-path use-cases. E7
  already parameterizes queries (T3) and treats a malformed cursor as first page (T4) — but the **API layer** must not
  reflect these raw into error envelopes or trust them structurally.
- **Mitigation (testable):**
  1. **(MUST, #95/#96)** `runId` is bound/validated at ingress (expected id charset/shape); a non-existent id yields
     the **not-found JSON error envelope** (FR6), not a leaked stack/SQL error. The `cursor` is treated as **opaque**
     and passed to the store; a malformed/expired cursor **degrades to first page** (never a 500) — restating E7 T4 at
     the API boundary.
  2. **(MUST, #95/#96)** Error envelopes never echo raw params or internal detail (no reflected `runId` in an
     unescaped context — ties to T9).
- **Owning tickets:** #95, #96. **Gate check:** tests drive a bogus `runId` and a malformed `cursor` and assert
  not-found-envelope / first-page respectively with no 500 and no reflected raw value; confirm the store call is
  parameterized (E7) and the API adds no string-built query.

### T9 — XSS via workflow-map / run-detail strings rendered in React (HIGH→MEDIUM)

- **Class:** Injection (XSS). **OWASP A03 · CWE-79, CWE-116.** Same lineage/blast-radius as T5 (map/detail views).
- **Threat:** #96 renders `appPurpose`, workflow `name`/`description`/`featureGroup`, step `description`,
  `StateNode.label` (A9); #95 renders run `appName`/status/metadata. All are attacker-influenceable; a
  `dangerouslySetInnerHTML` on any of them = same-origin XSS.
- **Mitigation (testable):**
  1. **(MUST, #96, #95)** Map/detail strings render as **text via default-escaping JSX**;
     **`dangerouslySetInnerHTML` FORBIDDEN** on any map/run string; no injecting these into `href`/`src`/`style`
     without validation. FR4 "output-encoded, no active content" is satisfied by encode-by-default, not by a sanitizer
     that could be bypassed.
  2. **(MUST, #96)** Hidden/duplicate-path **indicators** are structural UI (badges/classes), not raw HTML derived
     from untrusted strings.
- **Owning tickets:** #96 (map), #95 (run detail). **Gate check:** grep the map/detail views for
  `dangerouslySetInnerHTML`/`innerHTML` (none on untrusted data); an adversarial-string test asserts inert DOM.

### T10 — Report `artifactUri` path traversal / arbitrary local-file read on serve (HIGH)

- **Class:** Path Traversal. **OWASP A01/A05 · CWE-22, CWE-23 (Relative Traversal), CWE-73.** Binds the E4 handoff.
- **Threat:** #97 resolves the stored `artifactUri` (A10) to a file under `FLOWSCOUT_ARTIFACTS_DIR` and streams it. A
  crafted/tampered `artifactUri` with `..`, an absolute path, or a **symlink escaping the artifacts root** turns the
  serve route into an **arbitrary local-file read** (`/etc/passwd`, other apps' data) into the browser. Screenshot/
  asset sub-reads referenced by the report share the same risk.
- **Mitigation (testable):**
  1. **(MUST, #97)** `artifactUri` is treated as **untrusted** and resolved with the E1 containment shape against a
     **config-owned `FLOWSCOUT_ARTIFACTS_DIR`**: reject `..` segments (fast-fail) and absolute paths outside root,
     `realpath`-canonicalize (resolves symlinks), and assert the resolved path is **inside** the resolved artifacts
     root (trailing-`/` prefix-collision guard). Any escape → error, **serve nothing** (no partial/redirect).
  2. **(MUST, #97)** **Every** asset/screenshot read the report triggers is resolved with the **same containment** —
     no `path.join(root, untrusted)` without the realpath+containment assert.
  3. **(MUST, #97)** **No directory listing** (a directory / missing file → "report not available" state, not an index
     or a server error — PRD edge case), and the empty-sentinel `artifactUri` / not-finished run → "report not
     available".
  4. **(MUST, #97)** Response is served with a **fixed `Content-Type: text/html`** (no content-type sniffing off the
     path) and **`X-Content-Type-Options: nosniff`**; the served path's extension is not used to pick an arbitrary MIME.
- **Owning ticket:** #97. **Gate check:** tests drive `artifactUri` = `../../../../etc/passwd`, an absolute out-of-root
  path, and a symlink escaping the root — each returns an error and reads nothing outside root; confirm the same
  containment on asset reads, fixed `text/html`, `nosniff`, and no directory listing. SAST
  `detect-non-literal-fs-filename` clean or security-justified.

### T11 — Served report XSS regains same-origin blast radius against the dashboard (HIGH)

- **Class:** Misconfiguration / XSS containment. **OWASP A05/A03 · CWE-1021 (Improper Restriction of Rendered UI
  Layers / clickjacking-frame), CWE-79.** _This is the core E4 "Flagged for E5" handoff._
- **Threat:** the E4 artifact is built from attacker-influenceable content and, though E4 enforces encoding, defense-
  in-depth assumes an XSS could exist. Served over `http` at the **dashboard origin** (A11), such an XSS would read the
  dashboard's DOM/storage and call the API with the operator's ambient authority — a full same-origin compromise, far
  worse than the `file://` local-read it was at E4.
- **iframe-sandbox flag ruling (MUST, #97) — decisive:**
  - The report **MUST** be embedded in an **`<iframe sandbox>`** and the sandbox **MUST NOT include
    `allow-same-origin`** — with `allow-same-origin` omitted the frame runs in a **unique opaque origin** and cannot
    touch the dashboard's DOM, cookies, or storage.
  - The sandbox **MUST NOT include `allow-scripts`** either: the E4 artifact is **self-contained inline HTML/CSS with
    no script** (E4 M87.5 — no `script-src`), so no script permission is needed; withholding it makes an injected
    `<script>` inert regardless. **Never grant `allow-scripts` and `allow-same-origin` together** — that combination
    lets the frame remove its own sandbox and is the classic footgun. Ruling: **`sandbox=""` (deny-all), or at most a
    minimal additive flag the designer proves necessary — but `allow-same-origin` is FORBIDDEN and `allow-scripts` is
    withheld unless a concrete need is shown at gate.**
  - **PLUS a real response-header CSP** on the served artifact (not only the E4 `<meta>` CSP, which is advisory): e.g.
    `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; frame-ancestors 'self'; base-uri
'none'; form-action 'none'` — no `script-src`, no remote origins. `frame-ancestors 'self'` keeps the report
    embeddable only by the dashboard.
  - **A distinct origin/port for served artifacts is the stronger option** (PRD OQ2 / architect ADR call) and is
    RECOMMENDED; **sandbox-without-`allow-same-origin` + response CSP is the mandatory floor** regardless of which
    serving mechanism the ADR picks.
- **Mitigation (testable):**
  1. **(MUST, #97)** iframe `sandbox` present, **no `allow-same-origin`**, `allow-scripts` withheld (per ruling).
  2. **(MUST, #97)** Served artifact carries a **response-header CSP** with no `script-src` and no remote sources, plus
     `X-Content-Type-Options: nosniff` (T10).
  3. **(SHOULD, #97)** Serve from a distinct origin/port if the ADR selects it (defense-in-depth over the mandatory floor).
- **Owning ticket:** #97. **Gate check:** inspect the embed markup for `sandbox` with **no `allow-same-origin`** (and no
  `allow-scripts` unless gate-justified); assert the serve response carries the CSP header and `nosniff`; a test that a
  `<script>`/`onerror` in a fixture artifact cannot reach the parent dashboard (opaque origin) and does not execute.

### T12 — Secrets / credential-shaped strings leaking into the stream, logs, or URLs (MEDIUM)

- **Class:** Sensitive Data Exposure. **OWASP A09/A02 · CWE-532 (Log Exposure), CWE-598 (Info in Query String).**
  Cross-cutting NFR-OBS.
- **Threat:** E5 owns no vault (E6), but it is the **surface** that logs, streams, and URL-routes run data. If the
  dashboard puts `runId`/`appName`/tokens in query strings, logs full event payloads, or (once E6 pauses mid-flow)
  relays a credential-bearing prompt without relying on the E2 redaction, secrets surface in the UI/logs.
- **Mitigation (testable):**
  1. **(MUST, all E5)** The dashboard/API **re-introduce no secret**: `credential:prompt`/`crawl:error` messages are
     rendered as already-redacted text (relied-upon E2 invariant — do not un-redact); no credential-shaped value is
     ever placed in a URL/query string or a log message (NFR-OBS).
  2. **(MUST, all E5)** gitleaks over the diff is clean (no fixture tokens/keys committed in web/api tests or configs).
- **Owning tickets:** all E5 (esp. #94). **Gate check:** gitleaks clean; grep confirms no event payload logged verbatim
  in a way that could carry an unredacted value, and no secret-in-URL pattern. **E6 note below.**

### T13 — Server-framework supply chain & secure-config posture (MEDIUM)

- **Class:** Vulnerable/Outdated Components + Misconfig. **OWASP A06/A05 · CWE-1104, CWE-1035.**
- **Threat:** E5 puts an HTTP framework (Fastify is present in `packages/api/src/index.ts`) into the **prod** dep path
  along with SSE/static-serving middleware — a new prod-path supply-chain + misconfig surface. The architect is
  finalizing the stack concurrently; these MUSTs are framework-agnostic.
- **Mitigation (testable):**
  1. **(MUST, all E5)** The server framework + any static-file/SSE middleware are **exact-pinned** (no `^`/`~`),
     lockfile integrity committed, and **SCA clean — no High/Critical in the `--prod` path** (per
     [[mandated-scanning-policy]]; re-judge if a High/Critical ever lands in `--prod`).
  2. **(MUST, all E5)** Secure server config: framework error handler returns the **consistent JSON envelope** with **no
     stack traces / internal paths** to the client; no verbose framework banner; default security headers where the
     framework offers them; static serving (if any) uses the framework's **path-safe** file API under the contained root
     (never raw path concat — ties to T10).
- **Owning tickets:** #93 (bootstrap), #97 (static serving). **Gate check:** SCA green in `--prod`; new HTTP deps
  exact-pinned with committed lockfile; a test asserts the error envelope carries no stack/internal path; confirm any
  static serving goes through the contained resolver.

---

## Severity summary

| Threat | Title                                                            | Severity | Primary ref                |
| ------ | ---------------------------------------------------------------- | -------- | -------------------------- |
| T1     | `.app` build-path command/path/arg injection into simctl install | HIGH     | A03/A01 / CWE-78,22,88     |
| T2     | `appName` injection into log/DB/SSE/HTML sinks                   | MEDIUM   | A03/A09 / CWE-117,79       |
| T3     | Listener bound to non-loopback interface (`0.0.0.0`)             | HIGH     | A05 / CWE-668,1327         |
| T4     | Drive-by CSRF against localhost API + DNS rebinding              | HIGH     | A01/A05 / CWE-352,350,1385 |
| T5     | Stored/reflected XSS via SSE payloads rendered live              | HIGH→MED | A03 / CWE-79               |
| T6     | SSE subscriber leak / stream resource exhaustion                 | MEDIUM   | A04 / CWE-400,770,772      |
| T7     | Unknown event kind becomes an injection channel                  | MEDIUM   | A03/A08 / CWE-20,79        |
| T8     | `runId`/`cursor` param injection at API layer                    | MEDIUM   | A03/A01 / CWE-20,89        |
| T9     | XSS via workflow-map/run-detail strings in React                 | HIGH→MED | A03 / CWE-79               |
| T10    | Report `artifactUri` traversal / arbitrary local-file read       | HIGH     | A01/A05 / CWE-22,23,73     |
| T11    | Served report XSS regains same-origin (sandbox/CSP)              | HIGH     | A05/A03 / CWE-1021,79      |
| T12    | Secrets/credential strings leaking to stream/logs/URLs           | MEDIUM   | A09/A02 / CWE-532,598      |
| T13    | Server-framework supply chain & secure-config                    | MEDIUM   | A06/A05 / CWE-1104,1035    |

---

## Per-ticket MUST controls (the security gate enforces these)

### #93 — E5.1: API HTTP surface + submit-a-run

- **M93.1 (T1)** `buildPath` validated + confined via the E1 `AppBundlePathValidator` shape against a config-owned
  builds base dir (leading-`-` reject, `..` fast-fail, `.app` allowlist, realpath + base-dir containment) **before**
  any `simctl` argv; failure → JSON error envelope, **no partial run**; no shell string ever formed (execFile/argv).
- **M93.2 (T2)** `appName` length/charset-bounded at ingress (reject CR/LF/control chars), carried as opaque text;
  structured logging only — never the raw path/name in a forgeable log message.
- **M93.3 (T3)** Server binds **loopback only** (`127.0.0.1`/`::1`) — the current `0.0.0.0` bind is removed; no env
  knob widens it to a public interface.
- **M93.4 (T4)** State-changing + stream routes enforce an **Origin/Referer allowlist** (dashboard origin only) **and**
  a **loopback `Host`-header check** (anti-DNS-rebind); CORS is **not** wildcarded / no credentialed wildcard.
- **M93.5 (T13)** HTTP framework + middleware exact-pinned, SCA clean in `--prod`; error handler returns the JSON
  envelope with **no stack trace / internal path**.

### #94 — E5.2: Watch a crawl live (SSE relay + live panel)

- **M94.1 (T5)** All event strings render as default-escaped JSX text — **`dangerouslySetInnerHTML` FORBIDDEN** on the
  event path (live panel, activity log, error banner); no event string into `href`/`src`/`style` unvalidated.
- **M94.2 (T6)** Client disconnect **and** terminal event invoke the `CrawlEventStream.subscribe` unsubscribe fn and
  close the response — no leaked subscriber/socket; a sane bound on concurrent streams.
- **M94.3 (T7)** SSE envelope **schema-validated** on relay (kind string, runId matches, timestamp well-formed);
  payload is opaque JSON (never `eval`/concatenated); unknown kinds relayed + rendered inert (no raw-HTML branch keyed
  on kind) — preserving the E6 seam.
- **M94.4 (T12)** No event payload logged verbatim in a way that could carry an unredacted value; relies on the E2
  redaction invariant (do not un-redact `credential:prompt`/`crawl:error` messages).
- **M94.5 (T4)** The SSE route inherits the Origin/Host gate (M93.4).

### #95 — E5.3: Runs history + run detail

- **M95.1 (T8)** `runId` bound/validated at ingress (not-found → JSON error envelope, no leaked stack/SQL); `cursor`
  treated as opaque, malformed → **first page** (never 500) — restating E7 T4 at the API boundary; no string-built query.
- **M95.2 (T9)** Run `appName`/status/metadata render as default-escaped JSX text — **no `dangerouslySetInnerHTML`**;
  no reflected raw `runId` in an unescaped context.
- **M95.3 (T4)** Read routes inherit the Origin/Host gate; CORS closed.

### #96 — E5.4: Browse the workflow map

- **M96.1 (T9)** `appPurpose`, workflow `name`/`description`/`featureGroup`, step `description`, `StateNode.label`
  render as default-escaped JSX text — **`dangerouslySetInnerHTML` FORBIDDEN**; hidden/duplicate indicators are
  structural UI (badges/classes), not raw HTML from untrusted strings. Satisfies FR4 "output-encoded, no active content".
- **M96.2 (T8)** The map data endpoint binds `runId`; map-not-ready/absent → clear not-ready state (no 500, no broken view).
- **M96.3 (T4)** Map route inherits the Origin/Host gate.

### #97 — E5.5: Serve & open the HTML report, sandboxed + traversal-safe

- **M97.1 (T10)** `artifactUri` resolved as **untrusted**, contained to `FLOWSCOUT_ARTIFACTS_DIR` via the E1 shape
  (`..` fast-fail, absolute-outside reject, realpath symlink-resolve, base-dir containment with trailing-`/` guard);
  every screenshot/asset read shares the same containment; escape → error, **serve nothing**; **no directory listing**;
  empty-sentinel / not-finished → "report not available".
- **M97.2 (T10)** Response served with fixed **`Content-Type: text/html`** + **`X-Content-Type-Options: nosniff`** (no
  path-based MIME sniffing).
- **M97.3 (T11)** Report embedded in **`<iframe sandbox>` with NO `allow-same-origin`** (opaque origin) and
  **`allow-scripts` withheld** (E4 artifact is script-free); **never `allow-scripts` + `allow-same-origin` together**.
- **M97.4 (T11)** Served artifact carries a **real response-header CSP** (`default-src 'none'; img-src data:; style-src
'unsafe-inline'; script-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`); distinct
  origin/port RECOMMENDED if the ADR selects it (defense-in-depth over this mandatory floor).
- **M97.5 (T13)** Static serving (if any) uses the framework's path-safe file API under the contained root — never raw
  `path.join(root, untrusted)`.

---

## Cross-epic handoffs (do not drop)

- **← E4 (received):** the "→ E5" flag lands here — served over `http`, an E4-report XSS regains same-origin blast
  radius, so E5 serves it **sandboxed (no `allow-same-origin`) + real response-header CSP** and resolves `artifactUri`
  **traversal-safe** (T10/T11). The E4 encoding contract + `<meta>` CSP stay load-bearing under E5.
- **← E1 (reused):** the `AppBundlePathValidator` containment shape (CWE-22/88) is reused for **both** #93 buildPath and
  #97 artifactUri; E1's `execFile`/argv `simctl` discipline is inherited (no new shell-out).
- **← E7 (reused/restated):** the store parameterizes `runId`/`cursor` (T3/T4); E5 restates the **API-layer** bound-param
  obligation (T8) and must not reflect raw params into error envelopes.
- **← E2 (relied upon):** the single redaction boundary + 2FA-stops-before-decide invariant means events reach E5
  already-redacted; E5 must **not un-redact** (T12).
- **→ E6 (vault) — flag:** E5 ships the FR7 relay seam only. When **E6** adds the 2FA/credential prompt UI + an
  **operator-response route**, that route is a **new state-changing endpoint** and MUST inherit the **T4 Origin/Host
  CSRF gate** and the **T12 no-secret-in-URL/log** invariant; the operator's typed credential/OTP travels the write path
  redacted-at-rest per E2 and **must never enter a query string, a log line, or the SSE relay unredacted**. The vault's
  encrypted-at-rest storage is E6's own threat model (not E5). See [[scope-boundaries]], [[recurring-risks-redaction-2fa-noprod]].

---

## Verdict policy for the E5 security gate (per ticket, post-implementation)

- **Critical / High → FAIL** (block, route to developer). The HIGH controls are **T1 (buildPath confinement)**,
  **T3 (loopback-only bind)**, **T4 (Origin/Host CSRF+rebind gate)**, **T10 (artifactUri traversal containment)**,
  **T11 (iframe sandbox without `allow-same-origin` + response CSP)**, and the HIGH-blast-radius XSS in **T5/T9** if any
  `dangerouslySetInnerHTML` lands on untrusted data — any of these unmet is a **FAIL**.
- **Medium → must fix, or open a tracked follow-up and PASS-with-conditions** (never silently dropped) — T2, T6, T7, T8,
  T12, T13.
- **Low → note** in the verdict.
- **Required scans did not run (gitleaks / SCA / SAST results absent) → BLOCKED** — do not PASS an unscanned diff. Mind
  CI scan ordering: an early Lint/Format failure can abort the job before gitleaks/SAST run → diff unscanned → BLOCKED
  (see [[recurring-risks-ci-scan-ordering]]). SCA stays `--prod`-scoped per [[mandated-scanning-policy]] — a High/Critical
  in a `--prod` path (e.g. the new HTTP framework) FAILs.

```

```
