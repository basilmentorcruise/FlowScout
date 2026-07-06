# Design Spec — E5 Web Dashboard (#93 New run · #94 Live watch · #95 Runs history/detail · #96 Workflow map · #97 Report embed)

Status: draft for developer implementation. Stack: React + Vite, MVVM (views passive, view-models hold
state/intents, `ApiClient` is the only HTTP-talking layer — per `NFR-WEB`). All tokens/primitives referenced
below are defined in `docs/sdlc/design/system.md` — nothing here invents a one-off color/spacing value.

Golden path this spec serves: **open dashboard → submit app name + `.app` path → watch live → browse map →
open report.** Keep chrome minimal; this is an internal single-operator tool (no auth, no theming, no i18n —
per PRD non-goals).

---

## 0. Decisions up front (binding)

1. **Live view and Run detail are the same route/page** (`/runs/:runId`), not two separate screens. The page
   renders a `LivePanel` while `run.status === "running"` and swaps to a `RunSummary` (metadata + Map/Report
   affordances) once the run reaches a terminal status. This matches the PRD's "terminal-state transition → CTA
   to map/report" requirement without a jarring page navigation at the exact moment the operator is watching —
   the transition happens in place.
2. **Report iframe sandbox is maximally restrictive: `sandbox=""` (no `allow-scripts`, no `allow-same-origin`,
   no attribute values at all).** The E4 report is contractually zero-`<script>`/no-JS (E4 spec §0.1) — it needs
   no script execution to render, so the dashboard should not grant it any. This is the design-side complement
   to `NFR-SEC`; the exact response-header CSP / origin mechanism remains the architect's ADR call (PRD OQ2),
   but the sandbox attribute itself should ship with zero allowances regardless of that choice.
3. **Activity log is not an ARIA live region; only the coalesced current-action + counters line is.** A
   fast-scrolling crawl log firing `aria-live` per line would be unusable for screen-reader users. See
   `system.md` §3 "Live-region discipline."

---

## 1. App shell

**Components:** `AppShellNav`, `Toast/Banner` (region), `Skeleton` (per-view), page container
(`max-width: var(--fs-layout-maxwidth)`, centered, `padding-inline: var(--fs-layout-gutter)`).

**Layout:**

```
┌─────────────────────────────────────────────┐
│ FlowScout        New run   Runs              │  ← AppShellNav, --fs-layout-header-height
├─────────────────────────────────────────────┤
│ [toast/banner region — appears above content] │
│                                               │
│  <page content, max-width, centered>         │
│                                               │
└─────────────────────────────────────────────┘
```

- Wordmark left, two nav items right: `New run`, `Runs`. Current route marked with an underline **and**
  `aria-current="page"` (never color-only).
