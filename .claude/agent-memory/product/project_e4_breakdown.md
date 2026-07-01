---
name: project-e4-breakdown
description: How E4 (grouped HTML workflow documentation report) was sliced into tickets #87-#89, the render-vs-persist split, and MVP scope cuts
metadata:
  type: project
---

E4 (epic #4, the grouped HTML workflow documentation report — the artifact named in the north-star success
metric) was broken into 3 vertical slices. PRD: docs/sdlc/prd/PRD-e4-html-report.md.

- #87 E4.1 Core grouped HTML report renderer — self-contained static HTML from WorkflowMap+StateGraph: app
  purpose header, feature-grouped workflows w/ TOC, end-to-end steps (screen label + action + description),
  per-screen screenshot evidence, XSS-safe encoding. Depends-on NONE (builds against WorkflowMap on main now).
  type:feature. Needs designer spec.
- #88 E4.2 Hidden/duplicate-path visualization (THE differentiator) — isHiddenPath badges + duplicateGroups
  "N distinct paths reach the same outcome" callouts w/ in-page links, canonical-vs-hidden distinction.
  Depends-on #87. type:feature. Needs designer spec.
- #89 E4.3 Report generation use-case + artifactUri persistence integration — app use-case invokes
  reportRenderer.render() then re-saves Report via ReportRepository.save w/ real artifactUri (ADR-0008 OQ3
  additive: flips one already-present field, upsert-by-runId, no new column/port). Wired in composition root so
  a completed crawl auto-produces the artifact. Depends-on #87 + E7 #83 (durable store) + #84 (write path).
  type:feature. NOT designer-facing (backend integration).

**Grounding on main (why this cut):** the seams already exist. `ReportRendererPort` +
RenderOptions/RenderResult (packages/domain/src/ports/ReportRendererPort.ts) are defined; `HtmlReportRenderer`
is a throwing stub in packages/adapters/report-html w/ a "TODO (E4)" marker; it's already wired into
AppContext + wire.ts but NOTHING calls .render() yet — so E4.3 supplies the missing use-case. render() already
receives (Report, WorkflowMap, stateGraph, options) so the renderer can resolve step.stateId -> StateNode.label
and StateNode.screenshotUri (StateNode carries `screenshotUri: string | null`, may be null -> degrade
gracefully). embedScreenshots option = inline base64 (self-contained default) vs URI. WorkflowMap already
carries appPurpose/appPurposeConfidence/featureGroup/isHiddenPath/duplicateGroups (all documented
untrusted-origin, "E4 MUST output-encode — T7").

**Why render vs persist split (not one big ticket):** #87 alone is ~2 days (grouping + steps + screenshots +
XSS baseline), so the 2-day cap forces splitting off #88 (differentiator viz layer) and #89 (use-case + wiring).
#88 and #89 both Depends-on #87 but are disjoint (report-html markup vs application/api wiring) so they
parallelize after #87. #87 is immediately eligible (no deps).

**Key scope decisions (don't let downstream contradict):**

- SECURITY BINDING: XSS enforcement bites in E4's gates — every WorkflowMap/label/a11y string context-encoded at
  render (T7). Baked into #87 ACs (malicious `<script>`/`javascript:`/attr-injection payloads render inert) and
  re-asserted in #88.
- artifactUri boundary (ADR-0008 §OQ3): E7 persists Report DATA and writes artifactUri="" sentinel; E4 owns the
  artifactUri VALUE + the HTML file. E4 must NOT create Report rows or persist WorkflowMap data.
- Standalone artifact: self-contained static HTML, opens from file:// with no server. E5 dashboard EMBEDS/links
  it later — E5 wiring is NOT E4.
- Out of scope (MVP steer — urgent single-machine demo, no gold-plating): PDF export, theming/dark-mode, i18n,
  interactive/zoomable graph canvas, live/streaming updates, cross-run report diffing.
- Open questions: OQ1 designer (badge vs callout visual distinction), OQ2 architect (where render+persist
  orchestration lives — new use-case after BuildWorkflowMap vs fold into E7.2 finalize #84), OQ3 architect
  (artifactUri format: file:// absolute vs relative to store root, for E5 resolution).

See [[project-e3-breakdown]], [[project-e7-breakdown]], [[project-flowscout-sdlc]]. All 3 issues on Project #4
Status=Todo, labels mvp + type:feature, linked to epic #4 via a checklist comment.
