/**
 * Table of contents grouped by feature (FR3, design spec §2.2). Pure (input) → SafeHtml.
 * Groups above TOC_COLLAPSIBLE_MIN_ENTRIES entries render as <details open> (no JS).
 */
import type { SafeHtml } from "../html.js";
import { html } from "../html.js";
import type { FeatureGroupView } from "../viewmodel.js";

/** Exact copy — design spec §9. */
export const EMPTY_MAP_MESSAGE = "No workflows were discovered in this run.";

function tocEntries(group: FeatureGroupView): SafeHtml {
  const items = group.workflows.map(
    (workflow) =>
      html`<li>
        <a href="#${workflow.anchorId}">${workflow.name}</a>
        ${workflow.annotations.indexBadges}
      </li>`,
  );
  return html`<ul>
    ${items}
  </ul>`;
}

function tocGroup(group: FeatureGroupView): SafeHtml {
  const heading = html`<h3>
    ${group.name} <span class="fs-count">(${group.workflows.length} workflows)</span>
  </h3>`;
  if (group.collapsible) {
    return html`<details open class="fs-toc-group">
      <summary>${heading}</summary>
      ${tocEntries(group)}
    </details>`;
  }
  return html`<div class="fs-toc-group">${heading} ${tocEntries(group)}</div>`;
}

export function renderToc(groups: readonly FeatureGroupView[]): SafeHtml {
  const body =
    groups.length === 0
      ? html`<p class="fs-empty">${EMPTY_MAP_MESSAGE}</p>`
      : html`${groups.map(tocGroup)}`;
  return html`
    <nav aria-label="Workflow index" class="fs-toc">
      <h2 id="toc-heading">Workflows by feature</h2>
      ${body}
    </nav>
  `;
}
