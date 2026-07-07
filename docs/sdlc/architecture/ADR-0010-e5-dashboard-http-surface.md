# ADR-0010 — E5 web dashboard: HTTP surface, map/report serving mechanics, and MVVM decomposition

- **Status:** Accepted
- **Date:** 2026-07-07
- **Mode:** plan (E5 epic #5 — web dashboard; tickets #93/#94/#95/#96/#97)
- **Scope:** `packages/api/**` (first real network surface), `packages/web/**` (dashboard SPA), small additive
  seams in `packages/application/src/run`, `packages/domain` (one new port file + one optional `Run` field),
  `packages/adapters/{mobile-mcp,persistence}` (inspector impl / nullable column).
- **Relates to:** ADR-0001 (stack: the Fastify + React/Vite scaffolds this ADR now commits to prod use),
  ADR-0008 (run store; §2 `Run` amended additively with `appName?`), ADR-0009 (relative `artifactUri` — this
  ADR is its "E5 fit" consumer), companion plan `e5-plan.md`, binding threat model
  `docs/sdlc/security/e5-dashboard-threat-model.md` (T1/T3/T4/T10/T11 HIGH).

---

## 1. Decision — HTTP framework: Fastify 5 (confirmed for prod path; exact-pinned)

Fastify is already `packages/api`'s dependency and boots today (`index.ts`). E5 confirms it as the prod HTTP
framework rather than replacing it:

- **DI fit (FR1):** route modules are Fastify **plugins** receiving injected dep slices at registration — no
  ambient singletons; the composition root stays the only adapter-naming place.
- **Security fit:** one `onRequest` hook implements the T4 Origin/Host gate for every route; `setErrorHandler`
  centralizes the no-stack JSON envelope (M93.5); `@fastify/static`'s `sendFile` is a path-safe file API (M97.5).
- **Rejected:** native `http` (hand-rolled routing/body-parsing/error handling = more owned code, same risk,
  worse DX for zero dep saved — fastify is already in the tree); Express (equal supply-chain weight, weaker
  TypeScript, no plugin encapsulation, slower maintenance cadence).
- **Obligation (T13/M93.5):** `fastify` and `@fastify/static` move to **exact pins** (no `^`), lockfile
  committed, SCA `--prod` clean.

## 2. Decision (PRD OQ1) — workflow-map source: persisted `Report.workflowMap`, never on-demand

`GET /api/runs/:runId/map` returns the map **persisted by #84's finalize path**, read via #85's `GetRunDetail`.
On-demand `BuildWorkflowMap` per browse was rejected: it re-spends the run's LLM + embedding budget on every
page view, is slow and non-deterministic (two views could disagree), and duplicates the #84 write orchestration.
The demo browses **after** completion, so persistence is always ahead of the read. Absent report ⇒
`404 map_not_available` ⇒ the spec's not-ready/none states. Consequence: #96 depends on #84 (write) + #85 (read).

## 3. Decision (PRD OQ2) — report serving: same-origin route + `sandbox=""` iframe + response-header CSP

Rejected the distinct-origin/port alternative. `<iframe sandbox>` **without `allow-same-origin`** already gives
the report a **unique opaque origin** — the exact isolation a second port would buy — and the designer ruled
`sandbox=""` (zero allowances; the E4 artifact is contractually script-free, so `allow-scripts` is withheld
too). A second listener would add port lifecycle, a second bind to audit under T3, and CORS complexity for no
marginal isolation. The T11 mandatory floor ships in full on the same-origin route:

- `GET /api/runs/:runId/report`: fixed `Content-Type: text/html; charset=utf-8`, `X-Content-Type-Options:
nosniff`, response-header CSP `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src
'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'` (M97.4).
- `artifactUri` resolved as untrusted, contained to `FLOWSCOUT_ARTIFACTS_DIR` via the E1
  `AppBundlePathValidator` shape (T10); asset reads (`GET /api/artifacts/*`) share the resolver, image-MIME
  allowlist, no directory listing.

## 4. Decision (PRD OQ5) — run cancellation: out of MVP

No abort hook exists; `StartCrawlRun` is frozen (ADR-0004); runs self-terminate on budget/plateau/terminal
events, bounding demo duration. No cancel/pause/resume UI ships. Revisit at V1 as an additive engine
collaborator (cooperative cancellation token through the loop), never a shell edit.

## 5. Decision — API contract conventions (full table in `e5-plan.md` §D5)

- **`/api/*` prefix** for all E5 routes (avoids SPA/API path collisions; single gate scope). Health stays `/health`.
- **Same-origin everywhere, CORS never opened:** dev traffic rides the existing Vite proxy (rewrite-strip
  removed so `/api` passes through); demo mode serves `web/dist` from the API at `/` with SPA fallback. No
  `Access-Control-Allow-Origin` is ever emitted (T4.3).
- **T3:** bind `127.0.0.1` only (replaces the current `0.0.0.0`); no env widening. **T4:** loopback `Host`
  check on all routes + strict `Origin` allowlist on writes and the SSE stream; JSON-only writes force preflight.
- **Error envelope:** `{ error: { code, message } }`, codes `invalid_input | forbidden | not_found |
map_not_available | report_not_available | internal`; one `setErrorHandler` owns mapping; no stack/paths;
  no raw param echo.
- **SSE (the E6 seam, FR7/T7):** `event: crawl` frames carry the `CrawlEvent` JSON **verbatim** after
  envelope-only validation (`kind` string, `runId` match, `timestamp` string) — **unknown kinds pass through
  untouched** (E6's `credential:prompt` UI needs zero stream changes). `event: end`
  (`{"reason":"terminal"|"already-finished"}`) precedes close; `: hb` heartbeat every 15s; unsubscribe on
  disconnect AND terminal (T6). **No replay buffer** (accepted MVP limitation): clients reconcile against
  `GET /api/runs/:runId` on connect/end/error — the E7 store is terminal truth.

## 6. Decision — submit path engine seams (additive only)

`POST /api/runs` maps `{appName, buildPath}` onto the engine via a new application use-case **`SubmitRun`**
(validate → boot/install/launch via `SimulatorLifecycle` → save initial `running` row → detach
`RunAndPersist.execute` → return `runId`). Supporting additive pieces: **`AppBundleInspectorPort`** (new domain
port; mobile-mcp adapter impl reads `CFBundleIdentifier`/version via argv-only `plutil` on a
validator-contained path) and **`Run.appName?`** (optional field + nullable column, amending ADR-0008 §2
additively — display-only, never identity). Prep is awaited so submit failures map to the spec's error copy
and **no partial run** is ever created; the pre-detach row save (shared `buildInitialRun` helper, idempotent
upsert with `RunAndPersist` step 1) removes the redirect race. Config: `FLOWSCOUT_SIMULATOR_UDID` (new,
required), existing `FLOWSCOUT_APP_BUNDLE_DIR` (T1 base) and `FLOWSCOUT_ARTIFACTS_DIR` (T10 base).

## 7. Decision — web MVVM decomposition (NFR-WEB; dependency-light)

- **No router dependency:** a ~60-line owned History-API router (`useRoute()` / `navigate()` / `<Link>`) for
  five static routes — YAGNI + T13 surface + first-class route-change-focus (spec a11y rule). Swap seam kept
  behind `useRoute()`.
- **No state library:** VM = custom hook with constructor-injected `ApiClient` (existing scaffold idiom);
  views passive.
- **Model boundary:** `ApiClient` facade over per-feature `src/model/api/` modules — the only HTTP layer.
- **Feature dirs** `src/features/<feature>/` per ticket + shared `src/ui/` primitives landed in #93, giving
  file-level disjointness for concurrent tickets (four one-line registration points; `e5-plan.md` §4).
- `dangerouslySetInnerHTML` forbidden on untrusted data repo-wide (T5/T9), enforced by lint + gate grep.

## 8. Consequences & risks

- **Positive:** first network surface ships with the HIGH controls structural (bind/gate/envelope in one place
  each); E6 gets its prompt seam for free (verbatim SSE passthrough + a gate-inherited write-route pattern);
  concurrent E5 tickets conflict on exactly four registration lines; no new heavy deps (one `@fastify/static`).
- **R-latency:** awaited boot/install in submit — accepted (localhost MVP; `Starting…` state); additive fix is
  a `run:preparing` event behind the detach.
- **R-replay:** SSE has no catch-up; counters can undercount on late connect — accepted; ring buffer is the
  additive fix.
- **R-owned-code:** hand-rolled router + verbatim relay are owned LOC; both are small, fully tested, and behind
  seams (`useRoute()`, the route plugin).
- **Coverage gate:** api routes/security/resolvers + `SubmitRun` + web VMs/model ≥ **85% line + branch**;
  named adversarial suites (T1 path, T4 origin/host, T10 traversal, T6/T7 SSE) are explicit gate checks.
