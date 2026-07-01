# Threat Model — E4: Grouped HTML workflow documentation report

- **Mode:** threat-model (design-time, per epic). **Epic:** #4 — grouped HTML report.
  Tickets: **#87** (E4.1 core grouped renderer, XSS-safe), **#88** (E4.2 hidden/duplicate-path
  visualization), **#89** (E4.3 render+persist use-case + `artifactUri` write-back).
- **Author agent:** security. **Date:** 2026-07-02. (Working-tree draft — do NOT commit; no code.)
- **Aligns with:** `PRD-e4-html-report.md` (NFR1 XSS-safe, NFR2 self-contained, NFR3 deterministic,
  NFR4 sparse-resilient, NFR5 layering), domain `ReportRendererPort`/`RenderOptions`/`RenderResult`,
  `WorkflowMap`/`Workflow`/`WorkflowStep`/`StateNode`/`StateEdge`/`DuplicatePathGroup`.
- **Builds on / inherits:** `docs/sdlc/security/e7-run-persistence-threat-model.md` (**T7**: every
  persisted `WorkflowMap` string + `StateNode.label` + a11y excerpt is untrusted-origin, stored **raw
  and inert**, and MUST be **context-encoded on render** — that enforcement is what E4 now owns) and its
  **T2** path-splicing language (no `appId`/`runId` in a filesystem path unsanitized); and
  `docs/sdlc/security/e3-semantic-workflow-mapping-threat-model.md` (**T7** origin: LLM-/app-inferred
  strings are attacker-influenceable documentation text). See [[recurring-risks-e7-persistence]],
  [[recurring-risks-e3-semantic-egress]], [[mandated-scanning-policy]], [[scope-boundaries]].
- **Standards applied:** OWASP Top 10 (2021) + ASVS v4 (L1/L2, named inline), CWE.

---

## Scope boundary — what E4 newly introduces

E4 turns the finalized in-memory/at-rest `WorkflowMap` (+ its `StateGraph` for evidence) into a
**self-contained static HTML file** written to `RenderOptions.outputDir` and **opened in the user's
browser, typically via `file://`**. Two facts define the whole threat surface:

1. **The content is attacker-influenceable.** The crawled app controls its own accessibility labels and
   on-screen text; the E2/E3 LLM turns that into `appPurpose`, `Workflow.name/description`,
   `featureGroup`, `WorkflowStep.description`, `StateNode.label`, `StateEdge.actionPayload`. Every one of
   these is **untrusted-origin** and is interpolated into HTML. This is the realisation point of the
   E3→E7→E4 T7 handoff: **E4 is where output-encoding is enforced or the system takes stored XSS.**
2. **The render context is `file://`.** In several browsers, script executing in a `file://` document
   can read other local files (and there is no same-origin server session to scope damage to). So an XSS
   in this artifact is **not** a cosmetic defect — it is local-file-read / arbitrary-script on the
   developer's machine. **XSS in E4 is HIGH, not medium.**

