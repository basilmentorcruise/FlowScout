---
name: recurring-risks-e4-html-report
description: E4 (grouped HTML report) is where the E3→E7→E4 T7 XSS handoff is ENFORCED — a self-contained static HTML file built from attacker-influenceable crawl content, opened at file://. Recurring risks: XSS across every interpolation context, screenshotUri scheme injection into <img src>, path traversal on artifact write + screenshot read, anchor/id injection, phone-home, render-dep supply chain.
metadata:
  type: project
---

E4 (#4, tickets #87 core renderer / #88 hidden-duplicate visualization / #89 render+persist use-case)
renders the finalized `WorkflowMap` (+ `StateGraph`) to a **self-contained static HTML file** in
`adapters/report-html` (`ReportRendererPort.render`), wired by an application use-case that flips
`ReportMetadata.artifactUri` via the existing E7 `ReportRepository.save` upsert. It imports only domain
types (NFR5). Full detail: `docs/sdlc/security/e4-html-report-threat-model.md`.

**Why E4 matters — it is the ENFORCEMENT point of the T7 XSS handoff.** The crawled app controls its own
a11y labels/screen text; E2/E3 turn that into untrusted-origin strings (`appPurpose`,
`Workflow.name/description/featureGroup`, `WorkflowStep.description`, `StateNode.label`,
`StateEdge.actionPayload`). E7 stored them RAW/inert and punted encoding to E4. E4 is where output-encoding
is enforced or the system takes **stored XSS**. The artifact opens at **file://**, where script-exec = local
file read on the dev's machine → **XSS is HIGH here, not medium.** Carried from [[recurring-risks-e3-semantic-egress]]
(E3 T7) and [[recurring-risks-e7-persistence]] (E7 T7, store-raw contract).

**How to apply** — when gating any E4 ticket touching `packages/adapters/report-html/**` or the
`packages/application` render+persist use-case:

- **HIGH — XSS by encoding-by-construction (T1, A03/CWE-79).** All untrusted strings reach markup ONLY via
  ONE auditable context-aware escaping module (element-text ≠ attribute ≠ URL ≠ id/anchor ≠ CSS); attrs
  always quoted; NO untrusted value in any `<script>`/`on*`/CSS context; no ad-hoc concatenation. Requires a
  NAMED adversarial payload suite (script tag, attribute breakout `"><img onerror>`, event handler, `javascript:`
  URL, title/context breakout, unicode/entity + double-encoded, nested `<scr<script>ipt>`, CSS breakout) that
  asserts the PARSED output DOM is inert. Grep for single-boundary encoding (no stray template-literal splice).
- **HIGH — screenshotUri scheme ruling (T2, A03/CWE-79/829).** `StateNode.screenshotUri` → `<img src>`.
  Default (embedScreenshots:true) inlines as `data:image/<png|jpeg|webp>;base64` (raw URI NEVER emitted);
  reference mode emits only an in-root `file:`/relative path; else (javascript:, data:text/html, http(s):,
  blob:, out-of-root ../) → drop to no-image placeholder. Never in href / never an unvalidated URL.
- **HIGH — path traversal on write + screenshot read (T3, A01/CWE-22/73).** outputDir is config/caller-owned;
  filename is a sanitized/allowlisted token; write path realpath-contained in outputDir; screenshot read/copy
  realpath-contained in the store; NO runId/appId/stateId spliced into a path unsanitized (reuse E7 T2 language).
  SAST lever = `detect-non-literal-fs-filename`.
- **MEDIUM — anchor/id injection (T4, CWE-79).** #88 TOC/convergence links use deterministic charset-allowlisted
  derived tokens (`[A-Za-z0-9_-]`) for id=/href="#…" — never raw Workflow.id spliced into the attribute.
- **MEDIUM — no phone-home (T5, A05/CWE-829).** Self-contained: ZERO remote resource refs (http(s)/`//` in
  src/href/url()/@import), no analytics/beacon. SHOULD add a restrictive `<meta>` CSP (load-bearing once E5 serves it).
- **MEDIUM/LOW — DoS (T6, CWE-770).** Config-driven truncation/size caps coordinated with the designer
  (truncate THEN encode), or documented accepted-risk. Local single-user availability, proportionate.
- **MEDIUM — render-dep supply chain (T7, A06/CWE-1104/94).** Prefer encoding-by-construction over a template
  engine; any engine MUST be escape-by-default, exact-pinned, SCA clean (no High/Critical in `--prod`), no eval.
  Note: pulling a template engine into the PROD tree changes the accepted `--prod`-scoped SCA posture (handlebars
  crit is currently dev-only) — see [[mandated-scanning-policy]].
- **LOW/MEDIUM — artifactUri write-back (T8, #89, CWE-73).** Output root is config/composition-root-owned (never
  appId/runId-derived); persisted artifactUri is renderer-generated verbatim; flip ONLY artifactUri via the
  existing upsert, renderer failure leaves other Report fields intact; no adapter import in the application layer.

**Handoff to E5 (do not drop):** E5 will serve/embed this artifact — likely over http, possibly in an iframe.
Under an http origin an XSS regains full same-origin blast radius against the dashboard session, so E5 MUST serve
the report sandboxed (`<iframe sandbox>` / distinct origin + response-header CSP) and resolve `artifactUri`
without path traversal/arbitrary-file-read (treat stored artifactUri as untrusted on resolve). The E4 encoding
contract + `<meta>` CSP stay load-bearing. See [[scope-boundaries]].
