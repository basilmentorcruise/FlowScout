---
name: e5-dashboard
description: E5 (#93-#97) ADR-0010 rulings — Fastify confirmed, persisted-map OQ1, same-origin sandbox="" OQ2, no cancellation OQ5, verbatim SSE passthrough (E6 seam), 4 registration-line contention points
metadata:
  type: project
---

E5 web dashboard designed 2026-07-07: `e5-plan.md` + `ADR-0010-e5-dashboard-http-surface.md`.
Rulings to hold at gates:

- **Framework:** Fastify 5 confirmed for prod path, exact-pinned (was `^5.0.0` — gate on the pin, M93.5/T13).
- **OQ1:** map endpoint serves persisted `Report.workflowMap` via #85 `GetRunDetail`; a test must prove
  `BuildWorkflowMap` is never invoked on demand.
- **OQ2:** same-origin `/api/runs/:runId/report` + iframe `sandbox=""` + response-header CSP (M97.4 string) —
  NO distinct origin/port, NO CORS ever opened (dev = Vite proxy with rewrite-strip removed; demo = API serves
  `web/dist` at `/`).
- **OQ5:** run cancellation out of MVP (frozen StartCrawlRun; revisit V1 as additive collaborator).
- **SSE contract (E6 seam):** envelope-validate only (kind/runId/timestamp), then VERBATIM passthrough —
  unknown kinds byte-equivalent through; `event: end` control frame; no replay buffer (client reconciles via
  GET detail). Gate FAILs any relay that switches-on-kind to reshape payloads.
- **#93 additive engine seams:** `SubmitRun` (awaits boot/install/launch, saves running row pre-detach via
  shared `buildInitialRun` helper — idempotent with RunAndPersist step 1), new `AppBundleInspectorPort`
  (plutil argv-only), `Run.appName?` additive (+nullable column, +optional RunAndPersistInput field —
  sanctioned ADR-0008 §2 amendment, display-only never identity). New env `FLOWSCOUT_SIMULATOR_UDID`.
- **Parallelization:** #93 strictly first; #94–#97 concurrent; exactly 4 registration lines contend
  (`api/routes/index.ts`, `buildApiDeps.ts`, web `ApiClient.ts` facade, web route table). `/runs/:runId` page
  shell belongs to #95; #94's LivePanel plugs in (second-to-merge does the one-import integration).
  Merge order rec: 93→94→95→96→97.
- **Web:** hand-rolled ~60-LOC router (no react-router — YAGNI/T13), VM-as-hook idiom, `src/ui/` shared
  primitives all land in #93, per-feature `src/features/<f>/` dirs, `react/no-danger` lint on.

**Why:** T3/T4 made bind+origin-gate the load-bearing #93 controls; sandbox-without-allow-same-origin already
buys opaque-origin isolation so a second port was rejected.
**How to apply:** review-gate each E5 PR against the ticket's M9x controls + these rulings; FAIL on
`0.0.0.0`, opened CORS, kind-switching relay, on-demand map build, or any `dangerouslySetInnerHTML` on
untrusted data. Related: [[e7-run-persistence]], [[e4-html-report]].
