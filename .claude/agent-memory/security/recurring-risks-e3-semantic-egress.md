---
name: recurring-risks-e3-semantic-egress
description: E3 (semantic workflow mapping) reuses the E2 LLM boundary for inference + may add an embedding provider; the recurring risks are data egress into prompts/embeddings/the report-bound WorkflowMap, key isolation, cost fan-out, and a proportionate (low-blast-radius) prompt-injection.
metadata:
  type: project
---

E3 (#3, tickets #54–#59; ADR spike #53) is **post-crawl offline analysis** — it consumes E2's
finalized `StateGraph` and produces the `WorkflowMap` (the E4 report + E8 test-plan contract). It does
**not** drive the simulator, so E2's `LLM06` destructive-action surface does **not** apply; E3's LLM
emits **documentation text** (intent labels, workflow names, app purpose), not actions. See
[[recurring-risks-llm-boundary]] for the inherited E2 controls and [[scope-boundaries]].

**Why E3 still matters for security:** it adds a **second class of egress** of the same sensitive
a11y/screen content — for semantic inference and, in #57, possibly a **new embedding provider** (a
second outbound network sink + second API key). And it adds a **new persisted, human-facing sink**: any
unredacted PII/secret in an _inferred_ string lands in the `WorkflowMap` and flows into the E4 HTML
report.

**How to apply** — when gating any E3 ticket touching `packages/application/src/semantic/**` or
`adapters/llm` / a new embedding adapter, enforce (full detail in
`docs/sdlc/security/e3-semantic-workflow-mapping-threat-model.md`):

- **HIGH — redaction on egress AND into the map (T1/T2, LLM02/CWE-200/212):** every a11y/label string
  passes the E2 `CredentialRedactor`
  (`packages/application/src/crawl/redaction/CredentialRedactor.ts`, exported from the application
  index) **before** any prompt / embedding input / stored intent / `WorkflowMap` / cache. #59's capstone
  test must run a **secret-seeded fixture** and assert the finalized map + cache contain no secret/PII.
- **HIGH — budgeted/abortable, no new uncontrolled path (T3, LLM10/CWE-770):** E3 multiplies LLM call
  sites (per screen/control/workflow) + adds embedding calls. All route through `LlmPort`/the
  ADR-defined `EmbeddingPort`, counted against `CrawlBudget` (`maxLlmCalls`/`maxTokens`), time-bounded/
  abortable (reuse #44's per-call `AbortController` in `LlmAdapter`), cache-first (re-run = zero calls),
  deterministic-first. No provider SDK / un-budgeted call in the semantic engine.
- **HIGH — key isolation (T4, CWE-532/312):** `LLM_API_KEY` and any **new embedding key** are env-
  sourced, confined to the adapter package, never in logs/cache/`WorkflowMap`/errors. gitleaks gates.
- **MEDIUM — embedding SDK supply chain (T5, A06/CWE-1104):** if #53's ADR adds an embedding provider,
  exact-pin the SDK, SCA clean, SDK isolated to its adapter, engine imports the port + a deterministic
  fake in tests. See [[mandated-scanning-policy]].
- **MEDIUM — prompt injection is PROPORTIONATE (T6, LLM01/CWE-1427):** app content steers inference, but
  E3's LLM drives no privileged system — worst case is a misleading label/name in FlowScout's **own**
  report, a data-quality defect, not control-flow compromise. Apply the structural controls (code-owned
  system prompt + delimited untrusted block + schema-validated output + no `eval`); do **not**
  over-engineer guardrails beyond that.
- **MEDIUM — XSS is an E4 handoff (T7, CWE-79):** inferred `WorkflowMap` strings are untrusted-origin;
  output-encoding is **E4's** responsibility on render. E3 keeps them inert data and **records the
  handoff** to arch-review/E4 (don't drop it silently); the encoding enforcement bites in E4's gate.

**Verified evidence pattern (set by #55 PASS, reuse for #56/#59 gates):** the canonical T1/T2 proof is a
**two-pass redaction at the orchestrator seam** — `redactor.redact(snapshot)` (structural, masks
secure-field values) THEN `redactor.redactText(serialized)` (masks OTP-shaped tokens in observed
label/static text, e.g. "Your code is 482913") — applied to the snapshot AND every edge `actionPayload`
BEFORE the cache key, the prompt, or the stored intent. The seeded fixture is `hunter2-SECRET` (secure
value) + `482913` (OTP in a label); the redaction test asserts both are absent from `allPromptText` and
from `JSON.stringify(model)`, and `[REDACTED]` is present. The **cache-key sink** is covered indirectly:
`intentCacheKey` is a SHA-256 of the already-redacted skeleton, and `IntentCacheKey.test` asserts the key
never contains its input — so the key is non-recoverable by construction. The `LlmPort` lives in
`packages/domain/src/ports/DecisionPolicyPort.ts` (the E2 port, reused) — its `complete(messages,
{maxTokens, temperature})` carries no signal/timeout param because the **abort/time-bound is the #44
adapter's job, not the caller's**; #55 correctly ships only the port-bound caller + `IntentBudgetGuard`
(counts failures as a 0-token call) + a `FakeLlmPort` test double. Tier-2 SDK confinement is by **absence
of import** (grep clean), since #55 adds no adapter code.
