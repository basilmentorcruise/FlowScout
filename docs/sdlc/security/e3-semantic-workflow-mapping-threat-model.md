# Threat Model — E3: Semantic understanding & workflow mapping

- **Mode:** threat-model (design-time, per epic)
- **Epic:** #3 — Semantic understanding & workflow mapping (purpose + duplicate-path detection).
  Tickets: #53 (ADR spike), #54 (E3.1 extraction), #55 (E3.2 intent), #56 (E3.3 naming/grouping),
  #57 (E3.4 identity refinement), #58 (E3.5 duplicate detection), #59 (E3.6 capstone).
- **Author agent:** security. **Date:** 2026-06-26.
- **Aligns with:** PRD-e3-semantic-workflow-mapping (NFR1 boundaries, NFR5 secret hygiene, NFR6
  graceful degradation), ADR-0001 (R1 identity, R3 budgeted LLM path), ADR-0004 §2.3/§3 (E3 merge
  threshold + budget reuse). **Builds on and inherits:**
  `docs/sdlc/security/e2-crawl-engine-threat-model.md` (the LLM trust boundary, redaction boundary,
  output-validation chokepoint, cost-DoS controls) and `docs/sdlc/security/e1-mobile-mcp-foundation-threat-model.md`.
- **Standards applied:** OWASP Top 10 (2021), OWASP ASVS v4 (L1/L2 named inline), CWE, and
  **OWASP Top 10 for LLM Applications (2025)** — `LLM01` Prompt Injection, `LLM02` Sensitive
  Information Disclosure, `LLM05` Improper Output Handling, `LLM06` Excessive Agency, `LLM10`
  Unbounded Consumption.

---

## Scope boundary — what E3 newly introduces

E3 is **post-crawl, offline analysis**. It consumes the **finalized `StateGraph`** E2 produced and
turns it into a `WorkflowMap` (the E4/E8 consumer contract). It lives in `packages/application` +
`packages/domain`, wired at `packages/api`. **E3 does not drive the simulator and does not extend the
crawl loop** — so E2's `LLM06` Excessive-Agency / destructive-action surface (the LLM choosing taps on
real data) is **out of scope here**. The LLM in E3 produces **documentation text** (intent labels,
workflow names, app purpose), not actions.

What E3 **does** newly introduce, and what this model is about:

1. **A second class of data egress to the LLM/embedding provider.** E2 sent a11y/screen content to the
   LLM to _decide an action_. E3 sends the **same kind of content** (a11y trees, labels, optionally
   screenshots for vision) for **semantic inference and embeddings** — and, for #57/#58, possibly a
   **new embedding provider** (a second outbound network sink). This is the primary new surface.
2. **A new persisted artifact bound for the report.** The `WorkflowMap` (names, descriptions, intent
   strings, app purpose, feature groups) is the **E4 HTML-report data contract**. Any unredacted PII /
   credential / real-account string that lands in an inferred label flows downstream into a
   human-facing rendered report — a new exfil path E2 did not have.
3. **Untrusted app content reaching the LLM as prompt input**, now in an inference (not action) role —
   a prompt-injection vector with a **different, lower blast radius** (it can corrupt FlowScout's own
   documentation output; it cannot drive a privileged system).

**Explicitly out of scope (boundary notes, not E3 defects):**

- **The action-driving LLM path / destructive autonomy (`LLM06`)** — that is E2's loop; E3's LLM only
  emits text. Inherited, not re-litigated here. See [[recurring-risks-llm-boundary]].
- **HTML report rendering / output-encoding in the report** — E4. E3's obligation is that the _data_
  it hands E4 is already redacted; **E4 owns the output-encoding (XSS) of inferred strings into HTML.**
  Flagged below as a cross-epic handoff (T7) so it is not silently dropped between E3 and E4.
- **Durable persistence of the `WorkflowMap` + the inference cache** — E7. E3 binds to ports and ships
  in-memory impls; its obligation is that what it _writes_ is already clean.
