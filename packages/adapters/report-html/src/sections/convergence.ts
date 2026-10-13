/**
 * Duplicate-group convergence callout partial (#88, design spec §5 — E4.2).
 *
 * A duplicate group is a RELATIONSHIP BETWEEN WORKFLOWS (`WorkflowMap.duplicateGroups`):
 * a full-width indigo <aside> rendered identically on EVERY converging workflow (differing
 * only in the "(this workflow)" self-reference marker), with jump-links between the
 * converging workflows and an explicit role chip per route. Structurally distinct from
 * the hidden-path badge (an inline header chip — see badge.ts).
 *
 * Non-color signifiers (WCAG 1.4.1): merge-arrows icon + "distinct paths" title copy +
 * explicit text chips (`Canonical route` / `Hidden route` / `Alternate route`) — never
 * color alone. Route names are untrusted and flow through the `html` boundary (T7/M88.1);
 * anchor ids arrive pre-derived via safeAnchorId (M88.2 — never raw Workflow.id).
 */
import type { SafeHtml } from "../html.js";
import { html, trustedRaw } from "../html.js";

/** Exact copy — design spec §9. */
export const CALLOUT_ARIA_LABEL = "Duplicate path group";
export const CANONICAL_CHIP_LABEL = "Canonical route";
export const HIDDEN_CHIP_LABEL = "Hidden route";
export const ALTERNATE_CHIP_LABEL = "Alternate route";
export const SELF_REFERENCE_MARKER = "(this workflow)";

/** Role of one converging route inside the group (design spec §5.2). */
export type ConvergenceRouteRole = "canonical" | "hidden" | "alternate";

export interface ConvergenceRouteView {
  /** Charset-allowlisted anchor token derived via safeAnchorId — NEVER a raw Workflow.id. */
  readonly anchorId: string;
  /** Untrusted display name (already length-capped) — encoded here at the html boundary. */
  readonly name: string;
  readonly role: ConvergenceRouteRole;
  /** True on the route matching the article this callout instance is rendered into. */
  readonly isCurrent: boolean;
}

export interface ConvergenceCalloutView {
  /** N = DuplicatePathGroup.workflowIds.length (exact copy uses this count). */
  readonly pathCount: number;
  /** Resolved outcome screen label, or the "Unknown screen" fallback (design spec §5.2). */
  readonly outcomeLabel: string;
  /** Canonical route first, then the remaining routes in domain-sorted order. */
  readonly routes: readonly ConvergenceRouteView[];
}

const CHIP_LABEL: Readonly<Record<ConvergenceRouteRole, string>> = {
  canonical: CANONICAL_CHIP_LABEL,
  hidden: HIDDEN_CHIP_LABEL,
  alternate: ALTERNATE_CHIP_LABEL,
};

/** Static class names (package constants; escaping at interpolation is a no-op). */
const CHIP_CLASS: Readonly<Record<ConvergenceRouteRole, string>> = {
  canonical: "fs-chip fs-chip-canonical",
  hidden: "fs-chip fs-chip-hidden",
  alternate: "fs-chip fs-chip-alt",
};

const ROUTE_CLASS: Readonly<Record<ConvergenceRouteRole, string>> = {
  canonical: "fs-route fs-route-canonical",
  hidden: "fs-route fs-route-hidden",
  alternate: "fs-route",
};

/**
 * Convergence / merge-arrows glyph (single inline SVG, no external asset).
 * PACKAGE-OWNED STATIC MARKUP ONLY — never derived from input.
 */
const MERGE_ICON: SafeHtml = trustedRaw(
  '<svg aria-hidden="true" class="fs-icon" viewBox="0 0 16 16" fill="none" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M2 3.5h3l3 4.5 3-4.5h3"></path>' +
    '<path d="M8 8v5"></path>' +
    '<path d="M5.8 10.8 8 13l2.2-2.2"></path>' +
    "</svg>",
);

function renderRoute(route: ConvergenceRouteView): SafeHtml {
  const marker = route.isCurrent
    ? html` <span class="fs-you-are-here">${SELF_REFERENCE_MARKER}</span>`
    : null;
  return html`<li class="${ROUTE_CLASS[route.role]}">
    <span class="${CHIP_CLASS[route.role]}">${CHIP_LABEL[route.role]}</span>
    <a href="#${route.anchorId}">${route.name}</a>${marker}
  </li>`;
}

/** The full-width indigo <aside> injected between a workflow's header and its steps. */
export function renderConvergenceCallout(view: ConvergenceCalloutView): SafeHtml {
  return html`<aside class="fs-duplicate-callout" aria-label="${CALLOUT_ARIA_LABEL}">
    <p class="fs-duplicate-title">
      ${MERGE_ICON}
      <strong>${view.pathCount} distinct paths reach the same outcome</strong>
    </p>
    <p class="fs-duplicate-outcome">Outcome: ${view.outcomeLabel}</p>
    <ul class="fs-duplicate-routes">
      ${view.routes.map(renderRoute)}
    </ul>
  </aside>`;
}
