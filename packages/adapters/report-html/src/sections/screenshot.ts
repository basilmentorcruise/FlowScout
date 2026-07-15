/**
 * Per-step screenshot evidence (FR5, design spec §4). Pure (input) → SafeHtml.
 *
 * `src` MUST already be validated by safeImageSrc (the resolver guarantees this);
 * a null src renders the text-only no-screenshot path — never a broken <img>.
 */
import type { SafeHtml } from "../html.js";
import { html } from "../html.js";

/** Exact copy — design spec §9. */
export const NO_SCREENSHOT_MESSAGE = "No screenshot captured for this screen.";

export interface ScreenshotViewInput {
  /** safeImageSrc-validated src, or null to degrade to text. */
  readonly src: string | null;
  readonly screenLabel: string;
  readonly stepNumber: number;
  readonly workflowName: string;
  /** <details open> when the workflow has ≤6 steps (design spec §4). */
  readonly open: boolean;
}

export function renderScreenshot(input: ScreenshotViewInput): SafeHtml {
  if (input.src === null) {
    return html`<p class="fs-step-noshot">${NO_SCREENSHOT_MESSAGE}</p>`;
  }
  const alt = `Screen: ${input.screenLabel} — step ${String(input.stepNumber)} of ${input.workflowName}`;
  const img = html`<img src="${input.src}" alt="${alt}" loading="lazy" class="fs-screenshot" />`;
  if (input.open) {
    return html`<details class="fs-step-shot" open>
      <summary>Screenshot</summary>
      ${img}
    </details>`;
  }
  return html`<details class="fs-step-shot">
    <summary>Screenshot</summary>
    ${img}
  </details>`;
}
