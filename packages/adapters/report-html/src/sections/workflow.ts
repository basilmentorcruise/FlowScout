/**
 * Workflow detail article (FR3/FR4, design spec §3). Pure (input) → SafeHtml.
 *
 * Renders the #88 annotation slots from day one (ADR-0009 §4): detail badges in the
 * header meta row, callouts between the header and the steps. In #87 both are empty.
 */
import type { SafeHtml } from "../html.js";
import { html } from "../html.js";
import type { WorkflowView } from "../viewmodel.js";
import { renderStep, type StepRenderContext } from "./step.js";

export function renderWorkflow(
  workflow: WorkflowView,
  screenshotSrcByUri: ReadonlyMap<string, string | null>,
): SafeHtml {
  const context: StepRenderContext = {
    workflowAnchorId: workflow.anchorId,
    workflowName: workflow.name,
    screenshotsOpen: workflow.screenshotsOpen,
    screenshotSrcByUri,
  };
  const steps = workflow.steps.map((step) => renderStep(step, context));
  return html`<article
    id="${workflow.anchorId}"
    class="fs-workflow"
    aria-labelledby="${workflow.anchorId}-title"
  >
    <header class="fs-workflow-header">
      <h3 id="${workflow.anchorId}-title">${workflow.name}</h3>
      <p class="fs-workflow-meta">
        <span class="fs-chip fs-chip-group">${workflow.featureGroup}</span>
        ${workflow.annotations.detailBadges}
      </p>
      <p class="fs-workflow-desc">${workflow.description}</p>
    </header>
    ${workflow.annotations.callouts}
    <ol class="fs-steps">
      ${steps}
    </ol>
  </article>`;
}