- `New run` is the default/root route (`/`) — matches the golden path's first step.
- **Skip link** (`Skip to content`, visually hidden until focused) is the first focusable element in the DOM.
- **Toast/banner region:** a single live region docked under the header, full content-width. Errors
  (`role="alert"`) persist with a manual dismiss (×). Success/info (`role="status"`) auto-dismiss after 5s,
  pause on hover/focus. Only one toast visible at a time (queue, don't stack).
- **Global loading convention:** every view that fetches on mount shows a `Skeleton` matching that view's
  layout (never a bare spinner-in-a-void) — so the shape of the page is visible before its data (progressive
  disclosure, reduces layout shift).
- **Global error convention:** a failed fetch renders an inline error state _in the content area_ (heading +
  one-line body + `Retry` button) for primary-content failures, and a top toast for secondary/background
  failures (e.g. a background poll failing while the primary content is still showing stale-but-valid data).

---

## 2. New-run view (#93) — route `/`

**Components:** `TextInput` × 2, `Button` (primary), `Toast/Banner`, `Card` (form container).

**Layout:** single centered card, max-width ~480px within the page container. `<h1>New run</h1>`, form below.

**Fields:**

| Field             | Type                             | Validation                                                                                                                                                                                                         |
| ----------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App name          | text, required                   | Non-empty after trim. Free text — no format constraint (it's a label, not an identifier).                                                                                                                          |
| `.app` build path | text, required, `--fs-font-mono` | Non-empty after trim. No client-side filesystem check (browser can't read local FS) — **all path validity is server-side**, per PRD FR2/edge-case "invalid path rejected before starting; no partial run created." |

No file upload control (PRD non-goal / OQ4 resolved to path entry) — a plain text `<input type="text">`, not
`type="file"`. Placeholder text: `/Users/you/Library/Developer/.../YourApp.app` (illustrative, in the input's
`placeholder`, not a `title`/tooltip — always visible until typed).

**States:**

- **Default:** both fields empty, submit button enabled (client-side emptiness check happens on submit, not
  as a blocking disabled state — don't punish the user for not having typed yet; HCI error prevention via
  inline feedback, not silent disabling).
- **Client validation error** (empty field(s) on submit): inline error text under the specific field(s),
  red border (`--fs-color-status-error-fg`), focus moves to the first invalid field. Copy:
  - App name: `Enter an app name.`
  - Path: `Enter the path to a .app bundle.`
- **Submitting:** primary button → loading state, label `Starting…`, both inputs `disabled`, button
  `aria-busy="true"`.
- **Server error (submit rejected):** form banner (not a toast — it's blocking primary-task feedback, keep it
  in-flow above the fields) with `role="alert"`. Copy by cause:
  - Bad/nonexistent path: `Couldn't find an app bundle at that path. Check it's a built .app and try again.`
  - Simulator unavailable: `The simulator isn't available right now. Make sure a simulator is booted or
installed, then try again.`
  - Generic/unmapped server error: `Couldn't start the run. Try again in a moment.`
    Inputs re-enable, values preserved (never clear the form on error — recognition over recall / don't punish
    retry).
- **Success:** redirect to `/runs/:runId` (the new run's live view). No intermediate "run started" screen —
  the live view's own status header is the confirmation (avoid a redundant extra click).

**Accessibility:** labels are real `<label for>` elements (not placeholder-as-label). Error text is
associated via `aria-describedby` and the input gets `aria-invalid="true"` while invalid. Target size: inputs
and button `min-height: 40px` (comfortably above the WCAG 2.5.8 AA 24px minimum).

---

## 3. Live view / Run detail (#94, #95-detail) — route `/runs/:runId`

**Components:** `Badge` (run-status), `StatCounter` × 2, `ActivityLogLine` list, `Card`, `Button`,
`EmptyState`, `Toast/Banner`.

### 3.1 Header (always present, both running and terminal)

```
← Runs                                    [Status Badge]
<App name>                    Run <runId> · started <time>
```

- Back-to-history affordance (`← Runs`) top-left, links to `/runs`.
- Status badge, one of: `Running` (blue, pulsing dot — decorative, paired with text, disabled under
  reduced-motion → static dot), `Completed` (green), `Partial` (amber, copy: `Partial (budget/step cap
reached)`), `Blocked on 2FA` (amber, copy: `Blocked on 2FA`), `Error` (red, copy: `Error`). Exact copy/tokens
  reused verbatim from E4 §9 so a returning operator sees the identical vocabulary in the dashboard and the
  report.

### 3.2 While running — `LivePanel`

```
┌───────────────────────────────────────────┐
│ States discovered        Steps taken      │  ← two StatCounter tiles
│        14                      37         │
├───────────────────────────────────────────┤
│ Tapping "Sign in" on Login screen          │  ← current-action line, aria-live="polite"
├───────────────────────────────────────────┤
│ Activity                                   │
│ 12:03:41  action     Tapped "Sign in"      │  ← ActivityLogLine list, newest at TOP
│ 12:03:39  navigate   Login → Home          │
│ 12:03:36  action     Typed into "Email"    │
│ …                                          │
│ [Show all (128)]                           │  ← appears only when capped
└───────────────────────────────────────────┘
```

- **Counters:** `States discovered`, `Steps taken` — exact PRD wording ("states-discovered" +
  "steps") mapped to plain-English labels. Numerals update in place; both tiles + the current-action line
  share one `aria-live="polite"` wrapper (system.md §3) so AT users hear one coalesced update, not three.
- **Current-action line:** single line, truncates with `…` + full text in `title` if it exceeds the container
  width (same truncation contract as E4 §4 — full text never lost to AT, only visually truncated via CSS).
  Before the first event arrives: `Starting the crawl…` (not a blank line — never show nothing while
  something is happening).
- **Activity log:** plain list, **newest entry at the top** (no auto-scroll logic needed — the operator always
  sees the latest without scrolling). Capped at **50 visible entries**; below the cap, a `Show all (N)` text
  button reveals the rest (no virtualization required for MVP, per PRD). Each line: relative-or-absolute
  timestamp (`--fs-size-xs`, `--fs-color-text-muted`), a kind label (`action`, `navigate`, `error`, etc.), and
  a short description.
  - **Unknown/new event kind** (FR7 seam — future `credential:prompt` etc.): rendered as a plain
    `ActivityLogLine` with the raw `kind` string in place of a mapped label, styled identically to known kinds
    (neutral, not error-colored) — "relayed, not dropped," and not visually flagged as broken.
- **Connection handling:** if the SSE stream disconnects before a terminal event, show a non-blocking banner
  (`role="status"`, since it's transient/self-healing, not a dead-end): `Connection lost — reconnecting…`
  while retrying; if reconnection is exhausted, escalate to `role="alert"`: `Lost the live connection. The run
may still be in progress — reload to check.` with a `Reload` button. The run itself is never assumed dead
  from a dropped stream (the engine may still be running server-side).

### 3.3 Terminal state — `RunSummary`

On terminal status, `LivePanel` is replaced by:

- The final counters + a one-line outcome summary (e.g. `Finished — 22 states, 61 steps, 9 workflows found.`
  for `completed`; for `error`: `Stopped early — <redacted error message>.`; for `partial`: `Stopped at the
step/budget cap — 22 states, 61 steps explored.`).
- Two affordances, side by side:
  - **`View workflow map`** (primary button) → `/runs/:runId/map`. Disabled + subtext `Map not available for
this run` if no graph was persisted (e.g. crawl errored before any state was recorded).
  - **`Open report`** (secondary button, external-link icon) → `/runs/:runId/report`. Disabled + subtext
    `Report not available` if no artifact exists.
- The activity log remains visible below (collapsed to the same capped list, now static) — the operator can
  still review what happened, it just no longer updates.

### 3.4 Not-found run

`EmptyState`: heading `Run not found`, body `This run doesn't exist or was removed.`, CTA button `Back to
runs` → `/runs`.

---

## 4. Runs history (#95) — route `/runs`

**Components:** `Table`, `Pagination`, `Badge` (run-status), `EmptyState`, `Skeleton`.

**Layout:** `<h1>Runs</h1>` + table.

| App  | Started      | Duration | Status              | Workflows |
| ---- | ------------ | -------- | ------------------- | --------- |
| Dime | Jul 2, 14:03 | 4m 12s   | `Completed` (badge) | 9         |

- Newest-first (server-ordered; UI does not re-sort).
- Whole row is a single link target (`Table` row-as-link pattern, system.md §2.9) to `/runs/:runId`; row hover
  gets `--fs-shadow-sm`; row focus gets the standard focus ring on the row's link.
- Duration for a still-running row: live-ish but this table does not poll per-row — show `Running…` in the
  Duration column instead of a number (a stopwatch that doesn't tick would be a lie; simplest honest state).
- Workflows column shows `—` (em dash, not `0` or blank) when not yet known (run still in progress / no
  workflows found) — distinguishes "zero found" from "not applicable yet." Use `0` only for a genuinely
  completed run with zero workflows.
- **Pagination:** cursor-based `Previous` / `Next` buttons below the table. `Previous` disabled on first page,
  `Next` disabled when the API reports no further cursor. No page-number input (cursor pagination has no
  stable total count to jump to — don't fake one).

**States:**

- **Loading:** `Skeleton` — 5 shimmering placeholder rows matching the table's column layout.
- **Empty (no runs ever):** `EmptyState` — heading `No runs yet`, body `Start a crawl to see it here.`, primary
  button `Start a run` → `/`.
- **Error (list fetch failed):** inline error state in place of the table — heading `Couldn't load runs`, body
  `Something went wrong loading your run history.`, `Retry` button.

Row click → `/runs/:runId`, which renders §3's `RunSummary` directly (run is already terminal in the common
history-browsing case) or `LivePanel` if the operator reopens a still-running run from history.

---

## 5. Map view (#96) — route `/runs/:runId/map`

Reuses the **information architecture** of the E4 HTML report (E4 spec §1–§5) as **React components**, not a
markup dump — same copy, same tokens, same badge/callout distinction, different implementation surface.

**Components:** `PurposeHeader`, `FeatureGroupSection` (uses `Disclosure`), `WorkflowCard` (uses `Badge`,
`Chip`, `Disclosure` for steps), `Callout` (duplicate-group), `EmptyState`, `Skeleton`.

**Layout:**

```
← Back to run
PurposeHeader          — app name, purpose (or placeholder), confidence, run-meta strip, status badge
FeatureGroupSection ×N — group name (h2), workflow count, collapsible (Disclosure)
  WorkflowCard ×N       — name, feature-group chip, hidden-path badge, description
    [Callout]           — duplicate-group callout, if applicable — identical copy to E4 §5.2
    Disclosure: "View steps (N)"
      ordered step list — screen label, description, action chip + payload, optional screenshot
```

- **`PurposeHeader`:** identical fields/placeholder copy to E4 §2.1 (`Purpose not determined for this run.`
  when absent/`"Unknown"`; confidence chip only when a confidence number exists). Run-status badge here reuses
  the same `Badge` variants as §3.
- **`FeatureGroupSection`:** `Disclosure`-based (open by default per group ≤15 workflows; groups over that size
  still default open — MVP does not need E4's TOC-scale threshold since the dashboard doesn't need a
  standalone TOC nav, the page itself is the browsable list). "Ungrouped" catch-all group always renders last,
  same rule as E4 §2.2.
- **`WorkflowCard`:** hidden-path badge — same icon, same copy `Hidden path`, same amber tokens as E4 §3, badge
  always visible (not behind the steps disclosure) so scanning the group finds it without expanding anything.
- **`Callout`:** duplicate-group block, same copy/tokens/role-chips as E4 §5.2 (`Canonical route` / `Hidden
route` / `Alternate route`, `(this workflow)` self-reference, `N distinct paths reach the same outcome`
  title, `Outcome: <screen>` line) — rendered once per converging workflow's card, identically, exactly as E4
  §5.1 specifies (this is the concept the whole ticket batch protects: it must look the same whether the
  operator is reading the live dashboard map or the exported HTML report — consistency & standards).
- **Steps:** same anatomy as E4 §4 (screen label, description, action chip + payload, screenshot). Screenshot
  `<img>` here references the artifact's served path (not base64-embedded — this is a live app hitting the
  API, not a portable static file); same lazy-loading, same "no screenshot captured" text fallback when absent.

**States:**

- **Loading:** `Skeleton` — a header-shaped bar + 3 card-shaped placeholders.
- **Not ready** (run still running, no persisted map yet): `EmptyState` — heading `Map not ready`, body `The
workflow map will be available once this run finishes.`, CTA button `Watch live` → `/runs/:runId` (back to
  the still-running `LivePanel`).
- **None generated** (run terminal, but no graph persisted — e.g. errored before any state recorded):
  `EmptyState` — heading `No workflow map for this run`, body `This run didn't discover enough to build a
map.`, no CTA beyond the header's `← Back to run`.
- **Empty workflows** (map exists, zero workflows found): same as E4 §7 empty case — header renders normally,
  body shows `No workflows were discovered in this run.` instead of feature groups.

---

## 6. Report view (#97) — route `/runs/:runId/report`

**Components:** `IframeEmbed`, `EmptyState`, `Skeleton`.

**Layout:**

```
← Back to run   <app name>                          [full-bleed below this bar]
┌───────────────────────────────────────────────────┐
│                                                     │
│         <sandboxed iframe, full remaining           │
│          viewport height, own scroll>               │
│                                                     │
└───────────────────────────────────────────────────┘
```

- Sticky top bar (`--fs-layout-header-height`-scale, thin): `← Back to run` link + app name. Does not scroll
  with the iframe's own content — the iframe has its own internal scroll (it's a full static document).
- **Iframe:** `sandbox=""` — no allowances (decision #2 above). `title="<App name> workflow report"` (iframes
  must have an accessible name). Full-bleed: fills remaining viewport height below the back-bar, no page
  chrome inside that region.
- **Loading:** `Skeleton` full-bleed block until the iframe's `onLoad` fires (show a centered `Loading
report…` label inside the skeleton, not just a bare shimmering rectangle — set expectation for what's
  coming).
- **Broken/missing artifact:** instead of an iframe, an `EmptyState` in the same full-bleed region:
  - Run not finished yet: heading `Report not ready`, body `This run hasn't finished yet — the report will be
ready once it completes.`, CTA `Watch live` → `/runs/:runId`.
  - Finished but no artifact / resolution failure: heading `Report not available`, body `No report was
  generated for this run.`
    Both keep the `← Back to run` bar above them — the back affordance is never lost, even in a broken state.

---

## 7. Accessibility summary (WCAG 2.2 AA, cross-view)

- **Focus order:** skip link → app-shell nav → page `<h1>` → page content, in DOM order, on every view.
- **Route-change focus:** per `system.md` §3 — focus moves to the new view's `<h1>` on every navigation
  (New run → Live view → Map/Report and back).
- **Labels:** every form field has a real `<label>`; every iframe has a `title`; every icon-only affordance
  (back arrow, external-link) has a visible text label alongside it — no icon-only buttons anywhere in this
  spec.
- **Contrast:** all badge/toast/button color pairs reuse `system.md` tokens already targeting ≥4.5:1 (body) /
  ≥3:1 (large text, icons); any new pairing introduced here (action button, disabled state) must be verified
  at build time, same obligation as E4 §8.
- **Target size:** interactive controls (buttons, inputs, table-row links, disclosure toggles) `min-height:
40px`.
- **Motion:** running-status pulsing dot, skeleton shimmer, toast slide, and log fade-in all disable under
  `prefers-reduced-motion: reduce`, falling back to a static equivalent (not just "no transition" but a
  genuinely static presentation — e.g. the pulsing dot becomes a plain filled dot).
- **Non-color-only signifiers:** run-status badges, hidden-path badge, and duplicate-callout role chips all
  pair color with text/icon, per E4 §8's rule carried forward unchanged.

---

## 8. Copy reference (exact strings, E5-specific — see E4 §9 for reused report-vocabulary strings)

| Element                                      | Copy                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| New-run field error: app name                | `Enter an app name.`                                                                                                    |
| New-run field error: path                    | `Enter the path to a .app bundle.`                                                                                      |
| New-run submit, loading                      | `Starting…`                                                                                                             |
| New-run server error: bad path               | `Couldn't find an app bundle at that path. Check it's a built .app and try again.`                                      |
| New-run server error: sim unavailable        | `The simulator isn't available right now. Make sure a simulator is booted or installed, then try again.`                |
| New-run server error: generic                | `Couldn't start the run. Try again in a moment.`                                                                        |
| Live view, before first event                | `Starting the crawl…`                                                                                                   |
| Live view, connection lost (retrying)        | `Connection lost — reconnecting…`                                                                                       |
| Live view, connection lost (exhausted)       | `Lost the live connection. The run may still be in progress — reload to check.`                                         |
| Run summary outcome: completed               | `Finished — {states} states, {steps} steps, {workflows} workflows found.`                                               |
| Run summary outcome: partial                 | `Stopped at the step/budget cap — {states} states, {steps} steps explored.`                                             |
| Run summary outcome: error                   | `Stopped early — {redacted error message}.`                                                                             |
| Map/report affordance disabled: map          | `Map not available for this run`                                                                                        |
| Map/report affordance disabled: report       | `Report not available`                                                                                                  |
| Run not found                                | `Run not found` / `This run doesn't exist or was removed.`                                                              |
| Runs history empty                           | `No runs yet` / `Start a crawl to see it here.` / button `Start a run`                                                  |
| Runs history load error                      | `Couldn't load runs` / `Something went wrong loading your run history.`                                                 |
| Map not ready (run running)                  | `Map not ready` / `The workflow map will be available once this run finishes.` / button `Watch live`                    |
| Map none generated                           | `No workflow map for this run` / `This run didn't discover enough to build a map.`                                      |
| Report not ready (run running)               | `Report not ready` / `This run hasn't finished yet — the report will be ready once it completes.` / button `Watch live` |
| Report not available (finished, no artifact) | `Report not available` / `No report was generated for this run.`                                                        |
| Skip link                                    | `Skip to content`                                                                                                       |
| Nav items                                    | `New run` / `Runs`                                                                                                      |
| Back affordances                             | `← Runs` (history) / `← Back to run` (map/report)                                                                       |

---

## Open items flagged back to product/architect (not blocking a first implementation pass)

- **Run outcome summary line wording for `error`** embeds "{redacted error message}" — the exact
  redaction/formatting contract for engine error messages surfaced to the UI isn't specified in the PRD beyond
  "the redacted message" (edge cases section). This spec assumes the API already hands the dashboard a
  human-readable, pre-redacted string; confirm with architect/security that no further client-side redaction
  is expected.
- **Duration display for a `partial`/`blocked-on-2fa` run in history** — this spec shows the real elapsed
  duration (not "Running…") since these are terminal states, but doesn't yet know whether the API's
  `duration` field is populated for every terminal status uniformly; confirm with architect during #E5.3
  wiring.
- **Workflow-map data source (PRD OQ1)** unresolved at design time — this spec is agnostic to whether §5's data
  comes from `Report.workflowMap` or on-demand `BuildWorkflowMap`; either satisfies the same component
  contract, so no design rework is needed once the architect decides.
