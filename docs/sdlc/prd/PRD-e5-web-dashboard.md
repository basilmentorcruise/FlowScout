# PRD — E5: Web dashboard (run a crawl, watch live, browse map/reports, manage runs)

Epic: #5 · Tier: MVP · Owner: product · Status: draft (working-tree)

## Problem & users

FlowScout's autonomous engine (crawl, workflow map, HTML report, run store) exists but has **no surface
of its own** — today a run can only be driven from wiring/tests. Internal **developers and testers**
need to start a crawl, **watch it happen live** (this is where trust in an autonomous explorer is built),
and browse the results — all without a terminal or scripts.

The dashboard is FlowScout's own product surface. For MVP it is the **single entry point** for every run
and the **golden-path demo** vehicle.

## Golden path (THE demo flow — single machine, localhost)

1. Open the dashboard.
2. Point it at a build: enter an **app name** + the **`.app` build path** (the Dime app for the demo).
3. **Start the crawl.**
4. **Watch it live** — screens discovered so far, the current action, run status as it progresses.
5. When the run finishes, **browse the workflow map** (app purpose, feature-grouped workflows, the
   hidden/duplicate path the crawl found) and **open the grouped HTML report**.
6. Later, return to the dashboard and find the run in **history**; reopen its map/report.

## Goals

- Start a run from a browser form (app name + `.app` build path) → engine kicks off, run id returned.
- Live observation of an in-progress crawl over a streaming connection.
- Browse a run's workflow map and its rendered HTML report.
- List/manage past runs (history, newest-first) and reopen any run's results.
- Establish the API/UI seams the rest of MVP plugs into (E6 2FA prompt, E7 store) **without rework**.

## Non-goals (out of scope for MVP)

- **Auth / login / multi-user / RBAC** — localhost single-operator only.
- **Deployment / hosting / TLS / non-localhost binding** — runs on the operator's Mac only.
- **Credential-management UI and the 2FA pause-and-ask prompt UI** — **E6**. E5 only leaves the
  API/UI seam (see FR7); it does not build the prompt surface.
- **Run cancellation / pause / resume controls** — the engine terminates on budget/terminal events;
  no operator abort hook exists (see OQ5).
- **Report export/download, PDF, cross-run diff UI, theming/dark-mode, i18n, mobile-responsive polish.**
- **`.app` upload infrastructure** — MVP takes a local filesystem path (see OQ4).

## Requirements

### Functional

- **FR1 — API HTTP surface.** FlowScout exposes an HTTP API on localhost that injects the wired
  `AppContext` use-cases into routes. Every non-health route returns a consistent JSON error envelope
  on failure. Bound to localhost only (no external interface).
- **FR2 — Submit a run.** From the dashboard the operator submits an app name + `.app` build path; the
  API starts the crawl (`AppContext.startCrawlRun`) and returns a **run id**; the UI reflects that the
  run has started. Invalid/empty input is rejected with a readable message (run not started).
- **FR3 — Watch live.** The API streams `CrawlEvent`s for a run id over a live connection; the UI shows,
  as they arrive: **count of screens/states discovered**, the **current action**, **status transitions**,
  and the **terminal outcome** (completed / partial / blocked-on-2fa / error). Stream ends cleanly on
  terminal event or disconnect.
- **FR4 — Browse the workflow map.** For a finished run the UI renders the workflow map: app-purpose
  header, feature-grouped workflows, end-to-end steps, and the **hidden/duplicate-path** indicators
  (E3/E4 data). Untrusted map strings are output-encoded (no active content).
- **FR5 — Open the HTML report.** For a finished run the UI opens the rendered grouped HTML report (E4
  artifact). The report is served **sandboxed** (see NFR-SEC) and its `artifactUri` is resolved
  **without path traversal**, contained to the artifacts root.
- **FR6 — Manage runs / history.** The UI lists past runs newest-first (paginated), each with app,
  status, and timestamps; selecting one opens its detail (map + report entry points). Empty history
  shows a clear empty state.
- **FR7 — E6 seam (design-only).** The live-stream and run-detail surfaces are shaped so E6 can add a
  2FA/credential prompt and an operator response route **without reworking** the stream contract:
  unknown/`credential:prompt` event kinds are relayed, not dropped.

### Non-functional

