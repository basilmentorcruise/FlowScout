/**
 * Static stylesheet constant — the ONLY CSS in the artifact, inlined into <head>
 * via trustedRaw (NFR2: self-contained, zero external fetches; T5/M87.5).
 *
 * Token set is the design spec §6 block VERBATIM (the E4 design-system seed —
 * ~30 `--fs-*` custom properties). Component rules compose exclusively from those
 * tokens; no ad-hoc hex values outside this set.
 *
 * PACKAGE-OWNED STATIC TEXT ONLY — no renderer input may ever be spliced in here.
 */
export const REPORT_STYLESHEET = `
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

* {
  box-sizing: border-box;
}

body {
  margin: 0 auto;
  max-width: 60rem;
  padding: var(--fs-space-6) var(--fs-space-4) var(--fs-space-8);
  background: var(--fs-color-bg);
  color: var(--fs-color-text);
  font-family: var(--fs-font-sans);
  font-size: var(--fs-size-base);
  line-height: 1.55;
}

a {
  color: var(--fs-color-link);
  transition: color var(--fs-motion-fast);
}

:focus-visible {
  outline: 2px solid var(--fs-color-link);
  outline-offset: 2px;
}

code {
  font-family: var(--fs-font-mono);
}

/* Skip link — visually hidden until focused (WCAG 2.4.1) */
.fs-skip-link {
  position: absolute;
  left: -999px;
  top: 0;
  background: var(--fs-color-bg);
  padding: var(--fs-space-2) var(--fs-space-3);
  border: 1px solid var(--fs-color-border);
  border-radius: var(--fs-radius-sm);
  z-index: 1;
}

.fs-skip-link:focus-visible {
  left: var(--fs-space-2);
}

/* Header */
.fs-header {
  border-bottom: 1px solid var(--fs-color-border);
  padding-bottom: var(--fs-space-6);
  margin-bottom: var(--fs-space-6);
}

.fs-eyebrow {
  color: var(--fs-color-text-muted);
  font-size: var(--fs-size-sm);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin: 0 0 var(--fs-space-1);
}

.fs-app-name {
  font-size: var(--fs-size-xl);
  margin: 0 0 var(--fs-space-2);
  overflow-wrap: anywhere;
}

.fs-purpose {
  margin: 0 0 var(--fs-space-4);
  overflow-wrap: anywhere;
}

.fs-confidence {
  color: var(--fs-color-text-muted);
  font-size: var(--fs-size-sm);
}

.fs-run-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--fs-space-4) var(--fs-space-6);
  margin: 0;
  font-size: var(--fs-size-sm);
}

.fs-run-meta dt {
  color: var(--fs-color-text-muted);
}

.fs-run-meta dd {
  margin: 0;
  overflow-wrap: anywhere;
}

/* Status badges — text label is the primary signifier, color is supplementary */
.fs-status {
  display: inline-block;
  padding: 0 var(--fs-space-2);
  border-radius: var(--fs-radius-sm);
}

.fs-status-warn {
  background: var(--fs-color-status-warn-bg);
  color: var(--fs-color-status-warn-fg);
}

.fs-status-error {
  background: var(--fs-color-status-error-bg);
  color: var(--fs-color-status-error-fg);
}

/* TOC */
.fs-toc {
  background: var(--fs-color-surface);
  border: 1px solid var(--fs-color-border);
  border-radius: var(--fs-radius-md);
  padding: var(--fs-space-4) var(--fs-space-6);
  margin-bottom: var(--fs-space-8);
}

.fs-toc h2 {
  font-size: var(--fs-size-lg);
  margin-top: 0;
}

.fs-toc-group h3 {
  display: inline-block;
  font-size: var(--fs-size-base);
  margin: var(--fs-space-2) 0;
}

.fs-toc-group summary {
  cursor: pointer;
  min-height: 24px;
  padding: var(--fs-space-2) 0;
}

.fs-toc-group ul {
  margin: 0 0 var(--fs-space-2);
}

.fs-toc-group li {
  padding: var(--fs-space-1) 0;
}

.fs-toc-group a {
  min-height: 24px;
  display: inline-block;
}

.fs-count {
  color: var(--fs-color-text-muted);
  font-weight: normal;
  font-size: var(--fs-size-sm);
}

/* Feature-group sections + workflow articles */
.fs-group > h2 {
  font-size: var(--fs-size-lg);
  border-bottom: 1px solid var(--fs-color-border);
  padding-bottom: var(--fs-space-2);
}

.fs-workflow {
  border: 1px solid var(--fs-color-border);
  border-radius: var(--fs-radius-md);
  padding: var(--fs-space-4) var(--fs-space-6);
  margin: var(--fs-space-6) 0;
}

.fs-workflow-header h3 {
  font-size: var(--fs-size-lg);
  margin: 0 0 var(--fs-space-2);
  overflow-wrap: anywhere;
}

.fs-workflow-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--fs-space-2);
  align-items: center;
  margin: 0 0 var(--fs-space-2);
}

.fs-workflow-desc {
  color: var(--fs-color-text-muted);
  margin: 0 0 var(--fs-space-3);
  overflow-wrap: anywhere;
}

/* Chips */
.fs-chip {
  display: inline-block;
  font-size: var(--fs-size-sm);
  padding: 0 var(--fs-space-2);
  border-radius: var(--fs-radius-sm);
  background: var(--fs-color-surface);
  border: 1px solid var(--fs-color-border);
  overflow-wrap: anywhere;
}

/* Steps */
.fs-steps {
  list-style: none;
  margin: 0;
  padding: 0;
}

.fs-step {
  display: flex;
  gap: var(--fs-space-3);
  padding: var(--fs-space-3) 0;
  border-top: 1px solid var(--fs-color-border);
}

.fs-step-index {
  flex: none;
  width: var(--fs-space-8);
  height: var(--fs-space-8);
  border-radius: 50%;
  background: var(--fs-color-surface);
  border: 1px solid var(--fs-color-border);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-size-sm);
}

.fs-step-body {
  min-width: 0;
  flex: 1;
}

.fs-step-screen {
  font-weight: 600;
  margin: 0;
}

.fs-step-desc {
  margin: var(--fs-space-1) 0;
  color: var(--fs-color-text-muted);
}

/* Visual clamp for long single-line tokens (>140 chars) — CSS-only so assistive
   tech still receives the full string (design spec §4). */
.fs-clamp {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fs-step-action {
  display: flex;
  flex-wrap: wrap;
  gap: var(--fs-space-2);
  align-items: baseline;
  margin: var(--fs-space-1) 0;
}

.fs-step-payload {
  font-size: var(--fs-size-sm);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 12rem;
  overflow-y: auto;
  display: block;
  background: var(--fs-color-surface);
  border-radius: var(--fs-radius-sm);
  padding: var(--fs-space-1) var(--fs-space-2);
}

.fs-step-shot summary {
  cursor: pointer;
  color: var(--fs-color-link);
  font-size: var(--fs-size-sm);
  min-height: 24px;
  padding: var(--fs-space-2) 0;
}

.fs-screenshot {
  max-width: 100%;
  height: auto;
  border: 1px solid var(--fs-color-border);
  border-radius: var(--fs-radius-md);
}

.fs-step-noshot {
  color: var(--fs-color-text-muted);
  font-size: var(--fs-size-sm);
  font-style: italic;
  margin: var(--fs-space-1) 0 0;
}

/* Empty state */
.fs-empty {
  color: var(--fs-color-text-muted);
  margin: 0;
}

/* Footer */
.fs-footer {
  border-top: 1px solid var(--fs-color-border);
  margin-top: var(--fs-space-8);
  padding-top: var(--fs-space-4);
  color: var(--fs-color-text-muted);
  font-size: var(--fs-size-sm);
}
`;
