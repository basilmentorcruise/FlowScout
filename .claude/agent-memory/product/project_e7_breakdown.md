---
name: project-e7-breakdown
description: How E7 (run persistence — crawl graph + report store) was sliced into tickets #83-#85, the store-choice ADR gate, and MVP scope cuts
metadata:
  type: project
---

E7 (epic #7, run persistence — durable per-run graph + report store) was broken into 3 vertical slices.
PRD: docs/sdlc/prd/PRD-e7-run-persistence.md.

- #83 E7.1 Durable run store (Run + StateGraph + Report), roundtrip by run id — depends ONLY on the #7
  store-choice ADR; type:task. Replaces the throwing `Prisma*` stubs in packages/adapters/persistence.
- #84 E7.2 Persist a run automatically through the crawl pipeline (create-at-start, finalize-at-finish,
  save report) — Depends-on #83; type:feature. Write path.
- #85 E7.3 Run history: list runs (paginated, newest-first) + retrieve by id — Depends-on #83; type:feature.
  Read path. #84 and #85 are disjoint (write vs read) and parallel after #83, but BOTH edit packages/api
  wire.ts so merge order is not fully free.

**Grounding on main (why this cut):** the three ports (`RunRepository`, `StateGraphRepository`,
`ReportRepository`) already exist in packages/domain/src/ports/RepositoryPorts.ts. But production wiring
(packages/api/.../wire.ts) injects the `Prisma*` **stubs that throw notImplemented**, `StartCrawlRun` never
creates a `Run` record (no runRepository in its collaborators — only stateGraphRepository/crawlEventStream),
and `BuildWorkflowMap` returns an in-memory `WorkflowMap` never saved as a `Report`. So E7 is: (1) make the
store durable [#83], (2) wire the write path so a crawl auto-persists [#84], (3) add the read/history capability
[#85]. Tickets are store-agnostic against the existing port signatures — Specify WHAT not HOW.

**Store choice is the architect's ADR (deliberately NOT picked):** the stub comment + ADR-0001 §2.7 assume
PostgreSQL+Prisma, but the product steer was an URGENT single-machine demo (real crawl -> HTML report +
dashboard on one Mac) favoring the SIMPLEST zero-external-setup durable store (e.g. embedded/file/SQLite)
unless the architect rules otherwise. Recorded as PRD OQ1 and as #83's Depends-on note. #83 depends only on
that ADR.

**Key scope decisions (don't let downstream contradict):**

- OQ2: `RunStatus` (completed|partial|blocked-on-2fa|error) has NO in-progress value. Crash-mid-crawl edge
  case (FR4) needs a started-but-unfinished run to be discoverable — via `finishedAt=null` convention or an
  additive `running` status. Representation = architect's call; the requirement (run not silently lost) is fixed.
- OQ3: E7 persists report DATA (WorkflowMap + metadata + counts); E4 fills `ReportMetadata.artifactUri` with
  the rendered HTML (additive-only). Don't let E7 render HTML.
- Deferred to post-MVP (out of scope, noted in PRD): cross-version diffing (`findStatesByApp` stays empty),
  retention/GC, migrations tooling polish, resume/replay of a crashed run. HTTP routes + dashboard UI are E5
  (E7.3 provides only the application-layer query use-cases the dashboard calls).

See [[project-e3-breakdown]], [[project-flowscout-sdlc-pipeline]]. All 3 issues on Project #4 Status=Todo,
labels mvp + type:task/feature, linked to epic #7 via a checklist comment.
