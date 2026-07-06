---
name: e4-html-report
description: E4 report design (ADR-0009) — SafeHtml tagged-template XSS boundary, relative artifactUri, GenerateReportArtifact + Decorator seam (no #84 edit), #88 annotation slots
metadata:
  type: project
---

E4 (#4 grouped HTML report) design — **ADR-0009** (`docs/sdlc/architecture/ADR-0009-e4-report-rendering-and-artifact-uri.md`)

- plan (`docs/sdlc/architecture/e4-plan.md`). Tickets #87/#88/#89.

Decisions (gate against these in review):

- **XSS (T7) by construction:** zero-runtime-dep engine in `adapters/report-html/src/html.ts` — branded
  `SafeHtml` + escaped-by-default `html` tagged template; `trustedRaw()` for static package constants ONLY;
  `safeAnchorId` / `safeImageSrc` (scheme allowlist: data:image/\*;base64 + relative/file). Named
  **T7-xss-payload-suite** (shared `__tests__/xssPayloads.ts`) is mandatory evidence; #88 re-runs it.
- **OQ3 artifactUri:** persisted value = POSIX path **relative to `FLOWSCOUT_ARTIFACTS_DIR`** (default
  `./.flowscout/artifacts`), e.g. `runs/<runId>/report.html`. Renderer returns `file://` absolute in
  `RenderResult`; use-case converts via pure `toRelativeArtifactUri`. FAIL any persisted absolute path.
- **OQ2 seam:** `GenerateReportArtifact` (ports-only; discriminated outcome rendered/report-missing/
  render-failed, never throws, never creates Report rows) + `RunPersistAndRender` **Decorator** over #84's
  `RunAndPersist` — **zero edits to #84's files**. Wiring: new `wireReportGeneration.ts` + one wire.ts line.
  `prepareOutputDir` is an injected fn (fs stays out of application; renderer rejects on missing dir, #87 AC).
- **#88 seam:** #87 ships `deriveAnnotations(workflowMap)` returning EMPTY annotations rendered as slots in
  index+detail; #88 = separate module layer (annotations.ts + badge/convergence partials). No feature flags,
  no plugin registry (YAGNI), no rewrite of #87 sections.
- **Ordering:** #87 starts NOW, fully ∥-safe vs in-flight E7 (report-html only). #88 after #87. #89 after
  #84 (+ behind #85's wire.ts line if open). No domain edit anywhere in E4.

**#87 arch-review (PR #92, head ec4fae3): PASS 2026-07-07.** Coverage re-verified from head: 99.66/96.07
(thresholds in vitest.config.ts). Supersession accepted + plan amended: design-spec §2.2 **first-seen group
order** is authoritative over the plan's "name asc" parenthetical — #88 preserves it. Forward conditions:
(a) #88 binding — no DOM-global usage in production src (tsconfig lib DOM is package-wide; prefer test-scoped
split) and re-run T7-xss-payload-suite over callout markup; (b) #88 nice-to-have — single clock() read in
render(); (c) #89 note — per-run outputDir is the tmp-collision mitigation, keep one execution per runId.
`emptyState.ts` never materialized — empty-state lives in toc.ts (spec §9 copy); accepted placement.

**Why:** T7 threat model + ADR-0008 §3 additive boundary + #84 in flight (mid-flight respec forbidden).
**How to apply:** in review-gate, FAIL: any per-call-esc discipline instead of the tagged template; a
template-lib runtime dep; renderer creating outputDir; edits to RunAndPersist/wireRunPersistence; persisted
`file://`/absolute artifactUri; #88 restructuring #87's engine. Related: [[e7-run-persistence]],
[[e3-59-capstone]], [[e3-naming-grouping]].
