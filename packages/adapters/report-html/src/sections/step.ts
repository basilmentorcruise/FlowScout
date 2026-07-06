/**
 * Single workflow step (FR4/FR5, design spec §4). Pure (input) → SafeHtml.
 *
 * - Terminal step (action === null): no action row at all.
 * - Screen label / step description longer than CLAMP_THRESHOLD_CHARS get the CSS-only
 *   `.fs-clamp` treatment + full value in `title` (assistive tech keeps the full text).
 * - actionPayload renders in <code> with pre-wrap + max-height scroll (never mid-payload
 *   truncated — design spec §4 exception).
 */
import type { SafeHtml } from "../html.js";
import { html } from "../html.js";
import type { StepView } from "../viewmodel.js";
import { CLAMP_THRESHOLD_CHARS } from "../viewmodel.js";
import { renderScreenshot } from "./screenshot.js";

function clampedText(cssClass: string, text: string): SafeHtml {
  if (text.length > CLAMP_THRESHOLD_CHARS) {
    return html`<p class="${cssClass} fs-clamp" title="${text}">${text}</p>`;
  }
  return html`<p class="${cssClass}">${text}</p>`;
}

function actionRow(step: StepView): SafeHtml | null {
  if (step.action === null) {
    return null;
  }
  return html`<p class="fs-step-action">
    <span class="fs-chip fs-chip-action">${step.action.type}</span>
    <code class="fs-step-payload">${step.action.payload}</code>
  </p>`;
}

export interface StepRenderContext {
  readonly workflowAnchorId: string;
  readonly workflowName: string;
  readonly screenshotsOpen: boolean;
  /** Resolved safe screenshot src per raw screenshotUri (null ⇒ placeholder). */
  readonly screenshotSrcByUri: ReadonlyMap<string, string | null>;
}

export function renderStep(step: StepView, context: StepRenderContext): SafeHtml {
  const src =
    step.screenshotUri === null
      ? null
      : (context.screenshotSrcByUri.get(step.screenshotUri) ?? null);
  return html`<li class="fs-step" id="${context.workflowAnchorId}-step-${step.index}">
    <span class="fs-step-index" aria-hidden="true">${step.displayNumber}</span>
    <div class="fs-step-body">
      ${clampedText("fs-step-screen", step.screenLabel)}
      ${clampedText("fs-step-desc", step.description)} ${actionRow(step)}
      ${renderScreenshot({
        src,
        screenLabel: step.screenLabel,
        stepNumber: step.displayNumber,
        workflowName: context.workflowName,
        open: context.screenshotsOpen,
      })}
    </div>
  </li>`;
}
