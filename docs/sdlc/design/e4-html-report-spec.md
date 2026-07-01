# Design Spec — E4 Grouped HTML Workflow Report (#87 core, #88 hidden/duplicate visualization)

Status: draft for developer implementation. Covers `HtmlReportRenderer.render()` (adapters/report-html) output
only — no product code touched by this doc. Grounded in the actual domain model
(`packages/domain/src/models/{workflow,duplicate-path,state-graph,report}.ts`,
`packages/domain/src/ports/ReportRendererPort.ts`).

No prior `docs/sdlc/design/system.md` exists yet — this spec **originates** the design system's first tokens and
components (recorded in the token table below; carry forward into `system.md` when a second surface needs it,
e.g. E5 dashboard).

---

## 0. Decisions up front (binding)

1. **JS: none.** Zero `<script>` tags. All collapsible/interactive behavior uses native `<details>`/`<summary>`
   and CSS `:target`. Rationale: NFR2 (self-contained, `file://`, no network) + NFR3 (deterministic byte-stable
   output — no runtime-generated IDs/hydration to destabilize diffs) + simplicity. If a future requirement needs
   JS, it must be a separate ADR — not introduced quietly here.
2. **Hidden-path badge vs. duplicate-group callout are structurally different DOM patterns**, not just different
   colors — badge is inline/on-the-workflow-header; callout is a standalone bordered `<aside>` block above the
   steps, appearing on _every_ workflow in the group. Detailed in §3.
3. **Single `<style>` block in `<head>`, no external CSS/fonts/images.** System font stack. Screenshots embedded
   as base64 `data:` URIs when `embedScreenshots: true` (the default / self-contained path); when false, `<img
src>` references the given URI as-is (E4 does not fetch/rewrite it — that's the caller's contract per FR5).
4. **One HTML file per report”** — TOC, all workflow sections, and all styles live in the single artifact FR1
   produces. No pagination, no iframes.
5. **Print stylesheet is explicitly a non-goal (PRD)** — do not add `@media print` beyond what free-riding on
   sane semantic HTML/CSS already gives you. Don't gold-plate.

---

## 1. Information architecture

Document order (single scroll, one file):

```
<header id="top">                     — App purpose header (§2)
<nav aria-label="Workflow index">     — Table of contents, grouped by feature (§2)
<main>
  <section data-group="…">            — one per feature group, in first-seen order
    <h2>                              — group name
    <article id="wf-<id>">            — one per workflow (§3/§4)
      header (name, group chip, hidden badge)
      duplicate-callout aside (if applicable, §5)
      ordered steps list (§4)
</main>
<footer>                              — run metadata, generation timestamp, FlowScout attribution
```

Reading order for a first-time reader (never seen the app): **who/what is this app → what can it do (grouped
list) → pick a workflow → read it step by step, see the screen, see what happened, see if this path is
noteworthy (hidden) or one of several ways to the same place (duplicate).**

---

## 2. App purpose header + TOC

### 2.1 Header (`FR2`)

```html
<header id="top" class="fs-header">
  <p class="fs-eyebrow">FlowScout workflow report</p>
  <h1 class="fs-app-name"><!-- appId / app display name, output-encoded --></h1>
  <p class="fs-purpose">
    <!-- appPurpose, output-encoded -->
    <span class="fs-confidence" title="Inference confidence"
      >·
      <!-- e.g. 82% confidence --></span
    >
  </p>
  <dl class="fs-run-meta">
    <div>
      <dt>Run</dt>
      <dd><!-- runId --></dd>
    </div>
    <div>
      <dt>App version</dt>
      <dd><!-- appVersion --></dd>
    </div>
    <div>
      <dt>Generated</dt>
      <dd>
        <time datetime="…"><!-- generatedAt, human-formatted --></time>
      </dd>
    </div>
    <div>
      <dt>Status</dt>
      <dd><!-- runStatus badge: completed / partial / blocked-on-2fa / error --></dd>
    </div>
    <div>
      <dt>States explored</dt>
      <dd><!-- totalStates --></dd>
    </div>
    <div>
      <dt>Workflows found</dt>
      <dd><!-- totalWorkflows --></dd>
    </div>
  </dl>
</header>
```

