/**
 * App-purpose header section (FR2, design spec §2.1). Pure (input) → SafeHtml.
 */
import type { SafeHtml } from "../html.js";
import { html } from "../html.js";
import type { HeaderView } from "../viewmodel.js";

/** Exact copy — design spec §9. */
export const PURPOSE_PLACEHOLDER = "Purpose not determined for this run.";

const STATUS_COPY: Record<HeaderView["runStatus"], string> = {
  completed: "Completed",
  partial: "Partial (budget/step cap reached)",
  "blocked-on-2fa": "Blocked on 2FA",
  error: "Error",
};

const STATUS_CLASS: Record<HeaderView["runStatus"], string> = {
  completed: "fs-status",
  partial: "fs-status fs-status-warn",
  "blocked-on-2fa": "fs-status fs-status-warn",
  error: "fs-status fs-status-error",
};

/** Deterministic human formatting of an ISO-8601 timestamp (no locale dependence). */
export function formatIsoTimestamp(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return match ? `${match[1] ?? ""} ${match[2] ?? ""} UTC` : iso;
}

function renderPurpose(view: HeaderView): SafeHtml {
  if (view.purpose === null) {
    return html`<p class="fs-purpose">${PURPOSE_PLACEHOLDER}</p>`;
  }
  const confidence =
    view.confidencePct === null
      ? null
      : html`
          <span class="fs-confidence" title="Inference confidence"
            >· ${view.confidencePct}% confidence</span
          >
        `;
  return html`<p class="fs-purpose">${view.purpose} ${confidence}</p>`;
}

function metaEntry(label: string, value: SafeHtml): SafeHtml {
  return html`<div>
    <dt>${label}</dt>
    <dd>${value}</dd>
  </div>`;
}

export function renderHeader(view: HeaderView): SafeHtml {
  const status = html`<span class="${STATUS_CLASS[view.runStatus]}"
    >${STATUS_COPY[view.runStatus]}</span
  >`;
  const generated = html`<time datetime="${view.generatedAt}"
    >${formatIsoTimestamp(view.generatedAt)}</time
  >`;
  return html`
    <header id="top" class="fs-header">
      <p class="fs-eyebrow">FlowScout workflow report</p>
      <h1 class="fs-app-name">${view.appId}</h1>
      ${renderPurpose(view)}
      <dl class="fs-run-meta">
        ${metaEntry("Run", html`${view.runId}`)}
        ${metaEntry("App version", html`${view.appVersion}`)} ${metaEntry("Generated", generated)}
        ${metaEntry("Status", status)}
        ${metaEntry("States explored", html`${view.totalStates}`)}
        ${metaEntry("Workflows found", html`${view.totalWorkflows}`)}
      </dl>
    </header>
  `;
}
