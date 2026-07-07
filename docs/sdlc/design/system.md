# FlowScout Design System

Status: living document. **Originated** in `docs/sdlc/design/e4-html-report-spec.md` §6 (static HTML report,
zero-JS). **Promoted here** for E5 (React+Vite web dashboard) so both surfaces share one token/primitive
vocabulary instead of forking styles. Any surface that needs a new visual value extends this file — no one-off
hex codes or ad hoc component styling in ticket-level specs.

Provenance rule: when a spec needs something not listed here, it proposes the addition **in this file**, not
inline in its own doc.

---

## 1. Tokens

All tokens are CSS custom properties, prefixed `--fs-*`, defined once on `:root` (or the framework-appropriate
equivalent — e.g. a Vite/CSS-modules `:root` in the dashboard's global stylesheet) and consumed by both the E4
report renderer and the E5 React app. Same names, same values, two build pipelines.

### 1.1 Color — neutrals

| Token                       | Value     | Use                                                                   |
| --------------------------- | --------- | --------------------------------------------------------------------- |
| `--fs-color-bg`             | `#ffffff` | Page background                                                       |
| `--fs-color-surface`        | `#f8f9fb` | Card/panel background, table stripe, skeletons                        |
| `--fs-color-surface-raised` | `#ffffff` | Elevated card on top of `--fs-color-surface` (needs `--fs-shadow-sm`) |
| `--fs-color-border`         | `#d8dce3` | Default borders, dividers, input borders                              |
| `--fs-color-text`           | `#1a1d23` | Primary text                                                          |
| `--fs-color-text-muted`     | `#5b6270` | Secondary text, timestamps, meta                                      |
| `--fs-color-link`           | `#1f4fd8` | Links, focus ring, primary-action base hue                            |

### 1.2 Color — semantic (shared hidden/duplicate/canonical + new run-status set)

Carried verbatim from E4 (do not re-derive):

| Token                                         | Value                             | Meaning                                   |
| --------------------------------------------- | --------------------------------- | ----------------------------------------- |
| `--fs-color-hidden-bg` / `-fg`                | `#fff4e5` / `#8a5300`             | Hidden-path badge (amber)                 |
| `--fs-color-duplicate-bg` / `-border` / `-fg` | `#eef2ff` / `#c7d2fe` / `#33389e` | Duplicate-group callout (indigo)          |
| `--fs-color-canonical-bg` / `-fg`             | `#e6f4ea` / `#1e7a34`             | Canonical-route chip (green)              |
| `--fs-color-status-warn-bg` / `-fg`           | `#fff4e5` / `#8a5300`             | Partial / blocked-on-2fa run-status badge |
| `--fs-color-status-error-bg` / `-fg`          | `#fdecec` / `#a32424`             | Error run-status badge, error toast       |

**New for E5** (the report only ever describes _finished_ runs; the dashboard also shows a run _in progress_ —
E4 had no "running" concept):

| Token                                  | Value                 | Meaning                                                                                                                                                                                         |
| -------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--fs-color-status-running-bg` / `-fg` | `#e6f0ff` / `#1f4fd8` | Running-status badge (blue, reuses link hue family so it doesn't collide with the amber/red/green semantic set)                                                                                 |
| `--fs-color-status-success-bg` / `-fg` | `#e6f4ea` / `#1e7a34` | Completed run badge — **alias of `--fs-color-canonical-bg/-fg`**, not a new hue (a 4th semantic hue would blur the amber/indigo/green/blue = hidden/duplicate/canonical-or-success/running set) |

Four semantic hues total across both surfaces: **amber** = hidden/warn, **indigo** = duplicate-relationship,
**green** = canonical/success, **blue** = running/in-progress. Never introduce a 5th without removing one.

**New for E5 — interactive control colors:**

| Token                                       | Value                           | Use                                                                                                                               |
| ------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `--fs-color-action-bg`                      | `#1f4fd8` (= `--fs-color-link`) | Primary button background                                                                                                         |
| `--fs-color-action-bg-hover`                | `#1a41b3`                       | Primary button hover                                                                                                              |
| `--fs-color-action-bg-active`               | `#15368f`                       | Primary button pressed                                                                                                            |
| `--fs-color-action-fg`                      | `#ffffff`                       | Primary button text/icon                                                                                                          |
| `--fs-color-disabled-bg`                    | `#eceef2`                       | Disabled control background                                                                                                       |
| `--fs-color-disabled-fg`                    | `#9aa1ac`                       | Disabled control text (decorative only — disabled controls also carry `disabled`/`aria-disabled`, never color-only)               |
| `--fs-color-danger-bg` / `-danger-bg-hover` | `#a32424` / `#8a1d1d`           | Destructive-intent button (not used in E5 MVP — no destructive actions exist yet; reserved so E6/E7 don't invent a different red) |

### 1.3 Type

Carried from E4, extended with one smaller step for dense UI (log timestamps, table meta):

| Token            | Value                                                                                 | Use                                              |
| ---------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `--fs-font-sans` | `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif` | All UI text                                      |
| `--fs-font-mono` | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`                            | Paths, action payloads, run ids                  |
| `--fs-size-xs`   | `0.6875rem` (11px)                                                                    | **New.** Log timestamps, table meta, helper text |
| `--fs-size-sm`   | `0.8125rem` (13px)                                                                    | Chips, labels, meta                              |
| `--fs-size-base` | `1rem` (16px)                                                                         | Body, inputs, buttons                            |
| `--fs-size-lg`   | `1.25rem` (20px)                                                                      | Section/card titles                              |
| `--fs-size-xl`   | `1.75rem` (28px)                                                                      | Page/app-name titles                             |

### 1.4 Spacing (4px base) — unchanged from E4

`--fs-space-1` 4px · `--fs-space-2` 8px · `--fs-space-3` 12px · `--fs-space-4` 16px · `--fs-space-6` 24px ·
`--fs-space-8` 32px.

### 1.5 Radius — unchanged, +1 new

`--fs-radius-sm` 4px (chips, badges) · `--fs-radius-md` 8px (cards, inputs, buttons) · **`--fs-radius-lg` 12px
(new — modals/toasts if E5 ever needs one; not required by this ticket batch but reserved so nobody invents
`10px` ad hoc)**.

### 1.6 Elevation — new (E4 was flat static HTML; E5 has layered surfaces)

| Token            | Value                            | Use                                           |
| ---------------- | -------------------------------- | --------------------------------------------- |
| `--fs-shadow-sm` | `0 1px 2px rgba(26,29,35,0.08)`  | Cards, table rows on hover, run-summary panel |
| `--fs-shadow-md` | `0 4px 12px rgba(26,29,35,0.12)` | Toast/banner, any transient overlay           |

### 1.7 Motion — extended

| Token              | Value        | Use                                                                    |
| ------------------ | ------------ | ---------------------------------------------------------------------- |
| `--fs-motion-fast` | `120ms ease` | Focus/hover transitions (unchanged from E4)                            |
| `--fs-motion-med`  | `200ms ease` | **New.** Toast enter/exit, activity-log line fade-in, skeleton shimmer |

```css
@media (prefers-reduced-motion: reduce) {
  * {
    transition: none !important;
    animation: none !important;
  }
}
```

Reduced-motion is a hard requirement on every animated primitive below (spinner, skeleton shimmer, toast
slide, log fade-in) — each must have a static fallback, not just a faster one.

### 1.8 Layout — new (E4 is a single scrolling document; E5 is an app shell)

| Token                       | Value               | Use                              |
| --------------------------- | ------------------- | -------------------------------- |
| `--fs-layout-maxwidth`      | `1120px`            | Page content max-width, centered |
| `--fs-layout-header-height` | `56px`              | App-shell top nav height         |
| `--fs-layout-gutter`        | `var(--fs-space-6)` | Page horizontal padding          |

---

## 2. Primitives (component inventory)

Each primitive lists its states. "Reused from E4" = same tokens/copy/structure as the HTML report so the two
surfaces read as one product.

1. **Badge** (status/semantic, non-interactive) — variants: `hidden-path` (amber, reused from E4), `canonical`
   (green, reused), `alternate` (neutral chip, reused), run-status: `running` (blue, new), `completed` (green),
   `partial` (amber), `blocked-on-2fa` (amber), `error` (red). Always icon/text, never color-only.
2. **Chip** — feature-group chip, action-type chip (reused from E4 §3/§4).
3. **Callout** (`<aside>`, duplicate-path group) — reused verbatim from E4 §5 (copy, tokens, structure).
4. **Button** — `primary` (filled, `--fs-color-action-*`), `secondary` (outline, border + text color, transparent
   bg), states: default/hover/active/focus-visible/disabled/loading (inline spinner + label change, e.g. "Start
   crawl" → "Starting…").
5. **TextInput** — states: default/focus/error/disabled; error state pairs a red border (`--fs-color-status-error-fg`)
   with inline text (never border-color-only).
6. **Toast / Banner** — `error` (`role="alert"`, persists until dismissed), `success`/`info` (`role="status"`,
   auto-dismiss ~5s, pauses on hover/focus). Positioned top-of-content, `--fs-shadow-md`.
7. **EmptyState** — heading + one-line body + optional primary-button CTA. No illustration (avoid decorative
   gold-plating on an internal tool).
8. **Skeleton** — shimmering placeholder blocks for header/cards/table rows during loading; static (no shimmer)
   under reduced-motion — replaced by a flat `--fs-color-surface` block.
9. **Table** — header row + data rows, row-as-link pattern (whole row navigates via one real `<a>`/`<button>`,
   not a `<tr onClick>` div-soup — keeps it keyboard- and screen-reader-operable).
10. **Pagination control** — `Previous`/`Next` cursor buttons, disabled at either end.
11. **Disclosure** (`<details>/<summary>` or an ARIA-equivalent toggle button with `aria-expanded`) — used for
    collapsible feature groups and step lists in the map view; same interaction pattern as the E4 report
    (consistency & standards across surfaces).
12. **AppShellNav** — top bar: wordmark + two nav items (`New run`, `Runs`), current-route indicated (not
    color-only — underline + `aria-current="page"`).
13. **StatCounter** — labeled numeric tile (e.g. "States discovered", "Steps taken"); numeral updates in place,
    wrapped in a shared `aria-live="polite"` region with the current-action line (see §3 dashboard spec) so
    assistive tech gets one coalesced announcement, not one per counter.
14. **ActivityLogLine** — timestamp + kind label + description; `unknown-kind` variant renders neutrally styled,
    not as an error.
15. **Card** — generic bordered container (`--fs-color-surface-raised`, `--fs-shadow-sm`, `--fs-radius-md`) —
    base for workflow cards, run-summary panel.
16. **IframeEmbed** — sandboxed embed wrapper + sticky back-affordance bar; broken/missing state renders an
    `EmptyState` instead of an empty frame.
17. **Icon glyph set** — inline SVG, no icon font/external asset (consistent with E4 §0 decision 3): fork/eye-slash
    (hidden), merge-arrows (duplicate), spinner (loading — CSS animation, reduced-motion fallback = static
    "Loading…" text), chevron (pagination/disclosure), external-link (open report), back-arrow (back affordance).

**Primitive count: 17** (listed above). Each is stack-agnostic in description; the E5 spec below says which
ones compose each view.

---

## 3. Interaction patterns (cross-surface)

- **Focus ring:** `:focus-visible { outline: 2px solid var(--fs-color-link); outline-offset: 2px; }` everywhere,
  never `outline: none` without this replacement. Same rule as E4 §8.
- **Route-change focus management (E5-specific, SPA):** on every navigation, move focus to the new view's `<h1>`
  (`tabIndex={-1}`, `.focus()` on mount) and update `document.title` to `"<View> · FlowScout"`. Screen-reader
  users get both a focus jump and a title announcement — without this, SPA navigation is invisible to AT users
  (WCAG 2.4.3, HCI "visibility of system status").
- **Live-region discipline:** exactly one `aria-live="polite"` region per live view, wrapping the current-action
  line + stat counters as one coalesced update. The activity log itself is **not** a live region — it updates
  visually only. Rationale: an `aria-live` on a fast-scrolling log would spam AT users with every line;
  polling the coalesced summary line is sufficient for "visibility of system status" without being a firehose.
- **Errors are `role="alert"` (assertive, persist until dismissed); success/info are `role="status"` (polite,
  auto-dismiss).** Never use `alert()`/native dialogs.
- **Disclosure consistency:** the same expand/collapse interaction (native `<details>/<summary>` in the report;
  an equivalent controlled disclosure in React) is used for both the report and the dashboard's map view —
  same click target, same chevron glyph, same keyboard behavior (Enter/Space).
- **Skip link:** app shell has a `Skip to content` link, visually hidden until focused, as the first focusable
  element — same pattern as E4's `Skip to workflows`.

---

## Changelog

- **E4 (origin):** color (neutrals + hidden/duplicate/canonical/status-warn/status-error), type, spacing,
  radius (sm/md), motion-fast. Primitives: Badge (hidden), Callout (duplicate), Chip.
- **E5 (this promotion):** added running/success status colors, action/disabled/danger-reserved control colors,
  `--fs-size-xs`, `--fs-radius-lg`, elevation tokens, `--fs-motion-med`, layout tokens. Primitives: Button,
  TextInput, Toast, EmptyState, Skeleton, Table, Pagination, Disclosure, AppShellNav, StatCounter,
  ActivityLogLine, Card, IframeEmbed, extended icon glyph set. Cross-surface interaction patterns section added.