States:

- **`appPurpose` present, not `"Unknown"`** → render as-is; if `appPurposeConfidence` is a number, show `·
NN% confidence`.
- **`appPurpose` absent or `"Unknown"`** → replace the `<p class="fs-purpose">` contents with the neutral
  placeholder copy: **"Purpose not determined for this run."** No confidence chip in this case (confidence is
  `null`/absent by contract). Never leave the element empty or omit it — a missing/blank header reads as a bug,
  not a "we don't know" signal (recognition over recall — tell the user what happened).
- **`runStatus !== "completed"`** → the status `<dd>` gets a visible non-green badge (`partial` = amber,
  `blocked-on-2fa` = amber, `error` = red) so a partial/degraded run is obvious before anyone reads workflows into
  it as gospel. Copy: `Partial (budget/step cap reached)`, `Blocked on 2FA`, `Error`.

### 2.2 TOC (`FR3`)

```html
<nav aria-label="Workflow index" class="fs-toc">
  <h2 id="toc-heading">Workflows by feature</h2>
  <!-- one block per feature group, in first-seen order; "Ungrouped" always last -->
  <div class="fs-toc-group">
    <h3>
      <!-- group name, output-encoded -->
      <span class="fs-count"
        >(<!-- n -->
        workflows)</span
      >
    </h3>
    <ul>
      <li>
        <a href="#wf-<id>">
          <!-- workflow name -->
          <!-- inline hidden-path glyph if isHiddenPath, see §3 -->
        </a>
      </li>
    </ul>
  </div>
</nav>
```

- Grouping key = `Workflow.featureGroup`; `undefined` and `"Ungrouped"` both render under one catch-all group
  literally titled **"Ungrouped"**, always last regardless of alphabetical order (it's the "everything else"
  bucket, not a feature).
- Group order: first `featureGroup` encountered in `workflowMap.workflows` array order (stable, matches NFR3
  determinism — no re-sorting that could vary run to run beyond input order).
- **TOC scaling (100+ workflows):** the TOC is a plain nested list — no virtualization needed (static HTML, browser
  handles a few hundred `<li>`s fine). To keep it scannable, each group's `<ul>` is capped visually at a
  comfortable scroll via `max-height` + native scroll **only if a group exceeds ~15 entries** — use `<details
open>` per group instead of a hard cap so nothing is hidden by default, just the DOM affords collapsing:
  ```html
  <details open class="fs-toc-group">
    <summary>
      <h3>Checkout <span class="fs-count">(23)</span></h3>
    </summary>
    <ul>
      …
    </ul>
  </details>
  ```
  This lets a reader with 100+ workflows collapse groups they don't care about — pure `<details>`, no JS.

---

## 3. Workflow section anatomy (`FR3`, `FR4`, `FR6`)

```html
<article id="wf-<workflow.id>" class="fs-workflow" aria-labelledby="wf-<id>-title">
  <header class="fs-workflow-header">
    <h3 id="wf-<id>-title">
      <!-- workflow.name, output-encoded -->
    </h3>
    <p class="fs-workflow-meta">
      <span class="fs-chip fs-chip-group"><!-- featureGroup or "Ungrouped" --></span>
      <!-- if isHiddenPath: -->
      <span class="fs-badge fs-badge-hidden" role="img" aria-label="Hidden path">
        <svg aria-hidden="true" class="fs-icon"><!-- eye-slash / fork glyph --></svg>
        Hidden path
      </span>
    </p>
    <p class="fs-workflow-desc"><!-- workflow.description, output-encoded --></p>
  </header>

  <!-- duplicate-group callout goes HERE if this workflow is in a DuplicatePathGroup — see §5 -->

  <ol class="fs-steps">
    <!-- §4 -->
  </ol>
</article>
```