- **NFR-SEC (report sandboxing — binds E4 threat model "Flagged for E5").** When E5 serves/embeds the
  E4 artifact over http, an XSS regains same-origin blast radius against the dashboard. Therefore the
  report **MUST** be served **sandboxed** (`<iframe sandbox>` and/or a **distinct origin**) **and**
  carry a real **response-header CSP**; and `artifactUri` **MUST** be resolved as **untrusted**,
  contained to `FLOWSCOUT_ARTIFACTS_DIR` (no path traversal / arbitrary-file-read). Screenshot/report
  file reads are contained to the artifacts root. See `docs/sdlc/security/e4-html-report-threat-model.md`.
- **NFR-WEB — MVVM.** The web app keeps the existing MVVM layering: views are passive, view-models hold
  state/intents, and the model boundary (`ApiClient`) is the only layer that talks HTTP.
- **NFR-LOCAL — single machine.** No external services beyond what the engine already needs; the whole
  flow runs on one Mac against a local durable store and a local artifacts dir.
- **NFR-OBS — no secrets in the UI/stream.** Events and error envelopes never surface credential values
  (the engine already redacts; the dashboard must not re-introduce them via logs/URLs).

## UX notes

- Golden-path-first: a single primary flow (submit → watch → browse). Keep chrome minimal.
- Live view favors **legibility of progress** over graph fidelity for MVP: a running counter of screens
  discovered + current action + an event/activity log is sufficient (live node-graph is out of scope —
  OQ3). Status must always be visible (running / finished / failed).
- Run detail exposes two clear affordances: **workflow map** and **open HTML report**.
- Designer spec required for: submit form, live-watch panel, runs-list/history, workflow-map browse,
  and the report-embed affordance.

## Success metrics

- An operator starts a crawl of the Dime build from the dashboard, watches states-discovered and current
  action update live, and — on completion — opens the grouped HTML report and finds the hidden/duplicate
  path, **with no CLI or scripting**.
- A returning operator finds the run in history and reopens its map/report.
- The served report cannot script the dashboard session (sandbox + CSP verified); a crafted `artifactUri`
  cannot read files outside the artifacts root.

## Edge cases & error states

- **Crawl fails mid-run** (`crawl:error` / driver dies): live view shows a terminal **error** state with
  the redacted message; the run is still discoverable in history (not silently lost — E7 running/finished
  convention). Map/report affordances degrade gracefully (may be absent/partial).
- **Empty history**: clear empty state, not a spinner or error.
- **Report missing / not yet generated** (artifact absent, `artifactUri` empty sentinel, run not
  finished): run detail shows "report not available" rather than a broken embed or a server error.
- **Map missing / partial** (no persisted graph yet, run still running): map view shows a not-ready state.
- **Unknown/new event kind** on the stream: relayed, not dropped (FR7 forward-compat).
- **Invalid `.app` path / app name**: rejected before starting; no partial run created.
- **Malformed pagination cursor**: treated as first page (repository already defends this).

## Open questions

- **OQ1 (architect)** — Workflow-map data source for FR4: served from the persisted `Report.workflowMap`
  (needs #84 write path) vs. built on demand via `BuildWorkflowMap`. Decides E5.4's real-data dependency.
- **OQ2 (architect/security)** — Report-serving mechanism for NFR-SEC: distinct origin/port vs.
  same-origin route with `<iframe sandbox>` + response-header CSP. Threat model requires sandbox+CSP; the
  exact mechanism is the architect's ADR call.
- **OQ3 (designer)** — Live-watch fidelity: MVP steer is counter + current action + activity log (no live
  node-graph). Confirm.
- **OQ4 (owner/product)** — `.app` input: local filesystem **path entry** (simplest for localhost demo,
  recommended) vs. file upload (deferred). Confirm path entry for MVP.
- **OQ5 (architect)** — Run cancellation: no engine abort hook exists today. Confirm cancellation is out
  of MVP scope (engine terminates on budget/terminal events only).

## Ticket breakdown

| #     | Title                                       | Depends-on                          |
| ----- | ------------------------------------------- | ----------------------------------- |
| #E5.1 | API HTTP surface + submit-a-run             | none (real completed run needs #84) |
| #E5.2 | Watch a crawl live (SSE relay + live panel) | E5.1                                |
| #E5.3 | Runs history + run detail (manage runs)     | E5.1, #85                           |
| #E5.4 | Browse the workflow map                     | E5.1, #84                           |
| #E5.5 | Serve & open the HTML report, sandboxed     | E5.1, #89, #87                      |

(Issue links filled after creation.)
