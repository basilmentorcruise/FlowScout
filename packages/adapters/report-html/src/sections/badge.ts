/**
 * Hidden-path badge partials (#88, design spec §3 — E4.2).
 *
 * A hidden path is a PROPERTY OF ONE WORKFLOW (`Workflow.isHiddenPath`), rendered as an
 * inline amber chip in the workflow header (icon + exact copy "Hidden path") and echoed
 * as a small glyph next to the workflow's TOC link. Structurally distinct from the
 * duplicate-group callout (an <aside> relationship block — see convergence.ts).
 *
 * Non-color signifiers (WCAG 1.4.1): branch icon + the text label / aria-label — never
 * color alone. Both fragments are fully static package-owned markup; the only trustedRaw
 * call is the static inline SVG glyph (per html.ts policy: package-internal constants only).
 */
import type { SafeHtml } from "../html.js";
import { html, trustedRaw } from "../html.js";

/** Exact copy — design spec §9. */
export const HIDDEN_BADGE_LABEL = "Hidden path";

/**
 * Fork/branch glyph (single inline SVG, no external asset — design spec §3).
 * PACKAGE-OWNED STATIC MARKUP ONLY — never derived from input.
 */
const BRANCH_ICON: SafeHtml = trustedRaw(
  '<svg aria-hidden="true" class="fs-icon" viewBox="0 0 16 16" fill="none" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' +
    '<circle cx="4.5" cy="3.5" r="1.7"></circle>' +
    '<circle cx="4.5" cy="12.5" r="1.7"></circle>' +
    '<circle cx="11.5" cy="5.5" r="1.7"></circle>' +
    '<path d="M4.5 5.2v5.6"></path>' +
    '<path d="M11.5 7.2c0 2.6-4 2.5-5.5 3.8"></path>' +
    "</svg>",
);

/** Detail badge — inline amber chip in the workflow header (design spec §3). */
export function renderHiddenBadgeDetail(): SafeHtml {
  return html`<span class="fs-badge fs-badge-hidden" role="img" aria-label="${HIDDEN_BADGE_LABEL}"
    >${BRANCH_ICON} ${HIDDEN_BADGE_LABEL}</span
  >`;
}

/** Index echo — small glyph next to the TOC link (design spec §2.2/§3). */
export function renderHiddenBadgeIndex(): SafeHtml {
  return html`<span
    class="fs-badge fs-badge-hidden fs-badge-hidden-index"
    role="img"
    aria-label="${HIDDEN_BADGE_LABEL}"
    title="${HIDDEN_BADGE_LABEL}"
    >${BRANCH_ICON}</span
  >`;
}