### Hidden-path badge — exact spec

- **Placement:** inline in the workflow header, next to the feature-group chip — always visible, no
  expand/collapse. Also echoed as a small glyph next to the workflow's TOC link (`§2.2`) so it's visible from the
  index without opening the section (recognition over recall — a reader scanning the TOC for "the weird one"
  finds it immediately).
- **Copy (exact):** `Hidden path`
- **Non-color signifier (WCAG 1.4.1):** an icon (fork/branch or eye-slash — implementer's choice of a single
  inline SVG, no icon font/external asset) **plus the text label** "Hidden path" — never color alone.
- **Token:** background `--fs-color-hidden-bg` (`#FFF4E5`, warm amber-tinted), text/icon `--fs-color-hidden-fg`
  (`#8A5300`) — passes 4.5:1 on the amber background (verify at build; these are starting values, not final
  pixel-measured — implementer confirms via a contrast checker before shipping).

---

## 4. Steps (`FR4`, `FR5`)

```html
<ol class="fs-steps">
  <li class="fs-step" id="wf-<workflow.id>-step-<stepIndex>">
    <span class="fs-step-index"><!-- stepIndex + 1 --></span>
    <div class="fs-step-body">
      <p class="fs-step-screen"><!-- StateNode.label resolved via stateGraph, output-encoded --></p>
      <p class="fs-step-desc"><!-- step.description, output-encoded --></p>
      <!-- action row: omitted entirely for the terminal step (edge === null) -->
      <p class="fs-step-action">
        <span class="fs-chip fs-chip-action"
          ><!-- edge.actionType: tap / swipe / typeText / scroll / gesture / navigate --></span
        >
        <code class="fs-step-payload"
          ><!-- edge.actionPayload, output-encoded, truncated (see below) --></code
        >
      </p>
      <!-- screenshot: present -->
      <details class="fs-step-shot">
        <summary>Screenshot</summary>
        <img
          src="<!-- data:image/png;base64,… when embedScreenshots, else the raw screenshotUri -->"
          alt="Screen: <!-- StateNode.label, output-encoded --> — step <!-- stepIndex+1 --> of <!-- workflow.name -->"
          loading="lazy"
          class="fs-screenshot"
        />
      </details>
      <!-- screenshot: absent -->
      <p class="fs-step-noshot">No screenshot captured for this screen.</p>
    </div>
  </li>
</ol>
```

- **Terminal step** (`edge === null`, the last step in `steps`): no `.fs-step-action` row at all — it's the
  outcome, not an action. Its `.fs-step-desc` (from `step.description`) is what communicates "this is where the
  workflow ends."
- **Collapsible screenshots** (`<details>`, no JS): the screenshot is collapsed by default when there are **more
  than 6 steps in the workflow** (keeps long workflows scannable); for workflows of 6 steps or fewer, `<details
open>` — screenshot visible by default, since there's little to scroll past. This threshold is a simple
  per-workflow check the renderer makes once (`steps.length > 6`), not per-step.
- **Missing screenshot (`screenshotUri === null`)** → render `.fs-step-noshot` text only, never an empty
  `<details>`/broken `<img>`. No `alt`-less placeholder image — literally omit the `<img>` element.
