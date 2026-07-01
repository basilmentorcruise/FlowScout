# PRD — E4: Grouped HTML workflow documentation report

Epic: #4 · Tier: MVP · Depends on E3 (WorkflowMap, on `main`) and E7 (#83/#84 run store, for the persistence slice only).

## Problem & users

The crawl + semantic pipeline (E2/E3) produces an in-memory `WorkflowMap`, but no human can read it. FlowScout's
headline promise — "given only an app name + build, produce an accurate, grouped, browsable map of features and
end-to-end workflows, with hidden/duplicate paths called out" — is only realised when that model becomes a
**document a developer or tester actually opens and validates**. Users: internal devs/testers onboarding onto an
undocumented app, who need to see what the app does, how each workflow runs end-to-end, and where the
non-obvious/duplicate paths are.

E4 is **the deliverable artifact named in the north-star success metric**: a real dev/tester browses the
generated report for an unknown app and confirms it accurately represents the features/workflows and clearly
shows the flagged hidden/duplicate path.

## Goals / non-goals

**Goals**

- Render the finalized `WorkflowMap` (+ `StateGraph` for evidence) to a **self-contained, static HTML report**
  that opens in a browser with no server.
- **Grouped & browsable:** app purpose up top; workflows grouped by feature; each workflow shown end-to-end
  (screens + actions); per-screen screenshot evidence when the graph carries it.
- **Surface the differentiator:** hidden paths badged; semantic duplicate/convergence groups ("N distinct paths
  reach the same outcome") called out with links between the converging workflows.
- **Safe by construction:** every label/purpose/description/a11y string is untrusted-origin and is context-encoded
  at render (XSS enforcement bites here — E3/E7 threat model T7).
- Persist the artifact: fill `ReportMetadata.artifactUri` for the run (ADR-0008 OQ3, additive — flips one
  already-present field via the existing `ReportRepository.save` upsert).

**Non-goals (out of scope for E4 / MVP)**

- PDF export, print stylesheets, theming/skinning system, dark mode, i18n/localization.
- Interactive graph visualization / zoomable node-graph canvas (steps rendered as ordered lists, not a rendered
  graph).
- Live/streaming report updates during a crawl (E5 dashboard concern).
- Embedding into or navigation from the web dashboard (E5) — the artifact must stay **standalone** so E5 can
  link/embed it later, but E5 wiring is not E4.
- Cross-run/version diffing of reports (post-MVP, E7 out-of-scope).
- Rendering data E7 owns: E4 does **not** create Report rows or persist WorkflowMap data; it only writes the
  `artifactUri` value + the HTML file it points to.

## Requirements

### Functional

- **FR1 — Render.** Implement `ReportRendererPort.render(report, workflowMap, stateGraph, options)` in
  `adapters/report-html`, producing an HTML file in `options.outputDir` and returning `RenderResult`
  (`artifactUri`, `generatedAt`, `sizeBytes`).
- **FR2 — App purpose header.** Show `WorkflowMap.appPurpose` prominently; when absent/`"Unknown"`, show a
  neutral placeholder (never a broken/blank header). Surface purpose confidence when present.
- **FR3 — Feature grouping.** Group workflows by `Workflow.featureGroup`; `"Ungrouped"`/absent renders under a
  clearly-labeled catch-all group; groups are navigable (table of contents / anchors).
- **FR4 — End-to-end steps.** For each workflow, render ordered steps: the **screen** (resolve `step.stateId` →
  `StateNode.label` via the passed `stateGraph`) and the **action** (`step.edge` action type/payload; terminal
  step has no action). Show `step.description`.
- **FR5 — Screenshot evidence.** When a step's `StateNode.screenshotUri` is present, show the screenshot as
  per-screen evidence; when `null`/missing, degrade gracefully (no broken image). Honour
  `RenderOptions.embedScreenshots` (inline base64 vs. reference by URI) — the self-contained default embeds.
- **FR6 — Hidden paths.** Workflows with `isHiddenPath === true` are visibly badged/flagged.
- **FR7 — Duplicate/convergence groups.** For each `WorkflowMap.duplicateGroups` entry, render a callout on the
  converging workflows ("N distinct paths reach the same outcome"), distinguishing the canonical route from the
  hidden routes, with in-page links between them.
- **FR8 — Persistence integration.** After a completed crawl, an application use-case invokes the renderer and
  re-saves the run's `Report` with the real `artifactUri` via `ReportRepository.save` (additive per ADR-0008
  OQ3). Wired into the composition root so a completed crawl auto-produces the artifact.

