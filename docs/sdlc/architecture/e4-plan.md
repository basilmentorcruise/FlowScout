# E4 — Grouped HTML report: per-ticket implementation plan (#87 / #88 / #89)

Companion to **ADR-0009** (`ADR-0009-e4-report-rendering-and-artifact-uri.md`). Renderer = zero-runtime-dep
adapter behind the existing `ReportRendererPort`; XSS safety by construction via the escaped-by-default `html`
tagged template (ADR-0009 §1); persisted `artifactUri` = POSIX path relative to `FLOWSCOUT_ARTIFACTS_DIR`
(ADR-0009 §2). Hexagonal: adapter imports domain types only; the #89 use-case imports ports only; DI at the
composition root. Coverage gate: **≥85% line + branch** on the html engine, section functions, renderer,
annotation derivation, and the #89 use-case/decorator.

Ordering: **#87 first** (can start NOW — fully disjoint from in-flight E7), then **#88** (same package,
depends on #87), then **#89** (depends on #87 + #83 + #84; touches `wire.ts`, so it also serializes behind
#85 if #85 is still open — same contention ADR-0008 R-D resolved by ordering).

Designer note: #87/#88 are user-facing surfaces tagged **needs designer spec** (PRD OQ1). The architecture is
styling-independent — the designer's layout/treatment lands as the static CSS constant + section markup;
build #87 with neutral placeholder styling if the spec is not ready, and apply the spec as a follow-up commit
inside the same ticket if it arrives in time. Do not block the port implementation on visual treatment.

---

## #87 — E4.1: Core grouped HTML report renderer (purpose + groups + steps + screenshots, XSS-safe)

Branch: `fs-87-html-report-renderer` · **Depends-on: none** (WorkflowMap contract is on `main`)

### Approach & patterns

- **Adapter (hexagonal):** replace the throwing `HtmlReportRenderer` stub with the real `ReportRendererPort`
  implementation. Domain imports only (NFR5).
- **Safe-HTML engine (ADR-0009 §1):** branded `SafeHtml` + `html` tagged template, escaped-by-default; the
  single auditable encoding boundary. **Nominal typing** (same trick as `StateIdentity`) makes "unescaped
  string reaches the document" a compile error.
- **Composed Method / pure view functions:** each report section is a pure `(input) → SafeHtml` function —
  deterministic, unit-testable without I/O. The renderer class is a thin shell: validate → load screenshots →
  compose → atomic write.
- **Template Method (document skeleton):** one `renderDocument()` composes header → TOC → sections in fixed
  order; static CSS/skeleton via `trustedRaw()` constants only.

### Modules / files (all under `packages/adapters/report-html/src/`)

- `html.ts` — `SafeHtml` brand, `html` tagged template (escapes `& < > " '` on every non-`SafeHtml`
  interpolation; composes `SafeHtml` and `SafeHtml[]`), `trustedRaw()` (package-internal static fragments
  ONLY), `safeAnchorId()`, `safeImageSrc()` (scheme allowlist per ADR-0009 §1).
- `viewmodel.ts` — pure derivation from `(Report, WorkflowMap, StateGraph)` to a render-ready view-model:
  - `groupByFeature(workflows)` — FR3: group by `featureGroup`; absent/`"Ungrouped"` → the labelled catch-all
    group; deterministic ordering (group name asc, catch-all last; workflows by `id` within a group).
  - step resolution — FR4: `step.stateId` → `StateNode` via `stateGraph.nodes` (missing node ⇒ a labelled
    "unknown screen" placeholder, never a crash); terminal step (`edge === null`) shows no action.
  - `WorkflowAnnotations` type + `deriveAnnotations(workflowMap)` returning **empty annotations** — the #88
    slot seam (ADR-0009 §4). Every workflow section renders its (empty) badge/callout slots from day one.
- `sections/` — pure `SafeHtml` partials: `header.ts` (FR2 — `appPurpose` prominent; absent/`"Unknown"` ⇒
  neutral placeholder + confidence when present), `toc.ts` (FR3 anchors via `safeAnchorId("wf-"+id)`),
  `workflow.ts` (per-workflow detail: name, group, annotation slots, ordered steps), `step.ts` (screen label +
  action type/payload + description), `screenshot.ts` (FR5 — embed as `data:image/*;base64` via
  `safeImageSrc`, or reference mode; missing/unreadable ⇒ text-only, no `<img>`), `emptyState.ts` (the
  "nothing discovered" document body).
- `assets/styles.ts` — the static stylesheet constant (`trustedRaw`), inlined into `<head>` (NFR2: no external
  fetches). Designer spec lands here + in section markup.