- **Long action payload / label truncation:** any single rendered text token (screen label, step description,
  action payload) longer than **140 characters** is truncated at the boundary with a trailing `…`, and the full
  untruncated (still output-encoded) value is placed in a `title` attribute for hover/tooltip access and is also
  fully present for assistive tech (do not truncate what's exposed to the accessibility tree — put the full string
  in the element's text content and apply truncation via CSS `text-overflow: ellipsis` with `white-space:
nowrap`/`overflow: hidden` on a bounded-width wrapper, NOT by cutting the string server-side) — this keeps
  screen readers getting the full value while sighted users get a clean single line. Exception: `actionPayload`
  can legitimately be long/structured (e.g. JSON-ish); render it in `<code>` with `white-space: pre-wrap` and a
  `max-height` + scroll instead of single-line truncation, since mid-payload truncation would misrepresent data.

---

## 5. Duplicate/convergence groups (`FR7` — the differentiator, PRD OQ1)

This is the concept that must read as **visually and structurally distinct from the hidden-path badge** at a
glance. The badge says "this one route is non-obvious." The callout says "multiple routes exist and here's how
they relate."

### 5.1 Structural distinction (the two-line answer)

- **Hidden-path badge** = a small inline chip in a workflow's own header — a _property of one workflow_, always
  visible, no extra vertical space, appears once.
- **Duplicate-group callout** = a full-width bordered `<aside>` block inserted between the workflow header and
  its steps — a _relationship between workflows_, rendered identically (same content) on **every** workflow in
  the group, with jump-links to the others and an explicit canonical-vs-hidden role label per link.

### 5.2 Callout markup

Rendered once per `DuplicatePathGroup`, but the same block content is injected into **each** converging
workflow's article (so a reader landing on any of the N workflows sees the full picture, not just "I am part of
something").

```html
<aside class="fs-duplicate-callout" aria-label="Duplicate path group">
  <p class="fs-duplicate-title">
    <svg aria-hidden="true" class="fs-icon"><!-- convergence/merge-arrows glyph --></svg>
    <strong
      ><!-- N -->
      distinct paths reach the same outcome</strong
    >
  </p>
  <p class="fs-duplicate-outcome">
    Outcome:
    <!-- resolve outcomeIdentity → StateNode.label via stateGraph, output-encoded; fallback "Unknown screen" if not found -->
  </p>
  <ul class="fs-duplicate-routes">
    <!-- canonical route first, always -->
    <li class="fs-route fs-route-canonical">
      <span class="fs-chip fs-chip-canonical">Canonical route</span>
      <a href="#wf-<canonicalWorkflowId>"><!-- that workflow's name --></a>
      <!-- if this IS the current workflow: -->
      <span class="fs-you-are-here">(this workflow)</span>
    </li>
    <!-- then every other workflowId in workflowIds, each tagged hidden or plain -->
    <li class="fs-route <!-- fs-route-hidden if in hiddenWorkflowIds -->">
      <span class="fs-chip <!-- fs-chip-hidden if hidden, else fs-chip-alt -->">
        <!-- "Hidden route" if in hiddenWorkflowIds, else "Alternate route" -->
      </span>
      <a href="#wf-<workflowId>"><!-- that workflow's name --></a>
      <span class="fs-you-are-here">(this workflow)</span>
      <!-- only on the current one -->
    </li>
  </ul>
</aside>
```

- **Copy (exact):**
  - Title: `N distinct paths reach the same outcome` (N = `workflowIds.length`).
  - Outcome line: `Outcome: <screen label>`.
  - Role chips: `Canonical route` / `Hidden route` / `Alternate route` (an `alternate` = present in `workflowIds`
    but not in `hiddenWorkflowIds` and not the `canonicalWorkflowId` — i.e. a third+ path that's neither the
    prominent nor explicitly flagged-hidden one; this state is possible per the domain model since
    `workflowIds.length` can exceed `1 + hiddenWorkflowIds.length`).
  - Self-reference: `(this workflow)` appended next to whichever link matches the article you're currently
    reading, so the reader never loses their place navigating between converging workflows.
- **Non-color signifiers:** the convergence icon + the word "distinct paths" in the title, plus explicit text
  chips per route (`Canonical route`/`Hidden route`/`Alternate route`) — never relying on color alone to
  distinguish canonical from hidden (WCAG 1.4.1).
- **Tokens:** callout border `--fs-color-duplicate-border` (`#C7D2FE`, indigo-tinted — deliberately a **different
  hue family from the hidden-badge's amber** so the two concepts are never visually confusable even at a glance
  or in grayscale/print), background `--fs-color-duplicate-bg` (`#EEF2FF`). Canonical chip uses
  `--fs-color-canonical-bg`/`fg` (a calm green: `#E6F4EA` / `#1E7A34`) — distinct from both amber (hidden-badge)
  and indigo (callout shell), giving three legible, non-clashing semantic hues total: amber=hidden,
  indigo=duplicate-relationship, green=canonical/prominent.