- **The encrypted credential vault + 2FA** — E6. E3 sees only the **already-redacted** a11y snapshots
  E2 recorded into the graph; it must not _de-redact_ and must not introduce a new raw-secret sink.
- **No PCI/payments or regulated domain** — internal developer/tester tooling. See [[scope-boundaries]].

---

## Assets

| #   | Asset                                                             | Why it matters                                                                                                                                                         |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | **a11y-tree / label text from graph `StateNode`s**                | The primary inference input. May carry test-account PII and typed text. Flows into prompts, embeddings, the intent model, and the `WorkflowMap`. Biggest exfil source. |
| A2  | **Screenshots (if vision/embedding uses them)**                   | Same exposure in pixels. May be sent to a multimodal LLM or an embedding model (OQ4). In-scope only if the ADR (#53) admits vision for MVP.                            |
| A3  | **The LLM provider + `LLM_API_KEY`** (reused from E2)             | The existing outbound boundary, now used for semantic inference. Key must never reach logs/cache/`WorkflowMap`/errors.                                                 |
| A4  | **The embedding provider + its API key (NEW, #53/#57)**           | A potential **second external network sink + second secret** if the ADR adds an embedding port/adapter. Same key-hygiene + supply-chain rules as A3.                   |
| A5  | **LLM/embedding output** (intent, name, purpose, group, vectors)  | Untrusted text that becomes report-bound content. Must be schema-validated; never `eval`'d; never widens behavior. Lower blast radius than E2's action output.         |
| A6  | **The `WorkflowMap` (report-bound, feeds E4 + E8)**               | The consumer contract. Whatever PII/secret lands in an inferred string propagates into the rendered HTML report and test plans. Must be clean at the E3 boundary.      |
| A7  | **The semantic inference cache** (DecisionCache-pattern, #55/#56) | A new persisted-ish sink keyed by state. If prompts/results embed raw a11y/screen text, the cache becomes a secondary PII store (and E7 may persist it).               |
| A8  | **Cost/budget telemetry (`CrawlBudget` counters)**                | E3 adds _new_ LLM/embedding call sites. Per-screen/per-control/per-workflow inference can fan out; uncapped it is a runaway-spend (`LLM10`) amplifier over E2.         |
| A9  | **Embedding SDK + transitive deps (NEW, if added)**               | New code with network + secret access on the host. Vulnerable/typosquatted version = RCE/exfil (OWASP A06).                                                            |

## Trust boundaries

```
        [Finalized StateGraph from StateGraphRepository port  — already-redacted a11y, A1/A2]
                                   │
                                   ▼
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │  packages/application — semantic engine (port-only, NFR1)                          │
 │   extract (#54, rule-only, NO egress) → intent (#55) → name/group (#56)            │
 │                                        → identity-refine (#57) → sameness (#58)     │
 │                                                                                    │
 │   ┌─ TB-RED (redaction boundary, reused E2 CredentialRedactor): a11y/label text   │
 │   │  MUST be redacted before ANY prompt / embedding input / stored intent / map    │
 │   ▼                                                                                │
 │   TB-LLM ── redacted prompt (a11y/label/screenshot) ──► LlmPort ──► LLM provider ──┼─► 3rd-party net (A3)
 │   ▲          ◄── completion (intent/name/purpose/group) ───────────────────────────┤    LLM_API_KEY
 │   │  TB-OUT (output validation): parse completion vs strict schema BEFORE it        │
 │   │          enters the intent model / WorkflowMap; no eval; bounded/typed          │
 │   │                                                                                 │
 │   ▼  TB-EMB (NEW, #57) ── redacted text/screenshot ──► EmbeddingPort ──► provider ──┼─► 3rd-party net (A4)
 │                                                       (vectors back; key isolated)  │
 └──────────────────────────────────────┬─────────────────────────────────────────────┘
                                         ▼
                          WorkflowMap (A6) ──► E4 HTML report (output-encodes) + E8 test plans
```

- **TB-RED (redaction boundary):** the **single chokepoint** every a11y/label string must pass before
  it reaches a prompt, an embedding input, a cached result, the intent model, or the `WorkflowMap`.
  Reuses E2's `CredentialRedactor` (`packages/application/src/crawl/redaction/CredentialRedactor.ts`).
  E3 must not invent a second, looser redaction path and must not consume _pre-redaction_ graph data.
- **TB-LLM / TB-EMB (caller → provider):** outbound payload is a **data-minimization** problem (send
  the minimal redacted representation, label-first, screenshots only if the ADR admits them); inbound
  completion/vector is **untrusted input**. App-screen content in the prompt is also an **injection
  vector** (`LLM01`) — but in an inference (text-output) role.
- **TB-OUT (output → model/map):** the completion is parsed/validated against a **strict schema**
  (typed intent / name / group / `ConfidenceScore`) **before** it enters the intent model or
  `WorkflowMap`. **No `eval`/`new Function` on LLM output.** Invalid → degraded rule-based fallback
  (NFR6), never a torn map.

---

## Threats (STRIDE / OWASP / OWASP-LLM) and mitigations

Each threat lists **class · standard ref/CWE · the testable mitigation · the owning ticket(s) · how
the per-ticket security gate verifies it.**

### T1 — On-screen PII / credentials / real-account data leaked into LLM or embedding prompts (HIGH)

- **Class:** Information Disclosure. **OWASP A02 Cryptographic/Sensitive-Data Exposure · LLM02
  Sensitive Information Disclosure · CWE-200, CWE-201, CWE-359.**
- **Threat:** E3 sends a11y/label text (A1) and possibly screenshots (A2) to the LLM (A3) for intent
  (#55), naming/grouping/purpose (#56), and to the embedding provider (A4) for identity refinement
  (#57). The graph's a11y snapshots can carry test-account PII, tokens rendered in the UI, and text the
  E2 engine typed (incl. credential material at a login/2FA screen). Sent raw, that data leaves the
  host to a third party — the **primary new egress** E3 introduces.
- **Mitigation (testable):**
  1. **Mandatory redaction at TB-RED before egress.** Every a11y/label string passes through the E2
     `CredentialRedactor` (or the same redaction contract) **before** it is placed in any LLM prompt or
     embedding input. The redactor is the single chokepoint; no inference path may read pre-redaction
     graph text. Unit-tested: a fixture node containing a seeded secret/PII produces a prompt/embedding
     input in which it is masked.
  2. **Data minimization (LLM02 / ASVS V8).** Send the **minimal redacted representation** — label /
     role / structure first; **screenshots only if the #53 ADR admits vision for MVP** (OQ4), and if so
     still subject to redaction posture (no screenshot of a credential screen sent).
  3. **Consume already-redacted graph data only.** E3 reads the finalized graph E2 already redacted at
     E2's TB-A; E3 must not de-redact or re-derive text from a pre-redaction source.
- **Owning tickets:** #55, #56, #57 (and #58 where it reads intent). **Gate check:** grep the prompt/
  embedding-input builders for a redaction call on the boundary; assert the seeded-secret fixture test
  exists and passes; confirm no inference path reads raw a11y bytes bypassing the redactor.

### T2 — Unredacted sensitive data persisted into the report-bound `WorkflowMap` / intent model / cache (HIGH)

- **Class:** Information Disclosure. **OWASP A02 · A09 (logging/data sinks) · LLM02 · CWE-200,
  CWE-212 (Improper Removal of Sensitive Information Before Storage/Transfer).**
- **Threat:** Even if a prompt is redacted, an **inferred** `name`/`description`/intent string, or a
  cached inference result (A7), can echo on-screen sensitive content (the LLM summarizing "Account for
  jane.doe@real.com balance $4,210" into a workflow name). That string lands in the `WorkflowMap` (A6)
  and flows downstream into the **E4 HTML report and E8 test plans** — a new exfil path. NFR5 requires
  _no_ credential/OTP/typed-secret/PII in the map, intent strings, caches, or logs.
- **Mitigation (testable):**
  1. **Redaction applies to inputs AND is verified on outputs.** Because TB-RED redacts inputs, the LLM
     should not _see_ the secret to echo it; but the intent model + `WorkflowMap` assembly (#59) must
     **assert no redaction marker / known-secret pattern survives** into stored strings (a
     defense-in-depth output check, not only an input check).
  2. **Cache stores redacted-derived data only.** The semantic cache (A7) is keyed and valued from
     already-redacted inputs; the cache key must not embed raw secret text (and must remain E7-persistable).
  3. **Confidence/degradation never re-introduces raw text.** A degraded fallback (NFR6) uses
     role/position, not raw a11y dumps.
- **Owning tickets:** #55, #56, #59 (assembly/finalization is the last clean-gate). **Gate check:** the
  capstone integration test (#59) asserts the finalized `WorkflowMap` from a secret-seeded fixture
  contains no secret/PII pattern; gitleaks + redaction stay green; confirm cache values are redaction-derived.

### T3 — Runaway LLM/embedding spend / cost-DoS from per-screen/per-control/per-workflow fan-out (HIGH)

- **Class:** Denial of Service (resource). **LLM10 Unbounded Consumption · OWASP A04 (Insecure Design,
  rate/cost) · CWE-770 (Allocation Without Limits), CWE-400.**
- **Threat:** E3 adds **new call sites** that fan out per screen, per control, per workflow, and (for
  embeddings) per node. A large crawl, a cyclic/explosive graph, or a coincidentally large app can
  drive many inference/embedding calls — runaway third-party spend (A8). This is an _amplification_ of
  E2's `LLM10` because E3 multiplies call sites.
- **Mitigation (testable):**
  1. **Reuse the E2 budgeted/abortable path — no new uncontrolled path (FR6/OQ2).** Every E3 LLM call
     goes through the existing `LlmPort` (real impl confined to `adapters/llm`), is **counted against
     `CrawlBudget`** (`maxLlmCalls`/`maxTokens`), and is **time-bounded/abortable** — reusing the #44
     abort fix in `LlmAdapter` (per-call `AbortController`, timer cleared on all settle paths). Failed/
     timed-out calls still count toward budget (the E2 property).
  2. **Cache-first + deterministic-first (NFR3).** The deterministic a11y/rule passes (#54, #55 tier-1)
     do the bulk; the LLM is the refinement, not the default. Results are cached by a stable key
     (`DecisionCachePort` pattern) — a re-run makes **zero** new calls.
  3. **Budget exhaustion finalizes gracefully (NFR6).** Hitting the cap degrades to rule-based with
     `null`/low confidence and still yields exactly one `WorkflowMap` — no crash, no retry storm.
  4. **Embeddings are budget-bounded too (#57).** If a new embedding port is added, its calls are
     bounded by config caps (no magic numbers) and abortable on the same discipline.
- **Owning tickets:** #55, #56, #57, #59. **Gate check:** the #59 fixture test asserts LLM-call count is
  bounded by `CrawlBudget` and far below screen/workflow count (cache-first proven); confirm no E3 call
  site bypasses the budget counter or opens a non-abortable call.

### T4 — `LLM_API_KEY` / embedding-provider key leak into logs, cache, errors, or the `WorkflowMap` (HIGH)

- **Class:** Information Disclosure. **OWASP A05 Security Misconfiguration · CWE-532 (Info in Log),
  CWE-312 (Cleartext Storage), CWE-798 (Hardcoded Credentials).**
- **Threat:** E3's new call sites and any **new embedding adapter (A4/A9)** handle provider secrets.
  Logging a request/response, caching a raw provider payload, an error containing the auth header, or a
  key spliced into the map leaks the secret.
- **Mitigation (testable):**
  1. **Keys from env, confined to the adapter (NFR1).** `LLM_API_KEY` (and any new embedding key) is
     read from env/secret store, used **only inside `adapters/llm`** (or the ADR-placed embedding
     adapter) — never in `application`/`domain`, never in the `WorkflowMap`, events, cache, or errors.
  2. **No provider SDK outside the adapter (NFR1, boundaries).** eslint-boundaries + dependency-cruiser
     keep `@anthropic-ai/sdk` and any embedding SDK isolated to the adapter package; the semantic engine
     depends on **ports only**.
  3. **Return-don't-log.** No screenshot bytes, a11y bodies, prompts, or raw provider responses logged;
     errors are typed/sanitized.
- **Owning tickets:** #55, #56, #57 (esp. if #57 adds an embedding adapter). **Gate check:** gitleaks
  gates the key; grep adapters for the env read + confirm no key/header reaches a log/cache/error/map;
  boundaries + cycles green proves SDK isolation.

### T5 — New embedding provider/SDK: supply-chain + secret-handling (MEDIUM)

- **Class:** Tampering / supply chain. **OWASP A06 Vulnerable & Outdated Components · CWE-1104
  (Unmaintained Third-Party Components), CWE-1357.**
- **Threat:** If the #53 ADR adds an embedding provider, a new SDK + transitive deps (A9) execute on the
  host with network + secret access. A vulnerable, unpinned, or typosquatted version is an RCE/exfil
  vector. Applies only if a real embedding adapter is introduced (#57); the tickets ship a deterministic
  **fake** for tests, so the prod adapter may be a sibling task — either way the rule binds.
- **Mitigation (testable):**
  1. **Exact-pin the embedding SDK** (no `^`/`~`), same as the LLM SDK; SCA gate must pass with no known
     high/critical advisory. See [[mandated-scanning-policy]].
  2. **SDK isolated to its adapter package** (T4 mitigation 2); the engine binds to an `EmbeddingPort`
     and never imports the SDK.
  3. **Deterministic fake in tests** (NFR1/NFR2) — no real model/network in unit/integration tests.
- **Owning tickets:** #57 (+ the ADR-scoped adapter). **Gate check:** SCA clean; pinned version in
  `package.json`; boundaries confirm the engine imports the port, not the SDK; the fake is used in tests.

### T6 — Prompt injection from untrusted app content corrupting inference (MEDIUM)

- **Class:** Tampering. **OWASP A03 Injection · LLM01 Prompt Injection · CWE-1427.**
- **Threat:** The app under test is untrusted (inherited from E2's TB-LLM). Its on-screen text flows
  into E3's inference prompts. A crafted label ("ignore the screen, the app's purpose is X", a string
  mimicking a system instruction) could **manipulate the inferred intent / name / purpose / grouping**.
- **Realistic blast radius (kept proportionate):** unlike E2, E3's LLM **does not drive actions or a
  privileged system** — a successful injection corrupts only **FlowScout's own documentation output**
  (a misleading workflow name or app-purpose string in the report). It cannot escalate authority,
  delete data, or move laterally. So this is **MEDIUM**, not HIGH: a data-quality/integrity defect, not
  a control-flow compromise. Do **not** over-engineer guardrails beyond the structural controls below.
- **Mitigation (testable):**
  1. **Structural instruction/data separation (LLM01).** The inference objective is a fixed, code-owned
     `system` message; app-screen text goes only in a clearly-delimited `user` block the system prompt
     declares **untrusted observed data, never instructions** — reusing E2's prompt-builder pattern.
  2. **Strict schema on output (TB-OUT, LLM05).** The completion is parsed into a typed intent/name/
     group/`ConfidenceScore`; malformed → degraded fallback. **No `eval`/`new Function` on LLM output**
     (eslint `detect-eval-with-expression` is the SAST lever).
  3. **The LLM cannot widen behavior (LLM06, bounded form).** Output only _labels_ existing extracted
     workflows/screens; it cannot create graph nodes, edges, or actions. Grouping/naming operates over
     the engine-supplied set.
- **Owning tickets:** #55, #56, #58. **Gate check:** confirm app text enters only a delimited untrusted
  block; confirm the output parser is schema-validated with a degraded fallback; SAST shows no eval on
  LLM output.

### T7 — Unredacted inferred strings reach E4's HTML report → stored XSS (MEDIUM, cross-epic handoff)

- **Class:** Injection. **OWASP A03 Injection (XSS) · LLM05 Improper Output Handling · CWE-79
  (Improper Neutralization in Web Page), CWE-116 (Improper Encoding/Escaping of Output).**
- **Threat:** Inferred `name`/`description`/intent strings (derived from untrusted app content + LLM
  output) flow into the `WorkflowMap` (A6) and are later **rendered into the HTML report (E4)**. App-/
  LLM-controlled text containing markup (`<script>`, event handlers) becomes **stored XSS** in the
  report if E4 does not output-encode.
- **Boundary note (why it's here, not silently dropped):** **output-encoding is E4's responsibility**,
  not E3's — but E3 is the producer of the tainted strings, so this model **records the handoff** so it
  is not lost between epics. E3 must not pre-escape (that corrupts the data contract); E3's obligation
  is to keep the strings **data** (no executable transformation) and **flag to E4/arch-review** that all
  `WorkflowMap` string fields are untrusted-origin and MUST be context-encoded on render.
- **Mitigation (testable):** E3 carries the strings as inert data; **E4 owns** HTML context-encoding /
  templating auto-escape of every `WorkflowMap` string field. Recorded as an E4 security requirement.
- **Owning tickets:** #59 (flag the contract to arch-review/E4). **Gate check:** confirm the E3→E4
  handoff note exists in the #59 PR / arch-review; verify E3 does not execute or HTML-interpret the
  strings. Enforcement of the encoding bites in **E4's** gate.

### T8 — Boundary / port-purity erosion opening an uncontrolled LLM/embedding path (MEDIUM)

- **Class:** Insecure Design. **OWASP A04 Insecure Design / A05 Misconfiguration · CWE-1061
  (encapsulation), CWE-668 (exposure of resource to wrong sphere).**
- **Threat:** A semantic feature importing a provider SDK or opening a direct, un-budgeted, un-redacted
  call (bypassing `LlmPort`/`EmbeddingPort`) defeats every control above at once — redaction (T1/T2),
  budget (T3), key isolation (T4), supply chain (T5). NFR1/FR6 forbid it.
- **Mitigation (testable):** the semantic engine lives in `application`/`domain` and depends only on
  domain ports; eslint-boundaries + dependency-cruiser stay green; no `adapters/*` or provider-SDK
  import from the engine.
- **Owning tickets:** all of #54–#59. **Gate check:** boundaries + cycles green; grep the semantic
  packages for direct SDK/`adapters/*` imports (must be none); every LLM/embedding call routes through a port.

### T9 — Workflow-enumeration explosion on cyclic/dense graphs (LOW, availability)

- **Class:** Denial of Service (local resource). **OWASP A04 Insecure Design · CWE-674 (Uncontrolled
  Recursion), CWE-400.**
- **Threat:** Rule-based extraction (#54) enumerating entry→outcome paths on a cyclic or dense graph can
  blow up combinatorially (memory/CPU), stalling the run. Not an egress threat but an availability one.
- **Mitigation (testable):** path-length / count caps from config (no magic numbers); cyclic and
  single-node/empty graphs handled; deterministic bounded output (PRD edge cases).
- **Owning tickets:** #54, #59. **Gate check:** confirm config-bounded enumeration; the cyclic-graph and
  empty-graph tests exist and the run does not explode.

---

## Severity summary

| Threat | Title                                                           | Severity | Primary ref       |
| ------ | --------------------------------------------------------------- | -------- | ----------------- |
| T1     | PII/secret leaked into LLM/embedding prompts (egress)           | HIGH     | LLM02 / CWE-200   |
| T2     | Unredacted data in report-bound `WorkflowMap` / cache           | HIGH     | LLM02 / CWE-212   |
| T3     | Runaway LLM/embedding spend / cost-DoS (fan-out)                | HIGH     | LLM10 / CWE-770   |
| T4     | Provider API-key leak (LLM + new embedding key)                 | HIGH     | CWE-532 / CWE-312 |
| T5     | New embedding SDK supply-chain + secret handling                | MEDIUM   | A06 / CWE-1104    |
| T6     | Prompt injection corrupting inference (proportionate)           | MEDIUM   | LLM01 / CWE-1427  |
| T7     | Unredacted inferred strings → stored XSS in E4 report (handoff) | MEDIUM   | A03 XSS / CWE-79  |
| T8     | Port-purity erosion → uncontrolled LLM/embedding path           | MEDIUM   | A04 / CWE-1061    |
| T9     | Workflow-enumeration explosion (cyclic graphs)                  | LOW      | CWE-674           |

---

## Per-ticket MUST controls (the security gate enforces these)

### #53 — ADR spike: node-identity "sameness" (architect-owned, no product code)

- **M53.1** The ADR MUST confirm the LLM/vision **and** embedding calls reuse the E2 budgeted/cached/
  time-bounded/redacted path (`LlmPort`/`CrawlBudget`/`DecisionCachePort`; provider SDK only in the
  adapter package) — **no new uncontrolled path** (OQ2). (T3, T8)
- **M53.2** The ADR MUST fix the **embedding model/provider** and the **package the embedding port +
  adapter live in**, so the secret-handling (T4), supply-chain/pinning (T5), and port-purity (T8) rules
  have a concrete target before #57 builds.
- **M53.3** The ADR MUST state whether **vision (screenshots) is in scope for MVP** or label-only (OQ4);
  if screenshots are admitted, the redaction/data-minimization posture (T1) MUST apply to them.

### #54 — E3.1 Workflow extraction (rule-based, NO egress)

- **M54.1** Pure/deterministic, **no LLM and no embedding call** — therefore no egress, no key, no
  prompt. The gate confirms zero provider use in this ticket. (boundaries / T8)
- **M54.2** Enumeration is **config-bounded** (path-length/count caps, no magic numbers); cyclic and
  empty/single-node graphs handled without explosion. (T9)
- **M54.3** Reads the **already-finalized graph** via the `StateGraphRepository` port; does not re-derive
  raw a11y text from any pre-redaction source. (T1 inheritance)

### #55 — E3.2 Per-screen/control intent inference (a11y + budgeted LLM)

- **M55.1 (T1)** Every a11y/label string is **redacted via the E2 `CredentialRedactor`** before it
  enters any prompt or the stored intent. A seeded-secret fixture test proves the prompt + intent are masked.
- **M55.2 (T3)** The LLM-refinement tier runs **only** through `LlmPort`, is **counted against
  `CrawlBudget`**, is **time-bounded/abortable** (#44 abort discipline), and is **cached** (re-run = zero
  new calls). Tier-1 a11y pass is deterministic and always runs (cache-first).
- **M55.3 (T6)** App text enters only a **delimited untrusted-data block**; the system prompt is
  code-owned; the completion is **schema-validated** into a typed intent; malformed → degraded fallback;
  **no `eval` on output**.
- **M55.4 (T4/T8)** No provider SDK or `adapters/*` import in the intent engine; `LLM_API_KEY` never in
  logs/cache/intent/errors. Return-don't-log (no a11y bodies/screenshots logged).
- **M55.5 (T2)** Missing-label degraded fallback uses role/position, **never a raw a11y dump**; no secret
  survives into the intent model.

### #56 — E3.3 App-purpose + workflow naming & feature grouping (LLM, budgeted)

- **M56.1 (T1/T2)** All naming/grouping/purpose prompts use redacted inputs; the produced `name`/
  `description`/purpose/group strings carry **no credential/PII/secret pattern** (output-side check).
- **M56.2 (T3)** Every LLM call via `LlmPort`, budget-counted (`maxLlmCalls`/`maxTokens`), abortable,
  cached — re-run makes **zero** new calls; over-budget degrades to rule-based with `null`/low confidence.
- **M56.3 (T6)** Code-owned system prompt + delimited untrusted app text; schema-validated typed output
  (name/group/`ConfidenceScore`); no eval; the LLM only **labels existing** extracted workflows (cannot
  widen the set).
- **M56.4 (T4/T8)** Port-only; SDK/`adapters/*` not imported; key never logged/cached/mapped.
- **M56.5 (T7 handoff)** The additive purpose/feature-group fields (OQ3) are **inert data**; flag to
  arch-review/E4 that all `WorkflowMap` string fields are untrusted-origin and MUST be HTML-encoded by E4.

### #57 — E3.4 Screen-embedding + semantic-label identity refinement (BLOCKED on #53)

- **M57.1 (T1)** Any text/screenshot sent to the embedding provider is **redacted first** (TB-RED); data
  minimized per the ADR.
- **M57.2 (T3)** Embedding calls are **budget-bounded** (config caps, no magic numbers) and abortable; a
  **deterministic fake** embedding provider is used in tests (no real model/network — NFR1/NFR2).
- **M57.3 (T4/T5/T8)** If a real embedding adapter is introduced: the **SDK is exact-pinned**, **SCA
  clean**, **isolated to its adapter package**, and the engine imports only the `EmbeddingPort`; the
  embedding API key is env-sourced and never logged/cached/mapped/errored.
- **M57.4** Refinement only **merges** a11y buckets, never **splits** one (integrity of E2 identity);
  the precision/no-false-merge property has eval coverage (functional, but guards T2 false-grouping that
  could mislabel an outcome).

### #58 — E3.5 Semantic duplicate / hidden-path detection (BLOCKED on #53)

- **M58.1 (T6)** Consumes **redacted** outcome-node intent (#55) + refined identity (#57); introduces no
  new prompt/egress unless it routes through the budgeted/redacted `LlmPort` (then M55.1–M55.4 apply).
- **M58.2 (T2)** The duplicate-association data it adds to the workflow model carries **no raw a11y/secret
  text** — only ids/flags (`isHiddenPath`) and confidence.
- **M58.3 (T8)** Port-only; no SDK/`adapters/*` import.

### #59 — E3.6 `WorkflowMap` assembly + composition-root + E2E (capstone)

- **M59.1 (T2 — the clean gate)** The integration test runs a **secret/PII-seeded fixture graph** through
  the full pipeline and asserts the finalized `WorkflowMap` (names, descriptions, intent, purpose,
  groups) and the cache contain **no secret/PII pattern**; gitleaks + redaction green.
- **M59.2 (T3)** The fixture test asserts LLM-call count is **bounded by `CrawlBudget`** and far below
  screen/workflow count (cache-first + deterministic-first proven); **fake LLM, no simulator, no network**.
- **M59.3 (T8)** `BuildWorkflowMap` is constructed at `packages/api` from resolved `AppPorts` only —
  **never imports a concrete adapter**; boundaries + cycles green.
- **M59.4 (NFR6)** Any inference failure (timeout/over-budget/missing labels) still finalizes **exactly
  one** `WorkflowMap` (degraded, never torn) — no crash, no retry storm (T3).
- **M59.5 (T7 handoff)** The PR records the E3→E4 handoff: every `WorkflowMap` string field is
  untrusted-origin and MUST be output-encoded by E4's renderer. Routed to arch-review.

---

## Verdict policy for the E3 security gate (per ticket, post-implementation)

- **Critical / High → FAIL** (block, route to developer). The HIGH controls here are **T1/T2 redaction
  on egress and into the map**, **T3 budgeted/abortable path**, **T4 key isolation** — a missing
  redaction call before a prompt, an un-budgeted/non-abortable LLM/embedding call, a provider SDK
  imported outside its adapter, or a key/PII reaching a log/cache/map is a **FAIL**.
- **Medium → must fix, or open a tracked follow-up and PASS-with-conditions** (never silently dropped) —
  e.g. T5 SCA finding on the embedding SDK, T6 prompt-injection structural gap, T7 missing E4 handoff note.
- **Low → note** in the verdict (e.g. T9 enumeration-bound edge cases).
- The **T7 XSS enforcement itself bites in E4's gate**, not E3's; E3's gate only verifies the handoff is recorded.