- `screenshots.ts` — `loadScreenshot(uri) → { mime, base64 } | null`; extension allowlist
  (png/jpg/jpeg/webp → mime), read failure/unknown extension ⇒ `null` (degrade). `readFile` injected
  (defaults to `node:fs/promises`) so tests use fixtures without temp-dir gymnastics.
- `HtmlReportRenderer.ts` — the port impl: constructor takes optional `{ readFile, writeFile/rename seam,
clock }` (defaults = node fs + `Date`). `render()`: reject with a clear error if `outputDir` missing/
  unwritable (do **not** create it — the caller owns the workspace, see #89); compose document; **atomic
  write** (`report.html.tmp-<pid>` → rename to `report.html`; unlink temp on failure — no partial artifact);
  return `RenderResult { artifactUri: file:// absolute, generatedAt: clock(), sizeBytes }`.
- `index.ts` — exports unchanged (`HtmlReportRenderer`); the engine/sections are package-internal (minimal
  public surface).

### Determinism (NFR3)

All ordering rules fixed and documented (groups, workflows, steps by `stepIndex`); `generatedAt` from the
injected clock. Test: render twice with a fixed clock ⇒ byte-identical output.

### Test plan (coverage ≥85% line+branch on engine + viewmodel + sections + renderer)

- **`T7-xss-payload-suite` (named, mandated):** a shared fixture module `__tests__/xssPayloads.ts` exporting
  the payload set — `<script>alert(1)</script>` · `"><img src=x onerror=alert(1)>` ·
  `'"; onmouseover=alert(1)` (attribute-break) · `javascript:alert(1)` and `data:text/html,<script>…` (URI
  position) · `</style><script>` (CSS breakout) · `&lt;script&gt;` (no double-encode: must render literally,
  once-encoded) · `<script>` (unicode) · `` `${alert(1)}` `` (template-literal literal) · a
  null-byte string. The suite injects each payload into **every** untrusted field (`appPurpose`,
  `workflow.name`, `workflow.description`, `featureGroup`, `step.description`, `StateNode.label`,
  `actionPayload`, and `screenshotUri` in reference mode) and asserts: raw payload never appears as active
  markup; encoded form present as visible text; no `javascript:`/`data:text` ever appears inside `src=`/
  `href=`; exactly-once encoding. #88 re-runs this suite over its added markup.
- **Engine unit tests:** escaping table; `SafeHtml` pass-through; array composition; `safeAnchorId`
  sanitization; `safeImageSrc` allowlist accept/reject matrix.
- **Behavioral (per AC):** grouped TOC + anchors resolve; catch-all group for absent/`"Ungrouped"`; step
  order + terminal-step-no-action; screenshot embed (base64 present, no external ref) vs `null` URI
  (text-only) vs unreadable file (degrade); purpose header vs `"Unknown"`/absent placeholder + confidence;
  empty map / empty graph ⇒ valid "nothing discovered" doc; unknown `stateId` ⇒ placeholder screen.
- **Artifact tests:** `render()` writes `report.html`, `RenderResult` fields correct (`file://` absolute URI,
  `sizeBytes` matches); missing/unwritable `outputDir` ⇒ rejection + **no file left** (assert temp cleaned);
  determinism double-render; self-containment — output contains no `http(s)://` asset reference when
  `embedScreenshots:true`.

### DO

- Route **every** dynamic value through the `html` template or a context encoder — the compiler enforces it;
  keep `trustedRaw` calls to static package constants only (greppable review point for the security gate).
- Render the empty annotation slots from `deriveAnnotations` in both index and detail (the #88 seam).
- Keep section functions pure (no fs/clock); confine I/O to `HtmlReportRenderer` + `screenshots.ts`.

### DON'T

- Don't add a template-engine/escaping dependency (zero runtime deps — ADR-0009 §1); devDeps for tests are fine.
- Don't render hidden-path badges or convergence callouts (that's #88 — leave the slots empty).
- Don't touch domain, application, `wire.ts`, or the port signature. Don't create `outputDir` in the adapter.
- Don't interpolate `screenshotUri`/any URI outside `safeImageSrc`; don't build anchor ids by concatenating raw text.

**Touches:** `packages/adapters/report-html` **only**. **Depends-on: none.** Fully disjoint from in-flight
E7 (#83/#84/#85) — safe to run concurrently.

---

## #88 — E4.2: Hidden/duplicate-path visualization (the differentiator)

Branch: `fs-88-hidden-duplicate-visualization` · **Depends-on #87**

### Approach & patterns

- **Fill the #87 annotation seam (ADR-0009 §4):** implement the real `deriveAnnotations(workflowMap)` — a
  **separate module layer** (pure derivation + new partials), not feature flags, not edits to #87's section
  structure. #87's sections already render the slots; #88 makes them non-empty.

### Modules / files (all under `packages/adapters/report-html/src/`)

- `annotations.ts` (replaces the empty derivation in `viewmodel.ts`, or the derivation moves here — one
  module owns it): for each workflow compute
  - **hidden-path badge** when `isHiddenPath === true` — emitted into BOTH the index (TOC row) and detail
    slots (AC 1);
  - **convergence callout** per `duplicateGroups` membership: "N distinct paths reach the same outcome",
    canonical route (`canonicalWorkflowId`) visually/textually distinguished from `hiddenWorkflowIds`,
    in-page links to every other converging workflow via the existing `safeAnchorId("wf-"+id)` anchors (AC
    2–3). Workflow names in callouts go through the `html` template (T7 holds in added markup — AC 5).
  - `duplicateGroups` absent (pre-#59 map) or `[]` ⇒ empty annotations, output byte-identical to #87's (AC 4).
  - Deterministic: groups iterated in map order; ids already sorted lexicographically in `DuplicatePathGroup`
    (domain guarantees); link lists rendered sorted (AC 6).
- `sections/badge.ts`, `sections/convergence.ts` — the new partials (pure `SafeHtml`).
- `assets/styles.ts` — additive style rules for badge vs callout (designer spec / PRD OQ1: the two must read
  as distinct concepts).

### Test plan (coverage ≥85% on annotations + partials)

- Badge appears in index AND detail for `isHiddenPath` workflows; absent otherwise.
- Group of N: callout on every member; canonical vs hidden distinguished; links target existing anchors
  (assert `href="#wf-…"` matches an `id="wf-…"` in the same document); a workflow in a group with
  `isHiddenPath:false` gets a callout but no badge (orthogonality).
- Absent vs `[]` `duplicateGroups` ⇒ no callouts, rest unchanged (compare against a #87-only render).
- **Re-run `T7-xss-payload-suite`** with payloads in workflow names referenced by callouts.
- Determinism double-render including groups.

### DO / DON'T

- DO keep the derivation pure and the only edit surface `annotations.ts` + new partials + styles (+ their
  tests). DO reuse `safeAnchorId` — no second anchor scheme.
- DON'T restructure #87's sections/engine/renderer shell. DON'T add fields to domain models. DON'T render an
  interactive graph (out of scope). DON'T introduce a plugin registry (YAGNI — ADR-0009 §4).

**Touches:** `packages/adapters/report-html` **only**. **Depends-on #87** (serialize after it; same package).

---

## #89 — E4.3: Report generation use-case + `artifactUri` persistence integration

Branch: `fs-89-report-artifact-persistence` · **Depends-on #87, #83, #84** (serialize behind #85 too if it is
still open — shared `wire.ts` line, ADR-0008 R-D)

### Approach & patterns

- **Use-case (ports-only) + Decorator (ADR-0009 §3):** `GenerateReportArtifact` renders + persists;
  `RunPersistAndRender` decorates #84's `RunAndPersist` so a completed crawl auto-produces the artifact —
  **zero edits to #84's files** (Open/Closed; avoids the mid-flight collision).
- **Outcome, not exception:** a discriminated `ReportGenerationOutcome` — renderer failure or missing report
  row is a surfaced run-level outcome; E7-owned data is never created/corrupted here.

### Modules / files

- `packages/application/src/run/GenerateReportArtifact.ts` — constructor deps (DI, ports/values only):
  `reportRepository: ReportRepository`, `stateGraphRepository: StateGraphRepository`,
  `reportRenderer: ReportRendererPort`, `config: { artifactsRootDir: string; embedScreenshots: boolean }`,
  `prepareOutputDir: (runId: string) => Promise<string>` (injected fn — creates and returns the absolute
  `<root>/runs/<runId>` workspace; node-fs impl lives at the composition root, keeping the application layer
  fs-free and honouring #87's "renderer rejects on missing dir" contract).
  `execute(runId)`:
  1. `reportRepository.findByRunId(runId)` — `null` ⇒ `{ kind: "report-missing" }` (AC 4; do NOT create a row).
  2. `stateGraphRepository.findByRunId(runId)` — `null` ⇒ synthesize an empty `StateGraph` from
     `report.metadata` (appId/appVersion; platform `"ios"`) so the renderer still produces the valid
     "nothing discovered" artifact (#87 AC covers empty graphs).
  3. `render(report, report.workflowMap, graph, { outputDir: await prepareOutputDir(runId), embedScreenshots })`.
  4. On renderer rejection ⇒ `{ kind: "render-failed", message }`; persisted Report untouched,
     `artifactUri` still `""` (AC 5).
  5. On success: `toRelativeArtifactUri(artifactsRootDir, result.artifactUri)` (pure helper, same file or
     `artifactUri.ts`) ⇒ `reportRepository.save({ ...report, metadata: { ...report.metadata, artifactUri } })`
     — partial update via the existing upsert-by-runId; **every other field spread through unchanged** (AC 2,
     ADR-0008 §3). Return `{ kind: "rendered", artifactUri }`.
- `packages/application/src/run/RunPersistAndRender.ts` — the Decorator: same `execute` surface as
  `RunAndPersist` (mirror its exact signature — fixed once #84 is on `main`); awaits the wrapped orchestrator,
  then `generateReportArtifact.execute(runId)`; the outcome is attached to/logged with the run result, never
  thrown past the run boundary.
- `packages/application/src/index.ts` — barrel exports (use-case, decorator, outcome type, URI helper).
- `packages/api/src/composition-root/wireReportGeneration.ts` — **new file**: reads `FLOWSCOUT_ARTIFACTS_DIR`
  (default `./.flowscout/artifacts`, resolved absolute once) + `FLOWSCOUT_REPORT_EMBED_SCREENSHOTS` (default
  `true`); implements `prepareOutputDir` with `node:fs` `mkdir` recursive; builds `GenerateReportArtifact` from
  the already-constructed repos + `ports.reportRenderer`; wraps the wired `RunAndPersist` in
  `RunPersistAndRender`; exposes via `AppContextWithReportGeneration` (mirrors the `AppContextWith*` pattern).
- `packages/api/src/composition-root/wire.ts` — **one** added call in `buildAppContext` (the sole shared
  edit; rebase point vs #85).

### Test plan (coverage ≥85% on use-case + decorator + URI helper)

- In-memory repos (#83's reference impls) + a fake renderer: happy path ⇒ Report re-saved with the relative
  `artifactUri` (`runs/<runId>/report.html`), all other fields deep-equal unchanged; renderer receives the
  persisted `workflowMap` + graph + correct `RenderOptions`.
- No report row ⇒ `report-missing`, repo untouched (no row created). Renderer rejects ⇒ `render-failed`,
  persisted report deep-equal to before, `artifactUri === ""`. Graph missing ⇒ empty-graph synthesis, still
  renders. Idempotency: running twice re-renders and re-saves the same URI (upsert, no duplicate rows).
- `toRelativeArtifactUri` unit tests: `file://` absolute → relative POSIX; rejects a URI outside the root.
- Decorator: wrapped orchestrator called first; generation fires with the right runId; a `render-failed`
  outcome does not fail the run.
- **api wiring test:** `buildAppContext()` exposes a working decorated pipeline driven with fakes; the
  use-case/decorator import **no adapter** (port purity — boundaries gate).
- **E2E (composition):** fake-driver crawl through the wired pipeline ⇒ artifact file exists under the
  artifacts root and the persisted run's `artifactUri` is non-empty and resolves to it (AC 3).

### DO / DON'T

- DO treat `""` as the only "not rendered" sentinel (ADR-0008 §3); DO resolve the artifacts root once at
  wiring. DO mirror `RunAndPersist`'s real signature in the decorator — adapt at build time, don't guess.
- DON'T modify `RunAndPersist`, `assembleReport`, `wireRunPersistence.ts`, or anything #84/#85 own. DON'T
  import the renderer adapter in application (inject via `ReportRendererPort` — it is already on `AppPorts`).
  DON'T create Report rows, recompute counts, or touch `workflowMap` data. DON'T persist absolute paths or
  `file://` URIs. DON'T add HTTP routes serving the artifact (E5).

**Touches:** `packages/application/src/run` (new files: use-case, decorator, outcome/URI helper, tests),
`packages/application/src/index.ts`, `packages/api/src/composition-root/wireReportGeneration.ts` (new) + one
line in `wire.ts`. **Depends-on #87 + #83 + #84** (and serialize behind #85 for the `wire.ts` line).

---

## Parallelization verdict

- **#87 ∥ E7 (#83/#84/#85): safe now.** #87 touches only `packages/adapters/report-html`; E7 touches
  persistence/domain/application-run/wire — zero file overlap.
- **#88 after #87** (dependent, same package). #88 remains ∥-safe vs E7 for the same reason.
- **#89 last:** after #84 merges (decorator target + report rows exist) and after #85's `wire.ts` line if #85
  is still open — otherwise the coordinator owns a one-line merge. Everything else in #89 is new-file disjoint
  by construction.

## Coverage targets (per layer)

- `packages/adapters/report-html` (engine, viewmodel, sections, annotations, renderer): **≥85% line + branch**;
  the T7-xss-payload-suite is mandatory evidence for the security gate.
- `packages/application/src/run` E4 additions (use-case, decorator, URI helper): **≥85% line + branch**.
- Composition wiring: covered by the api wiring test + the E2E assertion (not line-percentage-gated).