- **Placement when a workflow is BOTH hidden AND a duplicate-group hidden route** (`isHiddenPath === true` and
  `workflowId ∈ hiddenWorkflowIds`) — the common case: the badge (§3) still renders in the header as normal (it's
  a per-workflow property), AND the callout still renders with that workflow's route correctly labeled `Hidden
route`. They are not deduplicated — both signals fire because they answer different questions ("is this one
  path non-obvious" vs "how does it relate to the other paths that reach the same place"). Do not suppress
  either.
- **Outcome-identity resolution miss:** if `outcomeIdentity` doesn't resolve to a node in `stateGraph.nodes`
  (shouldn't happen per contract, but NFR4 demands no crash on sparse/inconsistent data), render `Outcome:
Unknown screen` rather than omitting the line or throwing.

### 5.3 `duplicateGroups` absent or empty (`FR7` edge case)

No callouts render anywhere; every workflow renders as in §3/§4 with nothing else different. Do not render an
empty "no duplicates found" callout — absence of the concept, not a null state to announce (this isn't a primary
empty-state the user is querying for; it's a per-item feature that simply doesn't apply).

---

## 6. Visual system — tokens

Single `<style>` block, CSS custom properties on `:root`. This is a small, deliberate set — the **signature
element** is the two-hue-family badge/callout distinction (§3/§5); everything else stays disciplined system UI so
that distinction reads clearly against a quiet backdrop.

```css
:root {
  /* color — neutrals */
  --fs-color-bg: #ffffff;
  --fs-color-surface: #f8f9fb;
  --fs-color-border: #d8dce3;
  --fs-color-text: #1a1d23;
  --fs-color-text-muted: #5b6270;
  --fs-color-link: #1f4fd8;

  /* color — semantic (hidden-path amber / duplicate indigo / canonical green) */
  --fs-color-hidden-bg: #fff4e5;
  --fs-color-hidden-fg: #8a5300;
  --fs-color-duplicate-bg: #eef2ff;
  --fs-color-duplicate-border: #c7d2fe;
  --fs-color-duplicate-fg: #33389e;
  --fs-color-canonical-bg: #e6f4ea;
  --fs-color-canonical-fg: #1e7a34;
  --fs-color-status-warn-bg: #fff4e5;
  --fs-color-status-warn-fg: #8a5300;
  --fs-color-status-error-bg: #fdecec;
  --fs-color-status-error-fg: #a32424;

  /* type — system stack, no webfonts */
  --fs-font-sans:
    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --fs-font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --fs-size-sm: 0.8125rem; /* 13px: chips, meta */
  --fs-size-base: 1rem; /* 16px: body */
  --fs-size-lg: 1.25rem; /* 20px: workflow titles */
  --fs-size-xl: 1.75rem; /* 28px: app name */

  /* spacing scale (4px base) */
  --fs-space-1: 0.25rem;
  --fs-space-2: 0.5rem;
  --fs-space-3: 0.75rem;
  --fs-space-4: 1rem;
  --fs-space-6: 1.5rem;
  --fs-space-8: 2rem;

  /* shape */
  --fs-radius-sm: 4px;
  --fs-radius-md: 8px;

  /* motion */
  --fs-motion-fast: 120ms ease;
}

