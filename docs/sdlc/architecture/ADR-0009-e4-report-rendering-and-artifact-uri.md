# ADR-0009 — E4 HTML report: safe-HTML rendering boundary, artifact URI format, and the render+persist seam

- **Status:** Accepted
- **Date:** 2026-07-02
- **Mode:** plan (E4 epic #4 — grouped HTML report; tickets #87/#88/#89)
- **Scope:** `packages/adapters/report-html/**` (real renderer replacing the stub),
  `packages/application/src/run/**` (render+persist use-case, additive), `packages/api/src/composition-root/**`
  (new wiring file + one `buildAppContext` line). **No domain edit** — `ReportRendererPort` /
  `RenderOptions` / `RenderResult` / `Report` / `WorkflowMap` are consumed as-is.
- **Relates to:** ADR-0008 §3 (E7 ↔ E4 `artifactUri` boundary — this ADR resolves its OQ3), ADR-0005/0007
  (untrusted-origin labels the report must encode — T7), companion plan `e4-plan.md`.

---

## 1. Decision 1 — XSS safety by construction: a zero-dependency escaped-by-default `html` tagged template

Every render-visible string (`appPurpose`, `Workflow.name/description`, `featureGroup`, `WorkflowStep.description`,
`StateNode.label`, `actionPayload`, `screenshotUri`) is **untrusted-origin** (LLM/app-derived — T7). The PRD
requires encoding enforced **by construction at one auditable boundary**, not by per-call `esc()` discipline.

**Chosen: a tiny internal safe-HTML engine** in `packages/adapters/report-html/src/html.ts`:

- A **branded `SafeHtml` type** (nominal, like `StateIdentity`) — the ONLY thing section functions may return
  and the ONLY thing the document writer accepts.
- An **`html` tagged template literal** that **escapes every interpolated value by default** (HTML-entity
  encoding covering `& < > " '`). Already-`SafeHtml` values and arrays of `SafeHtml` pass through composed;
  raw strings CANNOT opt out — there is no public unescaped path except `trustedRaw()`, reserved for the
  static CSS/skeleton constants defined inside the package (never called with a variable derived from input;
  a lint-greppable name makes review trivial).
- **Context-specific encoders** for the two non-text sinks:
  - `safeAnchorId(raw)` — sanitizes to `[A-Za-z0-9_-]` for `id=`/`href="#…"` (TOC + convergence links).
  - `safeImageSrc(raw)` — scheme allowlist: `data:image/(png|jpeg|webp);base64,` (built by our own encoder in
    embed mode) or a plain relative/`file:` path in reference mode; `javascript:`, `data:text/*`, and anything
    else render as **no image** (degrade), never an attribute. Kills URL-context injection categorically.

**Why not the alternatives:** a template lib (Handlebars/EJS/lit-html) adds a runtime dependency + an escaping
semantics audit to a self-contained artifact whose entire engine is ~60 LOC (NFR2 zero-dep, SCA surface,
determinism). A manual builder with per-call `esc()` fails the "by construction" bar — one forgotten call is an
XSS. Escaped-by-default tagged templates are the industry-standard pattern (lit-html/safevalues); we implement
the minimal core and test it exhaustively (the named **T7-xss-payload-suite**, see `e4-plan.md`).

## 2. Decision 2 (PRD OQ3) — `artifactUri` format: POSIX path **relative to a configured artifacts root**

**Persisted `ReportMetadata.artifactUri` = a POSIX relative path under the artifacts root**, e.g.
`runs/<runId>/report.html`. The root is configured once at the composition root:
`FLOWSCOUT_ARTIFACTS_DIR`, default `./.flowscout/artifacts` (sibling of ADR-0008's default DB path — one
portable `.flowscout/` directory holds the whole run store).

- **Why not `file://` absolute:** it bakes a machine-specific personal absolute path into the run DB — the DB
  stops being portable (move `.flowscout/` to another Mac / another checkout ⇒ every link dead), and it leaks
  the developer's home path into a shareable artifact store (CLAUDE.md conventions forbid exactly that).
- **E5 fit:** the dashboard mounts ONE static route at the artifacts root and serves `artifactUri` as a URL
  path directly; relative-under-root also makes path-traversal validation trivial (reject `..`/absolute).
- **Mechanics:** the renderer (an adapter doing local file I/O) truthfully returns an **absolute `file://`
  URI** in `RenderResult.artifactUri` (unchanged port semantics). The **use-case** (#89) converts to the
  persisted canonical form via a pure `toRelativeArtifactUri(rootDir, fileUri)` helper. One conversion point,
  unit-tested; the empty-string "not rendered" sentinel (ADR-0008 §3) is unchanged.

## 3. Decision 3 (PRD OQ2) — render+persist orchestration: a new use-case + a Decorator, **zero edits to #84**

`#84` (`RunAndPersist`) is in flight **right now**; folding FR8 into its finalize path would respec a
mid-flight ticket. **Chosen seam:**

- **`GenerateReportArtifact`** — a new, standalone application use-case (ports-only: `ReportRepository`,
  `StateGraphRepository`, `ReportRendererPort` + injected config/clock/output-dir provider). Loads the run's
  persisted `Report` (its `workflowMap` was persisted by #84) + `StateGraph`, invokes the renderer, re-saves
  the `Report` with the real `artifactUri` via the **existing upsert** (ADR-0008 §3 — partial update, no new
  port method). Returns a **discriminated outcome** (`rendered` / `report-missing` / `render-failed`) instead
  of throwing — a run-level outcome that can never corrupt E7-owned data.
- **`RunPersistAndRender`** — a thin application **Decorator** over `RunAndPersist`: same `execute` surface,
  awaits the wrapped orchestrator, then fires `GenerateReportArtifact` for the run. Open/Closed: #84's files
  are **not modified**; the composition root exposes the decorated instance (new file
  `wireReportGeneration.ts` + one `buildAppContext` line, mirroring the E7 `AppContextWith*` pattern).
- **Independent shippability:** the use-case + decorator + tests run against in-memory fakes regardless of
  #84's merge state; only the one-line wiring needs #84 on `main` — which #89's `Depends-on: #84` already
  guarantees.

## 4. Decision 4 — the #88-extends-#87 seam: annotation slots, not feature flags, not a plugin registry

#87 renders every workflow through pure section functions that accept a **`WorkflowAnnotations` view-model**
(index badges + detail callouts, both `SafeHtml[]`) computed by a pure `deriveAnnotations(workflowMap)`. In
#87 that derivation returns **empty annotations** (the slots render nothing — which #87 needs anyway for the
`duplicateGroups`-absent edge case). #88 lands as a **separate module layer** in the same package: the real
derivation (hidden-path badge from `isHiddenPath`; convergence callouts + in-page links from
`duplicateGroups`, canonical vs hidden distinguished) plus its partials — **no rewrite of #87's sections, no
feature flags**. A plugin registry was considered and rejected (YAGNI — #88 is the only known extension and
the slot seam already satisfies Open/Closed for it).

## 5. Consequences & risks

- **Positive:** T7 enforced structurally (unescaped output is a type error, not a review catch); portable run
  DB + trivially servable artifacts for E5; #89 cannot collide with in-flight #84; #88 is additive by design.
- **R-A (hand-rolled escaper):** owning ~60 LOC of encoding logic means owning its correctness. Mitigation:
  the T7-xss-payload-suite is a mandated named test set covering every untrusted field × payload class
  (script/attr-break/URL-scheme/double-encode/unicode); security gate reviews `html.ts` + `trustedRaw` call
  sites specifically.
- **R-B (base64 embedding size):** large crawls ⇒ multi-MB artifacts. Accepted for MVP (NFR2 self-contained
  wins); `embedScreenshots:false` reference mode is the pressure valve, already in the port.
- **R-C (`RunAndPersist` surface unknown until #84 merges):** the Decorator mirrors its `execute` signature;
  #89 is serialized after #84, so the shape is fixed before #89 starts. Noted as a rebase point, not a risk
  to #87/#88.
- **R-D (`wire.ts` contention with #85):** #89 adds one `buildAppContext` line, as does #85 (ADR-0008 R-D).
  Serialize #89 after whichever of #84/#85 is still open; the new-file seam keeps the rest disjoint.
- **Coverage gate:** `report-html` engine/sections/renderer and `GenerateReportArtifact`/decorator ≥ **85%
  line + branch** (per-layer targets in `e4-plan.md`).