### Non-functional

- **NFR1 — XSS-safe.** No untrusted string is interpolated into HTML/attributes/URLs without context-appropriate
  encoding. A malicious label (e.g. `<script>` / `"><img onerror=…>` / `javascript:` URI) renders as inert text
  and executes nothing. (Binding — E3/E7 threat model T7.)
- **NFR2 — Self-contained.** The artifact opens correctly from the filesystem (`file://`) with no network/server
  and no external asset fetches when `embedScreenshots` is true.
- **NFR3 — Deterministic.** Same inputs → byte-stable (or stable modulo the `generatedAt` timestamp) output, so
  QA can assert on structure.
- **NFR4 — Resilient to sparse maps.** Empty workflow list, missing purpose, missing groups, and missing
  screenshots each render a valid document, never a crash or partial file.
- **NFR5 — Layering.** `adapters/report-html` imports only domain types; the use-case (FR8) imports only domain
  - application collaborators — no adapter/SDK import in the application layer (NFR1 conventions).

## UX notes (report IS a user-facing surface — needs designer spec)

- Top-to-bottom reading order: app purpose → feature-grouped workflow index (TOC) → per-workflow detail.
- Per workflow: name, feature group, hidden-path badge (if any), convergence callout (if any), ordered steps
  with screen label + action + screenshot.
- The hidden/duplicate flagging is the **differentiator** — it must be immediately obvious, not buried.
- Designer owns concrete layout/styling; slices E4.1 and E4.2 are tagged **needs designer spec**.

## Success metrics

- A dev/tester opens the report for a previously-unknown app and confirms the features/workflows are accurate.
- The flagged hidden/duplicate path is found and understood without reading any code.
- Report opens with no server and no broken assets.

## Edge cases & error states

- Empty `WorkflowMap` (no workflows) → valid "nothing discovered" document.
- `appPurpose` absent or `"Unknown"` → neutral placeholder header.
- `featureGroup` absent / `"Ungrouped"` → catch-all group.
- `screenshotUri === null` for some/all steps → text-only steps, no broken images.
- `duplicateGroups` absent (pre-#59 map) or `[]` → no convergence callouts, everything else renders.
- Malicious/HTML-bearing labels → encoded inert (NFR1).
- Missing `outputDir` / unwritable path → render rejects with a clear error, no partial artifact left behind.
- Persistence (FR8): report row not yet present, or renderer failure → surfaced as a run-level outcome, does not
  corrupt the persisted Report data E7 owns.

## Open questions

- **OQ1 (designer):** concrete visual treatment for hidden-path badge vs. convergence callout so they read as
  distinct concepts.
- **OQ2 (architect):** where the FR8 render+persist orchestration lives — a new application use-case invoked by
  the composition root after `BuildWorkflowMap`, vs. folding into the E7.2 finalize path (#84). E4.3 states the
  requirement; architect picks the seam.
- **OQ3 (architect/E7):** `artifactUri` format for the single-machine store — `file://` absolute vs. a path
  relative to the DB/output root — so E5 can resolve it later.

## Ticket breakdown

| #   | Slice                                                                                      | Depends-on                   |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------- |
| #87 | E4.1 Core grouped HTML report renderer (purpose + groups + steps + screenshots + XSS-safe) | none (WorkflowMap on `main`) |
| #88 | E4.2 Hidden/duplicate-path visualization (the differentiator)                              | #87                          |
| #89 | E4.3 Report generation use-case + `artifactUri` persistence integration                    | #87, #83, #84                |