@media (prefers-reduced-motion: reduce) {
  * {
    transition: none !important;
  }
}
```

**Token count: 27** (6 neutral colors, 10 semantic colors, 2 font families, 4 type sizes, 6 spacing steps, 2
radii, 1 motion value — grouped as: color 16, type 6, spacing 6, radius 2, motion 1 = 31 total individual
`--fs-*` custom properties; treat "~30 tokens" as the shorthand figure). Deliberately small — this is a
single-artifact static document, not a multi-surface product UI yet. When E5 (dashboard) needs a design system,
promote this into `docs/sdlc/design/system.md` as the seed and extend, don't fork.

---

## 7. States (renderer-level, NFR4)

| State                                     | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty `workflows: []`                     | Header renders normally (purpose/meta). TOC section renders a single message instead of groups: **"No workflows were discovered in this run."** `<main>` has no `<article>`s. Valid, complete HTML — not an error page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Exactly 1 workflow                        | Renders as normal — no special-casing; TOC still shows (one group, one link).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 100+ workflows                            | Per §2.2 — `<details>`-collapsible TOC groups; steps unaffected (each workflow section is independent, no perf concern in static HTML).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `appPurpose` absent/"Unknown"             | §2.1 neutral placeholder.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `featureGroup` absent/"Ungrouped"         | §2.2/§3 catch-all "Ungrouped" group, sorted last.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `screenshotUri === null` (some/all steps) | §4 — text-only step, `.fs-step-noshot` message, no `<img>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `duplicateGroups` absent/`[]`             | §5.3 — no callouts anywhere, rest of report unaffected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Malicious/HTML-bearing label anywhere     | All dynamic strings (`appPurpose`, `Workflow.name/description`, `step.description`, `StateNode.label`, `edge.actionPayload`, `edge.actionType`) are HTML-entity-encoded at the text-node level and attribute-encoded (with additional quote-escaping) when placed in `alt`/`title`/`href` fragments. `screenshotUri` when used as an `<img src>` must be validated as `data:image/*` (embed path) or an `http(s)/file` scheme (reference path) — never emit a `javascript:`-schemed value; reject/blank the image if the scheme doesn't match instead of interpolating it raw. This is the developer's NFR1 job; the design spec's obligation is to make sure no field is exempted from this rule for "just this one label." |
| `outputDir` missing/unwritable            | Not a rendering/markup concern — developer surfaces a clear error per FR1's contract; no HTML consequence to spec here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

---

## 8. Accessibility (WCAG 2.2 AA)

- **Heading hierarchy:** `h1` = app name (one per document, in `<header>`). Inside `<nav>`: `h2` = "Workflows by
  feature" (the TOC heading), `h3` per feature group. Inside `<main>`: each feature-group `<section>` uses its own
  `h2` (group name) and each workflow within it uses `h3` (workflow name) — no level is skipped in either
  landmark. `<nav>` and `<main>` are separate landmarks, so their independent `h2`/`h3` sequences don't collide;
  a screen-reader heading-list navigation still reads cleanly because each landmark's headings are locally
  well-nested.
- **Landmarks:** `<header>`, `<nav aria-label="Workflow index">`, `<main>`, `<footer>` — one of each, so a screen
  reader user can jump straight past the TOC into content.
- **Contrast:** all text/background pairs in §6 target ≥4.5:1 for body text and ≥3:1 for large text/icons per
  WCAG 1.4.3/1.4.11; implementer verifies the exact hex pairs with a contrast checker at build time since these
  are spec'd starting values, not laboratory-measured finals.
- **Focus:** every interactive element (`<a>`, `<summary>`) gets a visible focus ring —
  `:focus-visible { outline: 2px solid var(--fs-color-link); outline-offset: 2px; }` — never `outline: none`
  without a replacement.
- **Keyboard:** `<details>/<summary>` are natively keyboard-operable (Enter/Space to toggle) — no custom
  tabindex/ARIA needed beyond what's native. Skip link at the very top: `<a class="fs-skip-link"
