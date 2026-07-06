---
name: project-e5-breakdown
description: How E5 (web dashboard) was sliced into tickets #93-#97, the server-foundation-first cut, and the report-sandbox security binding to E4
metadata:
  type: project
---

E5 (epic #5, FlowScout's own web dashboard — run a crawl, watch live, browse map/reports, manage runs) was
broken into 5 vertical slices. PRD: docs/sdlc/prd/PRD-e5-web-dashboard.md. Golden path = the demo flow: open
dashboard → point at Dime .app + app name → start crawl → watch live → browse workflow map + open HTML report.

- #93 E5.1 API HTTP surface + submit-a-run — stands up the localhost HTTP API (AppContext injected into routes,
  JSON error envelope, localhost bind) AND the first capability: submit app name + `.app` path → start crawl →
  return runId. Depends-on NONE (route/UI testable against port with fakes; a REAL persisted completed run needs
  #84 but that is NOT a hard blocker). type:feature. Needs designer.
- #94 E5.2 Watch a crawl live — SSE relay off the existing CrawlEventStream + live panel (states-discovered count,
  current action, status, terminal). Depends-on #93. Uses CrawlEventStream port + InProcessCrawlEventStream on
  main — NOT #84. type:feature. Needs designer.
- #95 E5.3 Runs history — list past runs (paginated, newest-first) + run detail. Depends-on #93 + #85 (read-path
  query use-cases). type:feature. Needs designer.
- #96 E5.4 Browse the workflow map — purpose header, feature groups, end-to-end steps, hidden/duplicate-path
  indicators; untrusted strings output-encoded. Depends-on #93 + #84 (needs a persisted run/map). type:feature.
  Needs designer.
- #97 E5.5 Serve & open the HTML report, SANDBOXED — the E4 threat-model "Flagged for E5" handoff. Depends-on
  #93 + #89 (artifactUri populated) + #87 (artifact exists). type:feature. Needs designer (minimal).

**Grounding on main (why this cut):**

- packages/api/src/index.ts boots Fastify with ONLY the /health route; no AppContext injected into routes, no
  runs/status/SSE/list/report routes → the server foundation genuinely does not exist, so E5.1 must stand it up
  (server-first, then #94-#97 parallelize after it).
- CrawlEventStream port (packages/domain/src/ports/CrawlEventStream.ts) + a wired InProcessCrawlEventStream bus
  exist (wire.ts line ~79 comment: "replaced in E5 with SSE relay"). Live-watch is a relay, not new plumbing —
  and it works off the in-process bus independent of the durable store, so #94 does NOT depend on #84.
- StartCrawlRun wired via AppContext.startCrawlRun; BuildWorkflowMap via AppContext.buildWorkflowMap.
- RunRepository.listRuns (cursor-paginated) + findById already on the port; #85 supplies the read-path use-cases
  #95 calls. Report.metadata.artifactUri filled by #89; reports are static HTML at FLOWSCOUT_ARTIFACTS_DIR
  (ADR-0009), artifactUri relative. Web is MVVM (model/ApiClient = only HTTP layer; view-models; passive views).

**Key scope decisions (don't let downstream contradict):**

- SECURITY BINDING (#97): E4 threat model docs/sdlc/security/e4-html-report-threat-model.md "→ E5 flag" REQUIRES
  the served report be sandboxed (`<iframe sandbox>` and/or distinct origin) + real response-header CSP, and
  artifactUri resolved as UNTRUSTED, contained to FLOWSCOUT_ARTIFACTS_DIR (no `..`/absolute/symlink traversal,
  screenshot reads contained too). Baked into #97 ACs. This is the load-bearing NFR of E5.
- E6 SEAM (design-only, #94): SSE relay must pass through `credential:prompt`/unknown event kinds (not drop them)
  so E6 can add a 2FA prompt UI + operator response route without changing the stream contract. AC in #94. E5
  does NOT build the 2FA/credential prompt UI.
- Out of scope (MVP steer — urgent single-machine localhost demo): auth/login/multi-user/RBAC, deployment/TLS/
  non-localhost binding, credential-mgmt + 2FA prompt UI (E6), run cancel/pause/resume (no engine abort hook),
  report export/PDF/download, cross-run diff UI, theming/dark-mode/i18n, `.app` UPLOAD (path entry only), live
  node-graph viz (counter + current action + activity log only).
- Open questions: OQ1 architect (map source: persisted Report.workflowMap vs live BuildWorkflowMap → #96 dep),
  OQ2 architect/security (report-serving mechanism: distinct origin vs same-origin sandbox+CSP route), OQ3
  designer (live-watch fidelity — confirm counter+action+log, no node-graph), OQ4 owner (.app path entry vs
  upload — recommend path), OQ5 architect (confirm run cancellation out of MVP; no abort hook exists).

See [[project-e4-breakdown]], [[project-e7-breakdown]], [[project-flowscout-sdlc-pipeline]]. All 5 issues on
Project #4 Status=Todo, labels mvp + type:feature, linked to epic #5 via a checklist comment.
