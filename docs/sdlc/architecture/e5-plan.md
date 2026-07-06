# E5 — Web dashboard: per-ticket implementation plan (#93 / #94 / #95 / #96 / #97)

- **Mode:** plan (design-time, epic #5). **ADR:** `docs/sdlc/architecture/ADR-0010-e5-dashboard-http-surface.md`.
- **Inputs (binding):** `docs/sdlc/prd/PRD-e5-web-dashboard.md` · `docs/sdlc/design/e5-dashboard-spec.md` +
  `docs/sdlc/design/system.md` · `docs/sdlc/security/e5-dashboard-threat-model.md` (T1/T3/T4/T10/T11 are HIGH
  and gate-blocking) · ADR-0008 (run store) · ADR-0009 (artifactUri relative to `FLOWSCOUT_ARTIFACTS_DIR`) ·
  `e7-plan.md` (#85 read-path queries) · PR #98 (#84 `RunAndPersist` + `AppContextWithRunPersistence`).
- **Sequencing context at plan time:** #84 is in gates (PR #98); #85 (read queries) and E4 #88/#89 are queued.
  E5 assumes #84/#85/#87/#89 land on `main` before the E5 ticket that consumes each (deps stated per ticket).
- Working-tree draft — do NOT commit with code; lands via the docs PR.

---

## 1. Decisions (D1–D7). Rationale in ADR-0010; rulings restated here for the developers.

### D1 — HTTP framework: **Fastify 5** (already the in-repo choice; confirm + exact-pin)

`packages/api` already depends on and boots Fastify (`index.ts`, `routes/health.ts`, ADR-0001 lineage). Ruling:
**keep Fastify** — no new supply chain (T13), first-class plugin encapsulation (route modules = plugins receiving
injected deps — exactly the DI shape FR1 requires, no ambient singletons), typed hooks for the Origin/Host gate
(T4) and the error envelope, raw-reply access for SSE, and `@fastify/static`'s path-safe `sendFile` for #97.
Native `http` would mean hand-rolling routing/body-parse/error handling (more code, same risk); Express adds an
equal dep for weaker TS + no plugin encapsulation. **M93.5:** pin `fastify` exact (drop `^`), same for any
`@fastify/*` middleware added (`@fastify/static` only, #97); SCA `--prod` must stay clean.

### D2 — PRD OQ1 ruling: map data source = **persisted `Report.workflowMap`** (never on-demand `BuildWorkflowMap`)

The golden path browses the map **after** completion, and #84 persists `Report` (with `workflowMap`) at finalize.
On-demand `BuildWorkflowMap` per page view would re-spend the LLM + embedding budget on every browse, be slow and
non-deterministic (two views of one run could disagree), and duplicate the #84 write path. Ruling: **#96's map
endpoint is a pure read** of the persisted report (via #85's `GetRunDetail` — no new query duplication). A run
with no persisted report ⇒ the spec's "Map not ready" / "No workflow map" states (client distinguishes by
`run.status`). Consequence: #96 depends on **#84** (writes the map) and **#85** (read-path use-case).

### D3 — PRD OQ2 ruling: report serving = **same-origin route + `sandbox=""` iframe + response-header CSP**

No distinct origin/port. Rationale: `sandbox` **without** `allow-same-origin` already places the report in a
**unique opaque origin** — the isolation a second port would buy — and the designer ruled `sandbox=""` (zero
allowances; the E4 artifact is contractually script-free). A second listener adds port lifecycle, a second bind
to audit under T3, and CORS complexity for zero marginal isolation. The T11 mandatory floor is fully met:

- `GET /api/runs/:runId/report` streams the artifact with fixed `Content-Type: text/html; charset=utf-8`,
  `X-Content-Type-Options: nosniff`, and the **response-header CSP** exactly per M97.4:
  `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; frame-ancestors 'self';
base-uri 'none'; form-action 'none'`.
- Embed: `<iframe sandbox="" title="<App name> workflow report">` — no `allow-scripts`, no `allow-same-origin`.
- `artifactUri` resolve is T10-contained (E1 `AppBundlePathValidator` shape) — see #97.

### D4 — PRD OQ5 ruling: **run cancellation is OUT of MVP** — confirmed

No abort hook exists on the engine; `StartCrawlRun`'s surface is frozen (ADR-0004) and adding cooperative
cancellation is engine surgery with no MVP payoff (runs terminate on budget/plateau/terminal events; the demo
budget bounds worst-case duration). The dashboard ships **no** cancel/pause/resume affordance. Revisit as a
V1 candidate (would enter as an additive engine collaborator, not a shell edit).

### D5 — API contract (owned by #93; every later route conforms)

**Prefix + origins.** All E5 routes live under **`/api/*`** (health stays at `/health`). This avoids SPA/API
path collisions (`/runs` is a dashboard route AND an API resource) and gives one gate scope. **No CORS is
opened — ever** (T4.3): in dev, the existing Vite proxy (`/api` → `:3000`; **remove the `rewrite` strip** —
one-line `vite.config.ts` change in #93) makes all browser traffic same-origin to `:5173`; in demo/prod mode
the API serves `packages/web/dist` statically at `/` with an SPA fallback (non-`/api` GET → `index.html`), so
everything is same-origin to `:3000`. CORS middleware is not installed; no `Access-Control-Allow-Origin` header
is ever emitted.

**Bind + gate (HIGH, #93, inherited by all).**

- **T3:** `listen({ host: "127.0.0.1" })` — the current `0.0.0.0` in `packages/api/src/index.ts:10` is removed;
  no env knob may widen the bind.
- **T4:** one `onRequest` hook plugin (`packages/api/src/security/originGate.ts`) applied to ALL routes:
  - `Host` must be a loopback literal on the expected port (`localhost` / `127.0.0.1` / `[::1]`) — anti-DNS-rebind.
  - Non-GET (state-changing) and the SSE route: `Origin` (fallback `Referer`) must be in the strict allowlist
    `{http://localhost:5173, http://127.0.0.1:5173, http://localhost:3000, http://127.0.0.1:3000}` (dev UI +
    served-mode origins). Missing/foreign Origin on a write ⇒ `403 forbidden`.
- Submit accepts **JSON content-type only** (non-simple request ⇒ preflight forced, T4.4).

**Routes.**

| Method | Path                      | Ticket | Purpose → response (200/2xx)                                                 |
| ------ | ------------------------- | ------ | ---------------------------------------------------------------------------- |
| GET    | `/health`                 | exists | unchanged                                                                    |
| POST   | `/api/runs`               | #93    | body `{appName, buildPath}` → validate (T1/T2) + prep + start; `201 {runId}` |
| GET    | `/api/runs?cursor&limit`  | #95    | `#85 ListRunHistory` → `{runs: RunListItem[], nextCursor, total}`            |
| GET    | `/api/runs/:runId`        | #95    | `#85 GetRunDetail` → `RunDetailDto` (run + availability flags)               |
| GET    | `/api/runs/:runId/events` | #94    | SSE relay of `CrawlEventStream.subscribe(runId, …)`                          |
| GET    | `/api/runs/:runId/map`    | #96    | persisted `WorkflowMap` JSON (D2)                                            |
| GET    | `/api/runs/:runId/report` | #97    | the E4 HTML artifact, T10-contained + T11 headers (D3)                       |
| GET    | `/api/artifacts/*`        | #97    | screenshot/asset reads, same containment, **image-MIME allowlist** + nosniff |

DTO notes: `RunListItem` = `{runId, appName (fallback appId), appId, status, startedAt, finishedAt}`;
`RunDetailDto` adds `{totalStates?, totalSteps?, totalWorkflows?, hasMap, hasReport}` (availability derived
server-side from the persisted report: `hasMap` = report row exists; `hasReport` = `artifactUri !== ""` —
ADR-0009 sentinel). Duration is computed client-side from `startedAt/finishedAt` (closes the designer's open
item: `finishedAt` is set for every terminal status uniformly — #84 finalize).

**Error envelope (FR1, every non-health route):**

```json
{ "error": { "code": "invalid_input" | "forbidden" | "not_found" | "map_not_available" | "report_not_available" | "internal", "message": "<human-readable, redacted, no stack/paths>" } }
```

HTTP status mirrors the code (400/403/404/404/404/500). A Fastify `setErrorHandler` owns the mapping — handlers
throw typed errors, never build envelopes inline (DRY, M93.5 no-stack guarantee in ONE place). Messages never
echo raw `buildPath`/params (T2/T8); the submit route maps use-case failures onto the spec's three copy cases.

**SSE contract (#94; the E6 seam — FR7/T7):**

```
: hb                                   ← comment heartbeat every 15s (dead-peer detection, T6)
event: crawl
data: <JSON of the CrawlEvent, verbatim>   ← one event per CrawlEvent received
event: end
data: {"reason":"terminal"} | {"reason":"already-finished"}
```

- **Relay = envelope-validate, then passthrough.** The server checks only `kind` is a string, `runId` matches
  the subscribed run, `timestamp` is a string — then `JSON.stringify`s the **whole event object verbatim** into
  one `data:` frame. It never switches on `kind` to reshape payloads. ⇒ **REQUIRED unknown-kind passthrough:**
  `credential:prompt` and any future kind reach the client byte-equivalent (E6 adds prompt UI with zero stream
  changes).
- **Lifecycle (T6):** on client disconnect (`request.raw.close`) AND on relaying a terminal kind
  (`crawl:finished` / `crawl:error`), the route invokes the `subscribe()`-returned unsubscribe and ends the
  response. If the run is already terminal at connect (checked via `RunRepository.findById`), send
  `end {"reason":"already-finished"}` immediately — no hanging stream. Concurrent-stream cap: small constant
  (e.g. 20) ⇒ 503 beyond it.
- **No replay buffer** (YAGNI): events before connect are lost; the client reconciles by fetching
  `GET /api/runs/:runId` on open, on `end`, and on `EventSource` error (the E7 store holds terminal truth).
  Accepted MVP limitation — recorded in ADR-0010.
- Client side: `EventSource`, strict `JSON.parse` of `data:` only (T7) — unknown kinds render as the spec's
  inert generic activity line.

**DI (FR1, no ambient singletons).** `packages/api/src/composition-root/buildApiDeps.ts` (#93, new) maps the
wired `AppContext` (+ its `AppContextWith*` extensions) onto **narrow per-feature dep slices** (ISP):

```ts
interface ApiDeps {
  submit: { launcher: RunLauncher }; // #93
  events: { stream: CrawlEventStream; runs: RunRepository }; // #94
  history: { listRuns: ListRunHistory; getRunDetail: GetRunDetail }; // #95
  map: { getRunDetail: GetRunDetail }; // #96
  report: { getRunDetail: GetRunDetail; artifacts: ArtifactResolver }; // #97
}
```

`index.ts` builds `ApiDeps` once and passes each slice into its route plugin at registration
(`app.register(runsRoutes, { deps: apiDeps.submit })`). Route modules import **types only** from
application/domain — never a concrete adapter (dependency-cruiser enforces).

### D6 — Web MVVM decomposition (NFR-WEB; dependency-light)

- **Routing: hand-rolled, no react-router.** Five static routes (`/`, `/runs`, `/runs/:runId`,
  `/runs/:runId/map`, `/runs/:runId/report`) don't justify a routing dependency (YAGNI + T13 surface). #93 lands
  `src/app/router.ts(x)`: a ~60-line History-API router — `useRoute()` hook (parses path → discriminated route
  value), `navigate(path)`, `<Link>`. Owning it makes the spec's route-change-focus rule (focus the new `<h1>`)
  a first-class router behavior instead of a react-router fight.
- **State: local VM state only.** No redux/zustand/query lib. Pattern stays the scaffold's idiom:
  **VM = custom hook with the `ApiClient` injected** (`useNewRunViewModel(api)`, `useLiveRunViewModel(api,
runId)`, `useRunsListViewModel(api)`, `useRunDetailViewModel(api, runId)`, `useMapViewModel(api, runId)`,
  `useReportViewModel(api, runId)`). Views are passive (render VM state, emit intents). SSE ownership lives in
  the live VM (subscribe on mount, teardown on unmount/terminal — the client half of T6).
- **Model boundary:** `src/model/ApiClient.ts` stays the **only** HTTP-talking layer (NFR-WEB) but becomes a
  thin **facade** over per-feature modules in `src/model/api/` — `http.ts` (shared fetch wrapper: JSON, envelope
  parsing, typed `ApiError`; #93) + `submit.ts` (#93), `events.ts` (SSE, #94), `history.ts` (#95), `map.ts`
  (#96), `report.ts` (#97). Each ticket adds one module + one facade line (see D7).
- **UI primitives:** `src/ui/` holds the `system.md` primitives. **#93 lands the cross-ticket set** (AppShellNav,
  skip link, Toast/Banner region, Card, Button, TextInput, Skeleton, Badge, EmptyState) so no two concurrent
  tickets touch a shared primitive. Single-consumer composites live in their feature dir: StatCounter +
  ActivityLogLine (#94), Table + Pagination (#95), Disclosure + Chip + Callout + PurposeHeader + WorkflowCard
  (#96), IframeEmbed (#97).
- **Feature dirs:** `src/features/<feature>/` per ticket — `new-run/` (#93), `live/` (#94), `runs/` (#95:
  list + run-detail shell incl. `RunSummary`), `map/` (#96), `report/` (#97). Each contains its views + VM +
  tests. `dangerouslySetInnerHTML` is forbidden repo-wide on untrusted data (T5/T9 — lint rule
  `react/no-danger` on, gate greps).

---

## 2. New engine-side seams #93 requires (small, additive — no frozen-surface edits)

The dashboard submits `{appName, buildPath}`, but `RunAndPersist` (#84) needs
`{runId, appId, appVersion, platform, udid, budget}` and the app must be installed/launched first (the E1.7 E2E
does this in its harness today — no production caller exists yet). #93 closes that gap with three additive pieces:

1. **`SubmitRun` application use-case** (`packages/application/src/run/SubmitRun.ts`, exposed to routes as the
   `RunLauncher` seam). Flow: validate inputs → resolve `udid` from config → `bootSimulator` (idempotent) →
   `installApp(udid, validatedPath)` → `readBundleInfo` → `launchApp(udid, bundleId)` → save the initial
   `running` row → **detach** `runAndPersist.execute(...)` (fire-and-forget; `RunAndPersist` owns its own
   error-finalize — M84.2) → return `{runId}`. Awaiting prep (boot/install/launch) keeps the spec's three
   submit-error copy cases honest (bad path / simulator unavailable / generic) and guarantees **no partial run**
   on any validation or prep failure (the row is saved only after prep succeeds). Saving the row before
   detaching kills the redirect race (`/runs/:runId` must resolve immediately); `RunRepository.save` is an
   upsert, so `RunAndPersist`'s own step-1 save of the same row is idempotent. Extract `RunAndPersist`'s private
   initial-row construction into an exported pure helper (`buildInitialRun` in `packages/application/src/run/`)
   reused by both — additive refactor, no behavior change to #84.
2. **`AppBundleInspectorPort`** (new domain port file, additive — the E1 facade freeze allows sanctioned
   additive port files): `readBundleInfo(appBundlePath): Promise<{ bundleId: string; version: string }>`.
   Implemented in `packages/adapters/mobile-mcp` (it owns plist/simctl discipline): `execFile("plutil", [...])`
   argv-only, `shell:false`, called ONLY with a validator-contained path (T1). `appId` = `bundleId`,
   `appVersion` = `CFBundleShortVersionString` (fallback `"0.0.0"`).
3. **`Run.appName?: string`** — additive optional field on the `Run` domain model + nullable SQLite column +
   repo mapping (amends ADR-0008 §2 additively; precedent: `artifactUri` E4-additive) + optional
   `appName` on `RunAndPersistInput` threaded into the initial row. Display fallback everywhere: `appId`.
   Without this, #95's history table cannot show the operator-entered app name (a `Run` today carries only
   `appId`).

Config (composition root reads, injects): `FLOWSCOUT_SIMULATOR_UDID` (required for real runs; device
auto-discovery deferred), `FLOWSCOUT_APP_BUNDLE_DIR` (existing — the T1 containment base; the operator's
`.app` must live under it), `FLOWSCOUT_ARTIFACTS_DIR` (existing, ADR-0009 — #97 containment base),
`defaultCrawlBudget()` for the budget.

---

## 3. Per-ticket plans

### #93 — E5.1: API HTTP surface + submit-a-run · branch `fs-93-api-submit-run`

**Blocking first ticket — everything else builds on its seams.** Depends-on: **#84 merged** (uses
`AppContextWithRunPersistence.runAndPersist`; when E4 #89 lands, the composition root swap to the decorated
`RunPersistAndRender` is invisible to this route — same seam).

- **API:** loopback bind (M93.3, removes `0.0.0.0`); `security/originGate.ts` (M93.4); `setErrorHandler`
  envelope (M93.5); `routes/index.ts` (registration point); `routes/runs.ts` → `POST /api/runs`;
  `composition-root/buildApiDeps.ts`; static serve of `web/dist` + SPA fallback (D5); exact-pin fastify.
- **Ingress validation:** `buildPath` through the E1 `AppBundlePathValidator` shape against
  `FLOWSCOUT_APP_BUNDLE_DIR` **before** anything touches simctl (M93.1); `appName` trimmed non-empty, max
  length (e.g. 200), reject control chars/CR/LF (M93.2); structured logging only.
- **Engine seams:** §2 items 1–3 (`SubmitRun`, `AppBundleInspectorPort` + adapter, `Run.appName`).
- **Web:** app shell + router + `src/ui/` cross-ticket primitives (D6); `src/model/api/http.ts` + `submit.ts`;
  `features/new-run/` (form per spec §2, exact copy §8); success → `navigate("/runs/:runId")`; placeholder
  run page (header + status via `GET /api/runs/:runId` once #95 lands — until then a minimal "run started"
  header keyed off the SSE/detail 404-tolerant fetch is acceptable ONLY as the in-ticket stub, replaced by #94).
- **HIGH controls landing here:** T1 (buildPath confinement), T3 (loopback bind), T4 (Origin/Host gate + closed
  CORS). Mediums: T2, T13.
- **Tests (≥85% line+branch on routes/use-case/validators):** T1 adversarial suite (`-Fflag.app`,
  `../../evil.app`, `/etc/passwd`, symlink escape, `x.app; rm -rf`) ⇒ rejected, no row, nothing reaches simctl;
  T4 foreign-Origin/attacker-Host ⇒ 403; T3 bind assert; envelope has no stack; `SubmitRun` happy path with
  fakes (row saved before return; detach verified); appName CR/LF test; web VM tests for the three error
  copies + submit states.
- **Touches:** `packages/api/src/{index.ts, security/, routes/{index,runs}.ts, composition-root/{wire.ts (one
ApiDeps/registration block), buildApiDeps.ts}, config/}` · `packages/application/src/run/{SubmitRun.ts,
buildInitialRun.ts, RunAndPersist.ts (additive input field only)}` + `index.ts` barrel ·
  `packages/domain/src/{models/run.ts (additive appName), ports/AppBundleInspectorPort.ts (new), index.ts}` ·
  `packages/adapters/mobile-mcp/src/` (inspector impl + barrel) · `packages/adapters/persistence/src/`
  (nullable column + mapping) · `packages/web/src/{app/, ui/, model/, features/new-run/}` + `vite.config.ts` ·
  `packages/api/package.json` (pin).

### #94 — E5.2: Watch a crawl live (SSE relay + live panel) · branch `fs-94-live-sse`

Depends-on: #93. Concurrent-safe with #95/#96/#97 after #93 (see §4).

- **API:** `routes/events.ts` → `GET /api/runs/:runId/events` per the D5 SSE contract: envelope-validate →
  verbatim passthrough (unknown kinds REQUIRED through — E6 seam), heartbeat, terminal/disconnect unsubscribe
  (M94.2/T6), already-terminal short-circuit via `RunRepository.findById`, stream cap. Inherits the Origin gate
  (M94.5). `events` slice added to `ApiDeps`.
- **Web:** `model/api/events.ts` (EventSource wrapper, strict JSON parse — M94.3); `features/live/` —
  `useLiveRunViewModel` (counters from `state:discovered`, current action from `action:taken`, activity log,
  terminal swap, reconnect banner logic per spec §3.2) + `LivePanel`, `StatCounter`, `ActivityLogLine`;
  `RunSummary` swap-in is #95's `runs/` feature — #94 renders the terminal outcome line + disabled-until-#95
  affordances inside `features/live/` ONLY if #95 hasn't landed; if #95 lands first, #94 plugs `LivePanel` into
  #95's `/runs/:runId` page shell (the page owns the `status==="running"` switch — spec §0.1).
- **HIGH controls:** T5 (no `dangerouslySetInnerHTML` on the event path). Mediums: T6, T7, T12.
- **Tests (≥85%):** relay passthrough byte-equivalence incl. unknown kind; unsubscribe called on disconnect AND
  terminal (subscriber set back to baseline); already-finished ⇒ immediate `end`; adversarial
  `label`/`message` renders inert; VM reconnect/terminal transitions; heartbeat present.
- **Touches:** `packages/api/src/routes/events.ts` (new) + one line each in `routes/index.ts` /
  `buildApiDeps.ts` · `packages/web/src/{model/api/events.ts (new), model/ApiClient.ts (one facade line),
features/live/ (new), app/routes registration (one line)}`.

### #95 — E5.3: Runs history + run detail · branch `fs-95-runs-history`

Depends-on: #93, **#85 merged** (consumes `ListRunHistory` / `GetRunDetail` + DTOs — no query duplication).

- **API:** `routes/history.ts` → `GET /api/runs` (cursor opaque; malformed ⇒ first page, restating E7 T4 at the
  boundary; `limit` default 20 / max 100) and `GET /api/runs/:runId` (runId shape-validated; unknown ⇒
  `not_found` envelope — M95.1). Maps #85 DTOs → `RunListItem`/`RunDetailDto` (D5) with `hasMap`/`hasReport`
  availability flags.
- **Web:** `model/api/history.ts`; `features/runs/` — runs table per spec §4 (row-as-link, `Running…` duration,
  `—` workflows placeholder, cursor Prev/Next), empty/error/skeleton states; the `/runs/:runId` **page shell**
  (spec §0.1: owns the running→terminal switch, renders #94's `LivePanel` while running) + `RunSummary`
  (outcome line + Map/Report affordances, disabled per `hasMap`/`hasReport`) + run-not-found state.
- **HIGH controls:** T9-half (no `dangerouslySetInnerHTML` on run metadata). Mediums: T8. Inherits T4.
- **Tests (≥85%):** malformed cursor ⇒ first page, no 500; bogus runId ⇒ 404 envelope, nothing reflected raw;
  pagination no-dup/no-skip over seeded fakes; VM/view states (empty, error, running-row); adversarial appName
  renders inert.
- **Touches:** `packages/api/src/routes/history.ts` (new) + one line each in `routes/index.ts` /
  `buildApiDeps.ts` · `packages/web/src/{model/api/history.ts (new), model/ApiClient.ts (one line),
features/runs/ (new), app/routes (one line)}`.

### #96 — E5.4: Browse the workflow map · branch `fs-96-workflow-map`

Depends-on: #93, **#84** (persisted map — D2), **#85** (`GetRunDetail` read path).

- **API:** `routes/map.ts` → `GET /api/runs/:runId/map`: `GetRunDetail` → return the persisted
  `report.workflowMap` verbatim JSON (strings stay raw+inert — React encodes on render, the E4/E7 T7 lineage);
  no report row ⇒ `404 map_not_available`; unknown run ⇒ `404 not_found` (M96.2).
- **Web:** `model/api/map.ts`; `features/map/` per spec §5 — `PurposeHeader`, `FeatureGroupSection`
  (Disclosure), `WorkflowCard` (hidden-path badge), duplicate-group `Callout` (copy/tokens identical to E4
  §5.2), step lists; screenshots via `<img src="/api/artifacts/<screenshotUri>">` with the "no screenshot
  captured" fallback on error — the artifacts route itself is #97's (screenshots light up when #97 merges;
  degraded-not-broken until then). States: skeleton / not-ready / none-generated / zero-workflows (client picks
  by `run.status` + the 404 code).
- **HIGH controls:** T9 (no `dangerouslySetInnerHTML` on any map string; hidden/duplicate indicators are
  structural UI). Mediums: T8. Inherits T4.
- **Tests (≥85%):** endpoint returns persisted map only (a spy proves `BuildWorkflowMap` is never invoked);
  404-code mapping; adversarial `appPurpose`/`name`/`label` strings render inert (grep + DOM test); the four
  view states; duplicate-callout renders canonical/hidden roles from data.
- **Touches:** `packages/api/src/routes/map.ts` (new) + one line each in `routes/index.ts` / `buildApiDeps.ts`
  · `packages/web/src/{model/api/map.ts (new), model/ApiClient.ts (one line), features/map/ (new), app/routes
(one line)}`.

### #97 — E5.5: Serve & open the HTML report, sandboxed · branch `fs-97-report-serve`

Depends-on: #93, **#87 + #89** (artifact rendered + `artifactUri` persisted).

- **API:** `artifacts/resolveArtifactPath.ts` — THE shared containment resolver (E1 shape: `..` fast-fail,
  reject absolute-outside, `realpath` symlink-resolve, base-dir containment with trailing-`/` guard) against
  `FLOWSCOUT_ARTIFACTS_DIR`; **every** read in this ticket goes through it (M97.1). `routes/report.ts` →
  `GET /api/runs/:runId/report` (lookup `artifactUri` via `GetRunDetail`; empty sentinel / missing / dir ⇒
  `404 report_not_available`; serve with fixed `text/html`, `nosniff`, the M97.4 CSP header — D3) and
  `GET /api/artifacts/*` (image-extension/MIME allowlist `png|jpeg|webp`, nosniff, no directory listing,
  same resolver). Static serving via `@fastify/static` `sendFile` under the contained root only (M97.5),
  exact-pinned.
- **Web:** `model/api/report.ts` (URL builder only — the iframe loads the route directly); `features/report/`
  per spec §6 — sticky back-bar, `IframeEmbed` with `sandbox=""` + `title`, skeleton-until-onLoad,
  not-ready / not-available states.
- **HIGH controls:** T10 (traversal containment), T11 (`sandbox=""` — no `allow-same-origin`, no
  `allow-scripts` — + response-header CSP). Mediums: T13.
- **Tests (≥85%):** traversal suite (`../../etc/passwd`, absolute out-of-root, symlink escape) ⇒ 404/error,
  nothing read outside root — asserted on BOTH report and artifacts routes; empty-sentinel ⇒ not-available;
  response headers assert CSP + nosniff + fixed content-type; embed markup test: `sandbox` present with zero
  allowances; fixture artifact with `<script>`/`onerror` cannot reach the parent (opaque origin) and does not
  execute; no directory listing.
- **Touches:** `packages/api/src/{artifacts/ (new), routes/report.ts (new)}` + one line each in
  `routes/index.ts` / `buildApiDeps.ts` · `packages/api/package.json` (`@fastify/static`, pinned) ·
  `packages/web/src/{model/api/report.ts (new), model/ApiClient.ts (one line), features/report/ (new),
app/routes (one line)}`.

---

## 4. Parallelization, contention points, merge order

**#93 is strictly first** — it owns the bind/gate/envelope, `ApiDeps`, `routes/index.ts`, the web shell/router/
`src/ui/`/`model/api/http.ts`, and the engine seams. Nothing else starts before #93 merges.

**#94–#97 are concurrent-safe after #93** by file-level construction: each adds ONE new route file, ONE new
`model/api/` module, and ONE new `features/` dir — all disjoint. The only shared files are **four
registration lines**, each a one-line append:

1. `packages/api/src/routes/index.ts` — one `register(<feature>Routes, …)` line per ticket.
2. `packages/api/src/composition-root/buildApiDeps.ts` — one dep-slice field per ticket.
3. `packages/web/src/model/ApiClient.ts` — one facade line per ticket.
4. `packages/web/src/app` route table — one route entry per ticket.

Worst-case conflict between any two E5 tickets = a trivial rebase on those four lines. One soft seam to
coordinate: the `/runs/:runId` **page shell** belongs to #95 (`features/runs/`), and #94's `LivePanel` plugs
into it — whichever merges second does the one-import integration (both tickets' plans above state each side).

**Engine-dependency-driven start order** (not E5-internal): #94 needs only #93; #95 needs #85; #96 needs
#84+#85; #97 needs #87+#89. **Recommended merge order: #93 → #94 → #95 → #96 → #97** (matches dependency
readiness and puts the shell (#95) in before its biggest consumer (#96); #97 last so its artifacts route is
live for #96's screenshots by demo time). Any other order among #94–#97 is safe modulo the four lines.

## 5. Test strategy & coverage gate (per-layer targets)

- **`packages/api` routes/security/resolvers + `packages/application` SubmitRun: ≥85% line + branch.** The
  adversarial suites (T1 path suite, T4 origin/host suite, T10 traversal suite, SSE T6/T7 suite) are named
  gate checks — the security gate reads them, the architecture gate reads the coverage report.
- **`packages/web` view-models + `model/api/`: ≥85% line + branch** (vitest + jsdom; add
  `@testing-library/react` + `jsdom` as devDeps in #93, pinned). Views/primitives: rendered-state tests for
  every spec state (empty/loading/error/disabled/not-ready) — presentational markup itself isn't
  branch-counted against the 85% (VMs hold the logic; passive views).
- **E2E smoke (#97 closes the epic):** submit (fake driver) → SSE events observed → history row → map JSON →
  report served with CSP headers. Reuses the E1.8 fixture app where a real simulator is available; fake-driver
  path in CI.

## 6. Risks

- **R1 — Submit request latency:** awaiting boot/install/launch in `POST /api/runs` can take tens of seconds
  cold. Accepted for the localhost MVP (spec's `Starting…` state covers it); generous client timeout. If it
  proves painful, move prep behind the detach and add a `run:preparing` event — additive, no contract break.
- **R2 — No SSE replay:** events before connect are lost (D5). Accepted; the store reconcile-on-connect covers
  terminal truth. A ring buffer in the relay is the additive fix if the demo shows visible undercount.
- **R3 — `wire.ts` traffic:** #93 edits `wire.ts` (ApiDeps wiring) while #85/#89 also each add a line there.
  Serialize: #85 and #89 land before #93 starts (they're ahead in the queue); coordinator owns any residual
  one-line rebase.
- **R4 — appName domain addition:** additive-optional keeps every existing consumer compiling, but the
  persistence column + #84's input threading must land together in #93 — flagged for the architecture gate
  (no drift: `appName` never becomes load-bearing for identity; display-only).
- **R5 — Hand-rolled router:** owning ~60 LOC of history-API code. Mitigated by full VM-level tests + the
  route-change-focus test; swap-for-a-lib remains a contained change behind `useRoute()` if V1 outgrows it.
- **R6 — `plutil` availability:** the bundle inspector shells `plutil` (macOS-only). Fine for MVP (iOS-first,
  operator Mac — CLAUDE.md); the port seam keeps a pure-TS plist parser swappable if CI ever needs it.

## Per-ticket Touches summary (coordinator batching)

| Ticket | Touches (disjoint except the four registration lines)                                                                                                                                                                                                                                                                                                                |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #93    | `api/src/{index,security/,routes/{index,runs},composition-root/,config/}` · `application/src/run/{SubmitRun,buildInitialRun,RunAndPersist(additive)}` · `domain/{models/run(additive),ports/AppBundleInspectorPort(new)}` · `adapters/mobile-mcp(inspector)` · `adapters/persistence(column)` · `web/src/{app/,ui/,model/,features/new-run/}` · `web/vite.config.ts` |
| #94    | `api/src/routes/events.ts` · `web/src/{model/api/events.ts,features/live/}` · +4 reg lines                                                                                                                                                                                                                                                                           |
| #95    | `api/src/routes/history.ts` · `web/src/{model/api/history.ts,features/runs/}` · +4 reg lines                                                                                                                                                                                                                                                                         |
| #96    | `api/src/routes/map.ts` · `web/src/{model/api/map.ts,features/map/}` · +4 reg lines                                                                                                                                                                                                                                                                                  |
| #97    | `api/src/{artifacts/,routes/report.ts}` · `api/package.json(@fastify/static)` · `web/src/{model/api/report.ts,features/report/}` · +4 reg lines                                                                                                                                                                                                                      |