href="#main-content">Skip to workflows</a>`, visually hidden until focused.
- **Labels/semantics:** every screenshot `<img>` has a descriptive `alt` (§4). Badges/callouts use `role="img"` +
  `aria-label` only where the glyph alone would otherwise be announced as decorative noise; the text label
  ("Hidden path", "Canonical route" etc.) is the primary accessible name in all cases — icons are `aria-hidden`
  and supplementary.
- **Target size (WCAG 2.5.8):** TOC links and step-screenshot `<summary>` toggles get `min-height: 24px` and
  adequate padding (`--fs-space-2` vertical) — static document on desktop/print is the primary consumption mode,
  but don't assume zero mobile/touch viewing.
- **Non-color-only signifiers:** covered per-component in §3/§5 — every semantic state (hidden, canonical,
  alternate, run-status warn/error) pairs a color token with a text label and/or icon, never color alone.
- **Motion:** no animation beyond a fast (`120ms`) focus/hover transition on links/chips, fully disabled under
  `prefers-reduced-motion: reduce` (§6).

---

## 9. Copy reference (exact strings)

| Element                        | Copy                                        |
| ------------------------------ | ------------------------------------------- |
| Purpose placeholder            | `Purpose not determined for this run.`      |
| Run status: partial            | `Partial (budget/step cap reached)`         |
| Run status: blocked-on-2fa     | `Blocked on 2FA`                            |
| Run status: error              | `Error`                                     |
| Hidden-path badge              | `Hidden path`                               |
| Empty workflow map             | `No workflows were discovered in this run.` |
| No screenshot                  | `No screenshot captured for this screen.`   |
| Duplicate callout title        | `{N} distinct paths reach the same outcome` |
| Duplicate callout outcome line | `Outcome: {screen label}`                   |
| Duplicate role chip: canonical | `Canonical route`                           |
| Duplicate role chip: hidden    | `Hidden route`                              |
| Duplicate role chip: alternate | `Alternate route`                           |
| Self-reference marker          | `(this workflow)`                           |
| Skip link                      | `Skip to workflows`                         |
| Screenshot toggle              | `Screenshot` (as `<summary>` text)          |

---

## 10. Implementation notes for the developer

- Resolve `step.stateId` → `StateNode.label` via `stateGraph.nodes.get(step.stateId)`; if not found (shouldn't
  happen per contract, but NFR4 demands resilience), render `Unknown screen` rather than crashing/blank.
- `DuplicatePathGroup.workflowIds` / `.hiddenWorkflowIds` are pre-sorted lexicographically per the domain
  contract — render routes in that given order (canonical always pinned first per §5.2, matching FR7's
  "distinguish the canonical route" requirement) rather than re-deriving an order.
- Precompute, per workflow, whether it belongs to any `DuplicatePathGroup` (a workflow could theoretically appear
  in one group as spec'd — one canonical/one hidden set per outcome) before rendering its `<article>`, so the
  callout injection in §5.2 is a single lookup, not an O(n·m) scan per workflow while streaming HTML.
- Everything in this document composes from the token list in §6 — no ad hoc inline styles/colors outside that
  set. If a new case needs a new token, add it to §6 (and eventually `system.md`), don't invent a one-off hex.

---

## Open items flagged back to product/architect (not blocking a first implementation pass)

- **"Alternate route" (third-plus path, neither canonical nor flagged-hidden)** is representable in the domain
  model (`workflowIds.length > 1 + hiddenWorkflowIds.length`) but the PRD only names "canonical vs hidden." This
  spec adds the `Alternate route` label to cover that case without guessing at different product intent — confirm
  with product whether a >2-way convergence group is an expected/common shape worth testing explicitly in E4's
  acceptance criteria, or a should-not-happen-in-practice case.
- **App display name source:** PRD/domain model don't carry a human app _display name_ distinct from `appId` on
  `Report.metadata` — this spec renders `appId` in the `<h1>`. If there's a nicer display name available
  elsewhere in the pipeline, product/architect should confirm before the developer wires the header.