**What E4 is responsible for:** the `adapters/report-html` renderer (#87/#88, imports only domain types)
and the application render+persist use-case + composition-root wiring (#89).

**Explicitly out of scope (boundary notes, not E4 defects):**

- **Redaction of secrets/PII.** Enforced **upstream** in E2 (`CredentialRedactor` at TB-A); E4 receives
  an already-redacted graph/map and must **introduce no new pre-redaction source and never log/echo**
  raw content. E4 does not re-derive raw text. (Inherited E2/E3/E7 control — not re-litigated here.)
- **Persisting `Report`/`WorkflowMap` rows or graph data.** E7 owns that (#83/#84). E4 only writes the
  HTML file and flips the single `artifactUri` field via the existing upsert (#89).
- **Serving/embedding the artifact in the dashboard.** E5. E4 keeps the artifact **standalone**; the
  moment E5 serves it over `http(s)` the XSS blast radius changes — flagged to E5 below.
- **Interactive graph canvas, PDF, theming, i18n, live updates** — explicit PRD non-goals.
- **No PCI/payments or regulated domain** — internal developer/tester tooling. See [[scope-boundaries]].

---

## Assets

| #   | Asset                                                                                                                                                                                                | Why it matters                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | **Untrusted-origin display strings** — `WorkflowMap.appPurpose`, `Workflow.name`/`description`/`featureGroup`, `WorkflowStep.description`, `StateNode.label`, `StateEdge.actionType`/`actionPayload` | App-/LLM-controlled text interpolated into element/attribute/URL/anchor contexts → the primary XSS vector (CWE-79).                                             |
| A2  | **`StateNode.screenshotUri`** (`string \| null`)                                                                                                                                                     | Flows into `<img src>`. A hostile scheme (`javascript:`/`data:text/html`) or an out-of-root path is script-exec or arbitrary local-file read.                   |
| A3  | **`Workflow.id` / `DuplicatePathGroup.canonicalWorkflowId`/`hiddenWorkflowIds`/`workflowIds`**                                                                                                       | Become `id="…"` anchors and `href="#…"` in-page links (#88 TOC/convergence). Attribute-breakout / id-injection surface.                                         |
| A4  | **The rendered HTML artifact file + `outputDir`**                                                                                                                                                    | A file E4 **writes**. `outputDir` + a filename derived from `runId` (untrusted-origin, E7) → path-traversal on write; screenshot read/copy → traversal on read. |
| A5  | **The user's browser + local filesystem at `file://`**                                                                                                                                               | Any script execution in the artifact = local-file read / arbitrary script on the dev machine. The thing XSS actually compromises.                               |
| A6  | **`ReportMetadata.artifactUri` written to the run DB (#89)**                                                                                                                                         | A string E5 will later resolve/render. Must be renderer-generated (not user-path), inert, and stored raw (E7 contract).                                         |
| A7  | **Any templating / HTML-building dependency the renderer adds**                                                                                                                                      | Executes at build/render time; a vulnerable/auto-executing template engine is a supply-chain + injection vector (A06).                                          |

## Trust boundary

```
 [Finalized WorkflowMap + StateGraph + Report — untrusted-origin strings, ALREADY redacted upstream (E2)]
        │  appPurpose · name/description/featureGroup · step.description · StateNode.label ·
        │  actionPayload · screenshotUri · workflow ids   (A1/A2/A3)
        ▼
 ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 │  packages/adapters/report-html — ReportRendererPort.render()  (#87 core, #88 differentiator)│
 │                                                                                            │
 │   TB-ENC (the ONE auditable encoding boundary):                                            │
 │     every untrusted value reaches markup ONLY via the escaping module —                    │
 │       · element text   → HTML-entity encode            (T1)                                │
 │       · attribute value→ attribute encode + always-quoted                                  │
 │       · <img src>      → SCHEME ALLOWLIST + inline/containment  (T2)                        │
 │       · id / href="#…" → charset-allowlisted derived token       (T4)                       │
 │       · CSS / <script> → NO untrusted interpolation (code-owned only)                       │
 │   TB-FS (artifact write): outputDir is config-owned; runId/stateId NEVER spliced            │
 │     into a path unsanitized; screenshot read/copy resolved INSIDE the store    (T3)         │
 │   TB-NET (self-contained): NO external asset (CDN/font/analytics/script src)    (T5)         │
 │                                   │  single HTML file, embedScreenshots→data: inline         │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
        │  RenderResult{ artifactUri, generatedAt, sizeBytes }
        ▼
 Application render+persist use-case (#89, ports-only) → ReportRepository.save (flip artifactUri only)
        │
        ▼
 Opened at file:// by dev/tester  ·····▶  (later) served/embedded by E5 dashboard  [HANDOFF: sandbox + CSP]
```

---

## Threats (STRIDE / OWASP / CWE) and mitigations

Each threat: **class · standard/CWE · testable mitigation (MUST/SHOULD) · owning ticket(s) · gate check.**

### T1 — XSS via untrusted-origin string interpolation across every HTML context (HIGH)

- **Class:** Injection. **OWASP A03 (XSS) · CWE-79, CWE-116 (Improper Encoding).** (Realisation of
  E3/E7 **T7**.) HIGH because the `file://` render context (A5) turns script-exec into local-file read.
- **Threat:** any A1 string carrying markup — `<script>alert(1)</script>`, `"><img src=x
onerror=alert(1)>`, `" onmouseover="alert(1)`, `</title><script>…`, `javascript:` text, unicode/entity
  or nested/double-encoded variants — is interpolated verbatim into element text, an attribute value, a
  URL attribute, a CSS value, an anchor id/href, or a `<script>` block, and executes.
- **Mitigation (testable):**
  1. **(MUST, #87) Encoding-by-construction at ONE auditable boundary.** All untrusted values reach
     markup **only** through a single escaping module (e.g. `escapeHtml` / `escapeAttr` / `safeSrc` /
     `safeAnchor`) or an **auto-escaping-by-default** template mechanism — **no ad-hoc string
     concatenation** of A1 data into markup anywhere else. The escaper is **context-aware**: element
     text ≠ attribute value ≠ URL attribute ≠ id/anchor ≠ CSS (ASVS 5.3). Attributes are **always
     quoted**. **No untrusted string is ever placed in a `<script>` block, an inline `on*` handler, or a
     CSS/`style` value** — those contexts carry code-owned content only.
  2. **(MUST, #87) Named adversarial payload test-suite.** A dedicated test feeds each A1 field the
     canonical payload set — `<script>` tag; attribute-breakout (`"><img onerror>`); event-handler
     injection (`" onmouseover=`); `javascript:` URL; title/context-breakout (`</title><…`);
     unicode/entity + double-encoded (`&lt;script&gt;`, `<script>`, `%253Cscript%253E`);
     nested (`<scr<script>ipt>`); CSS-breakout (`</style><script>`) — and asserts the **parsed output
     DOM** contains **zero** injected `<script>`/`<svg onload>`, **zero** `on*` handler attributes from
     input, and no attribute/URL/anchor breakout. Inert visible text is the only acceptable outcome.
  3. **(MUST, #88) The added hidden-badge / convergence-callout markup keeps T1 holding** — workflow
     names surfaced in callouts/links route through the same boundary; no new raw-interpolation site.
- **Owning tickets:** #87 (baseline + boundary + suite), #88 (added markup). **Gate check:** the
  adversarial suite exists and passes; grep confirms A1 fields reach markup **only** via the escaping
  module (single boundary — no stray template-literal interpolation of untrusted data); confirm no
  untrusted value in any `<script>`/`on*`/CSS context.

### T2 — `screenshotUri` scheme / URL injection into `<img src>` (HIGH)

- **Class:** Injection / SSRF-adjacent + local-file read. **OWASP A03/A10 · CWE-79, CWE-601 (Open
  Redirect / URL handling), CWE-829 (Inclusion of Untrusted Functionality).**
- **Threat:** `StateNode.screenshotUri` (A2) is emitted into `<img src>`. If it is `javascript:…`,
  `data:text/html,…`, an `http(s)://` URL (phone-home, T5), or a `file:`/relative path pointing
  **outside** FlowScout's own artifact store, the report executes script, phones home, or reads an
  arbitrary local file into the page.
- **screenshotUri scheme ruling (MUST, #87):**
  - **Default / self-contained (`embedScreenshots: true`, the PRD default):** E4 **reads the referenced
    screenshot from FlowScout's own screenshot/output store and inlines it as
    `data:image/<type>;base64,…`**, where `<type>` is a member of a **fixed image MIME allowlist**
    (`image/png`, `image/jpeg`, `image/webp`) — the raw `screenshotUri` string is **never** emitted into
    the attribute. The file is resolved **inside** the store first (T3 containment) before read.
  - **Reference mode (`embedScreenshots: false`):** emit `src` **only** for a `screenshotUri` that
    validates as a `file:`/relative path whose `realpath` resolves **inside** the configured screenshot/
    output root (T3). **Reject** `javascript:`, `data:` (other than E4's own generated image data URIs),
    `http:`/`https:`, `blob:`, and any path escaping the root.
  - **Anything not in the allowlist → drop the image and render the graceful no-image placeholder** (the
    NFR4 "no broken image" path). `screenshotUri` is **never** interpolated into `href` or any non-`src`
    context, and never into a URL without passing this allowlist.
- **Owning tickets:** #87. **Gate check:** a test drives hostile `screenshotUri` values (`javascript:`,
  `data:text/html`, `https://evil`, `../../../../etc/passwd`) and asserts the emitted `src` is either an
  allowlisted `data:image/*` (embed) / in-root `file:` (reference) or the image is dropped — never the
  hostile value; confirm the default path embeds and emits no raw URI.

### T3 — Path traversal writing the HTML artifact + reading/copying screenshots (HIGH)

- **Class:** Path Traversal. **OWASP A01/A05 · CWE-22, CWE-73 (External Control of File Name/Path).**
  (Reuses E7 **T2** language: no `appId`/`runId` spliced into a filesystem path unsanitized.)
- **Threat:** the renderer writes the HTML to `outputDir` and — in reference mode — reads/copies
  screenshots. The HTML filename may be derived from `runId` (untrusted-origin, app-name/build-derived
  per E7); a screenshot path comes from `screenshotUri` (A2). A crafted `runId`/`stateId`/`screenshotUri`
  containing `../` or an absolute path escapes `outputDir`/the store → arbitrary file **write** (overwrite
  outside the output dir) or arbitrary local-file **read** inlined into the report.
- **Mitigation (testable):**
  1. **(MUST, #87) `outputDir` is config-/caller-owned**, not composed from untrusted strings. The
     artifact filename is either a **charset-allowlisted derived token** (`[A-Za-z0-9_-]`) or a
     sanitized `runId`; the final write path's `realpath` MUST resolve **inside** `outputDir`. **No
     `appId`/`runId`/`stateId` spliced into a path unsanitized** (E7 T2).
  2. **(MUST, #87) Screenshot read/copy is store-contained** — every `screenshotUri`-derived path is
     `realpath`-resolved and asserted **inside** the configured screenshot/output root before any
     read/copy; out-of-root → drop (T2 placeholder). No `path.join(root, untrusted)` without containment.
  3. **(MUST, #87) Atomic-ish failure (NFR4/edge case):** an unwritable/missing `outputDir` rejects with
     a clear typed error and leaves **no partial artifact** behind.
- **Owning tickets:** #87 (render write + screenshot read), #89 (confirms the use-case passes a
  config-owned `outputDir`, never a user-influenced one). **Gate check:** a `../`-laden `runId`/
  `screenshotUri` test stays within `outputDir`/the store (no escape, no arbitrary read/write); grep the
  renderer for non-literal fs paths that concatenate untrusted input without a containment check
  (`eslint-plugin-security` `detect-non-literal-fs-filename` is the SAST lever — see
  [[mandated-scanning-policy]]).

### T4 — Anchor / id / fragment-href injection from workflow ids & names (MEDIUM)

- **Class:** Injection (XSS sub-context). **OWASP A03 · CWE-79, CWE-116.**
- **Threat:** #88's TOC/convergence links generate `id="wf-<Workflow.id>"` and `href="#wf-<id>"`, and
  callouts surface workflow **names** as link text. An `id`/name carrying `"><svg onload=…>` or a quote
  breaks out of the `id=`/`href=` attribute; even fragment `href` values can break the attribute if
  unquoted/unencoded.
- **Mitigation (testable):**
  1. **(MUST, #88) Anchor tokens are derived + charset-allowlisted.** The `id`/fragment target is a
     deterministic token restricted to `[A-Za-z0-9_-]` (slug or hash of the workflow id, stable order),
     **not** the raw id spliced into the attribute. Link **text** (workflow name) routes through the T1
     element-text/attribute escaper. Attributes are always quoted.
  2. **(MUST, #88) Deterministic + collision-safe** — same inputs produce the same anchor set (NFR3);
     no crash on absent/empty `duplicateGroups`.
- **Owning tickets:** #88 (and #87's TOC baseline). **Gate check:** the adversarial suite includes an
  `id`/name payload (`#"><svg onload=…>`) and asserts no attribute breakout in generated anchors; confirm
  anchor targets are allowlisted derived tokens, not raw ids.

### T5 — External resource load / report phones home when opened (MEDIUM)

- **Class:** Misconfiguration / privacy. **OWASP A05 · CWE-829 (Inclusion of Functionality from
  Untrusted/Remote Source), CWE-1021.**
- **Threat:** a report that pulls a CDN font/CSS/JS, an analytics beacon, or an external image makes the
  dev's browser **call out** when the artifact is opened — a privacy leak (which apps were explored, when)
  and an integrity/availability dependency on a third party. NFR2 mandates self-contained.
- **Mitigation (testable):**
  1. **(MUST, #87) Self-contained or nothing.** All CSS/fonts/JS (if any) are **inlined and code-owned**;
     `embedScreenshots: true` inlines images as `data:` (T2). **No `<script src>`, `<link href>` to a
     remote origin, `@import`, remote `@font-face`, or analytics/beacon** — zero `http:`/`https:`/
     protocol-relative `//` resource references in the output.
  2. **(SHOULD, #87) Restrictive `<meta http-equiv="Content-Security-Policy">`** as defense-in-depth
     (e.g. `default-src 'none'; img-src data:; style-src 'unsafe-inline'`, no `script-src`). Note: a
     `meta` CSP is only partially honoured under `file://`, but it becomes load-bearing once E5 serves
     the artifact over `http` — so ship it now.
- **Owning tickets:** #87. **Gate check:** scan the rendered artifact for any remote resource reference
  (`http://`/`https://`/`//` in `src`/`href`/`url(...)`/`@import`) — must be none; open the file offline
  and confirm no network request.

### T6 — DoS / resource exhaustion: enormous maps, labels, base64 blowup (MEDIUM/LOW)

- **Class:** Denial of Service (local resource). **OWASP A04 · CWE-400, CWE-770 (Missing Limit on
  Resource Consumption).** Proportionate: **local single-user** availability, not exfil.
- **Threat:** a pathological crawl (thousands of workflows/steps, multi-MB a11y-derived labels) or many
  large inlined screenshots (`data:` base64 ≈ +33%) yields a single HTML file large enough to hang the
  renderer or wedge the browser tab; an unbounded label also worsens layout DoS.
- **Mitigation (testable):**
  1. **(SHOULD, #87) Config-driven truncation caps** on per-string display length and, where relevant,
     on rendered node/step counts — **coordinated with the designer's truncation rules** (OQ1/UX), no
     magic numbers; truncation preserves T1 encoding (truncate **then** encode, never mid-entity). A
     "…(truncated)" affordance is fine.
  2. **(SHOULD, #87) Bounded screenshot embedding** — a per-image / total-artifact size guard (or a
     documented accepted-risk tied to expected crawl size), degrading to reference/placeholder rather
     than producing an unusable multi-hundred-MB file.
- **Owning tickets:** #87 (coordinate designer). **Gate check:** confirm either config-bounded
  truncation/size guards or a documented accepted-risk; a large-map test renders a valid, bounded
  document without crashing; truncation happens before encoding.

### T7 — Templating / HTML-rendering supply chain (MEDIUM)

- **Class:** Tampering / supply chain. **OWASP A06 · CWE-1104 (Unmaintained/Untrusted Component),
  CWE-94 (Code Injection via template engine).**
- **Threat:** if #87 pulls in a template engine (A7) to build the HTML, an unpinned/vulnerable one is a
  build-time RCE/injection vector, and an engine that is **not escape-by-default** (or that supports
  raw/unescaped interpolation helpers) invites a T1 regression. Note the existing SCA posture: a
  critical `handlebars` advisory already exists **but only in the dev/build tree** via
  `eslint-plugin-boundaries` (accepted, `--prod`-scoped) — pulling a template engine into the **prod**
  dependency path would change that calculus. See [[mandated-scanning-policy]].
- **Mitigation (testable):**
  1. **(MUST, #87) Prefer encoding-by-construction** (the T1 single-boundary escaper / a minimal
     hand-rolled builder) over a heavyweight engine. **If** an engine is introduced it MUST be
     **escape-by-default**, used **without** raw/triple-`{{{`}}`-style unescaped interpolation of A1
data, **exact-pinned** (no `^`/`~`), lockfile integrity committed, and **SCA clean with no
High/Critical in the `--prod` path\*\*.
  2. **(MUST, #87) No `eval`/`new Function`** in the render path (SAST `detect-eval-with-expression`).
- **Owning tickets:** #87. **Gate check:** SCA clean (no High/Critical in `--prod`); any added render
  dep is exact-pinned with lockfile integrity; grep confirms no unescaped-interpolation helper is used on
  untrusted data and no `eval` in the render path.

### T8 — `artifactUri` write-back path & persistence integrity (LOW/MEDIUM)

- **Class:** Improper Input / integrity. **OWASP A01/A08 · CWE-73, CWE-116.**
- **Threat:** #89 writes `RenderResult.artifactUri` back onto the run's `Report` via
  `ReportRepository.save`. Two concerns: (a) the value must point at the **renderer's config-owned output
  root**, never a user-controlled path; (b) `artifactUri` is a string **E5 will later resolve and render**
  — it must be stored **raw/inert** (E7's store-raw contract) and treated as untrusted on the E5 render
  side.
- **Mitigation (testable):**
  1. **(MUST, #89) No user-controlled path in `artifactUri`.** The output root comes from config/the
     composition root; the use-case passes that `outputDir` to the renderer (never `appId`/`runId`
     spliced in — T3). The persisted `artifactUri` is the renderer-generated URI verbatim.
  2. **(MUST, #89) Additive, non-corrupting persistence.** Per ADR-0008 OQ3, flip **only** `artifactUri`
     via the existing upsert-by-`runId`; a renderer failure surfaces as a run-level outcome and leaves
     all other `Report` fields (counts, WorkflowMap, metadata) **unchanged** — no partial/corrupt write
     (mirrors E7 T7 store-raw + FR8 resilience).
  3. **(MUST, #89) Layering (NFR5)** — the use-case imports only domain + application collaborators; the
     renderer is injected via `ReportRendererPort` (no adapter/SDK import outside the composition root).
- **Owning tickets:** #89. **Gate check:** confirm `outputDir`/output root is config-owned (no untrusted
  splice); a renderer-failure test leaves `artifactUri` and other `Report` fields intact; grep confirms
  no adapter import in the application-layer use-case.

---

## Severity summary

| Threat | Title                                                     | Severity   | Primary ref               |
| ------ | --------------------------------------------------------- | ---------- | ------------------------- |
| T1     | XSS via untrusted string interpolation (all contexts)     | HIGH       | A03 XSS / CWE-79          |
| T2     | `screenshotUri` scheme/URL injection into `<img src>`     | HIGH       | A03/A10 / CWE-79, CWE-829 |
| T3     | Path traversal writing HTML + reading/copying screenshots | HIGH       | A01/A05 / CWE-22, CWE-73  |
| T4     | Anchor/id/fragment-href injection from workflow ids/names | MEDIUM     | A03 / CWE-79              |
| T5     | External resource load / report phones home               | MEDIUM     | A05 / CWE-829             |
| T6     | DoS / resource exhaustion (huge maps, base64 blowup)      | MEDIUM/LOW | A04 / CWE-770             |
| T7     | Templating / HTML-render supply chain                     | MEDIUM     | A06 / CWE-1104, CWE-94    |
| T8     | `artifactUri` write-back path & persistence integrity     | LOW/MEDIUM | A01/A08 / CWE-73          |

---

## Per-ticket MUST controls (the security gate enforces these)

### #87 — E4.1: Core grouped HTML report renderer (`packages/adapters/report-html`)

- **M87.1 (T1)** Encoding-by-construction at **ONE auditable boundary**: every untrusted string
  (`appPurpose`, `Workflow.name`/`description`/`featureGroup`, `WorkflowStep.description`,
  `StateNode.label`, `StateEdge.actionType`/`actionPayload`) reaches markup **only** via the
  context-aware escaping module; attributes always quoted; **no untrusted value in any `<script>`/`on*`/
  CSS context**; no ad-hoc concatenation of untrusted data into markup.
- **M87.2 (T1)** A **named adversarial payload test-suite** (script tag · attribute breakout · event
  handler · `javascript:` URL · title/context breakout · unicode/entity + double-encoded · nested ·
  CSS breakout) proves each field renders **inert** (parsed DOM has zero injected script/handlers).
- **M87.3 (T2)** **`screenshotUri` scheme allowlist ruling** enforced: default embeds as
  `data:image/<allowlisted>;base64` (raw URI never emitted); reference mode emits only an in-root
  `file:`/relative path; all else → drop to placeholder. Never in `href` or unvalidated URL.
- **M87.4 (T3)** `outputDir` is caller/config-owned; artifact filename is a sanitized/allowlisted token;
  final write path `realpath`-contained in `outputDir`; screenshot read/copy `realpath`-contained in the
  store; **no `runId`/`appId`/`stateId` spliced into a path unsanitized**; unwritable dir → clean error,
  **no partial artifact**.
- **M87.5 (T5)** Self-contained: **zero** remote resource references (`http:`/`https:`/`//` in
  `src`/`href`/`url()`/`@import`); no analytics/beacon. **SHOULD** add a restrictive `<meta>` CSP.
- **M87.6 (T6)** Config-driven truncation/size caps coordinated with the designer (truncate **then**
  encode), or a documented accepted-risk; a large map renders bounded and valid.
- **M87.7 (T7)** Prefer encoding-by-construction; any render dep is **escape-by-default**, exact-pinned,
  lockfile-integrity-committed, **SCA clean (no High/Critical in `--prod`)**; **no `eval`** in render.

### #88 — E4.2: Hidden/duplicate-path visualization

- **M88.1 (T1)** The added hidden-badge + convergence-callout markup keeps T1 holding — workflow names in
  callouts/links route through the M87.1 boundary; no new raw-interpolation site (adversarial suite
  extended to the callout markup).
- **M88.2 (T4)** In-page anchors use **deterministic charset-allowlisted derived tokens**
  (`[A-Za-z0-9_-]`) for `id=`/`href="#…"` — never the raw `Workflow.id` spliced into the attribute; link
  text encoded; attributes quoted; stable/deterministic order; no crash on absent/empty `duplicateGroups`.

### #89 — E4.3: Render+persist use-case + `artifactUri` write-back (`packages/application` + composition root)

- **M89.1 (T8/T3)** The `outputDir`/output root passed to the renderer is **config-/composition-root-
  owned** — never `appId`/`runId`-derived; the persisted `artifactUri` is the renderer's URI verbatim.
- **M89.2 (T8)** Additive persistence: flip **only** `artifactUri` via the existing upsert-by-`runId`; a
  renderer failure is surfaced as a run-level outcome and leaves all other `Report` fields unchanged (no
  partial/corrupt write; report-row-missing handled cleanly).
- **M89.3 (NFR5)** The use-case imports only domain + application collaborators; the renderer is injected
  via `ReportRendererPort` (no adapter/SDK import outside the composition root).

---

## Cross-epic handoffs (do not drop)

- **← E3/E7 (received):** the E3→E7→E4 **T7** handoff lands here — all `WorkflowMap` strings +
  `StateNode.label` + a11y excerpts are untrusted-origin, stored raw/inert, and **E4's render is the
  enforcement point** for context-encoding. This model discharges that obligation via T1–T4.
- **→ E5 (dashboard) — flag:** the moment E5 **serves/embeds** this artifact over `http(s)` (iframe or a
  route), an XSS regains full same-origin blast radius against the dashboard session — so **E5 MUST serve
  the report sandboxed** (`<iframe sandbox>` / a distinct origin) and/or enforce a real response-header
  CSP, and **MUST resolve `artifactUri` without path traversal / arbitrary-file-read** (treat the stored
  `artifactUri` as untrusted on resolve, contain to the output root). E4's `<meta>` CSP (M87.5 SHOULD)
  and the encoding contract remain load-bearing under E5. The E4 artifact itself stays standalone
  (PRD non-goal: E4 does no dashboard wiring).
- **→ E6 (vault):** unchanged — raw credentials never reach the map/report; redaction stays upstream (E2).

---

## Verdict policy for the E4 security gate (per ticket, post-implementation)

- **Critical / High → FAIL** (block, route to developer). The HIGH controls are **T1 (encoding-by-
  construction + adversarial suite pass)**, **T2 (`screenshotUri` scheme allowlist)**, **T3 (path-
  traversal containment on write + screenshot read)** — any A1 payload that executes in the rendered DOM,
  a hostile `screenshotUri` scheme reaching `<img src>`, or a `../` escaping `outputDir`/the store is a
  **FAIL**.
- **Medium → must fix, or open a tracked follow-up and PASS-with-conditions** (never silently dropped) —
  T4 anchor/id injection, T5 self-contained/no-phone-home, T6 truncation/size bound, T7 render-dep SCA/
  pin, T8 write-back path/persistence integrity.
- **Low → note** in the verdict (the LOW slice of T6/T8 — covered by functional NFR ACs).
- **Required scans did not run (gitleaks / SCA / SAST results absent) → BLOCKED** — do not PASS an
  unscanned diff. Mind CI scan ordering: an early Lint/Format failure can abort the job before
  gitleaks/SAST run → diff unscanned → BLOCKED (see [[recurring-risks-ci-scan-ordering]]).
