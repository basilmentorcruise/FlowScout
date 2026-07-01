---
name: recurring-risks-llm-boundary
description: The decision-LLM is FlowScout's second external trust boundary (after mobile-mcp); prompt-injection, sensitive-data-to-LLM, unvalidated-output, key-leak, and cost-DoS risks recur in every ticket touching adapters/llm or the crawl engine.
metadata:
  type: project
---

The **decision LLM** (introduced in E2, ticket #36, `packages/adapters/llm`) is FlowScout's **second
external trust boundary** — the first being the mobile-mcp adapter ([[recurring-risks-mobile-mcp]]).
The crawl engine feeds the LLM live app-screen content (a11y trees from **real test-account data**) to
choose taps/types, with **no in-flow guardrails** (owner decision, ADR-0001 F6).

**Why:** the LLM both _receives_ sensitive app data and _drives_ real actions, so it is simultaneously
a data-exfil sink and an action-injection source. ADR-0001 R3/F2 fix it behind the `LlmPort` /
`DecisionPolicy` ports; the provider SDK must stay isolated to `adapters/llm` so the controls below
have a single chokepoint.

**How to apply** — when reviewing any ticket touching `adapters/llm` or the crawl loop, check the
recurring set (full detail in `docs/sdlc/security/e2-crawl-engine-threat-model.md`):

- **Prompt injection (LLM01 / CWE-1427):** fixed code-owned system prompt; app-screen text only in a
  delimited _untrusted-data_ block; the LLM selects among **engine-generated candidate actions**,
  never widens its own authority.
- **Output validation (LLM05/LLM06 / CWE-20):** parse the completion against a strict schema + require
  the action to match an engine candidate/allowlist _before_ it drives `MobileDriverPort`; invalid →
  safe fallback, never executed. **No `eval`/`new Function` on LLM output** (eslint
  `detect-eval-with-expression` is the SAST lever).
- **Data minimization + redaction (LLM02 / CWE-200/201):** send a redacted, minimized a11y/candidate
  representation — not the raw `A11ySnapshot`, **no screenshots by default**. Same redaction filter
  guards graph/events/cache (NFR5).
- **API key (CWE-532/312):** `LLM_API_KEY` from env, confined to `adapters/llm`, never in logs /
  events / cache / errors / argv. gitleaks gates it.
- **Cost DoS (LLM10 / CWE-770):** caps (`maxSteps`/`maxLlmCalls`/`maxTokens`/`maxRevisitsPerState` +
  plateau) enforced by the **engine, not the policy**; failed/timed-out LLM calls still count toward
  budget. Numbers from `CrawlBudget` config, no magic numbers. **Split of ownership:** #33's
  `BudgetEnforcer` _enforces_ `maxLlmCalls`/`maxTokens` against the `llmCallCount`/`tokenCount` it is
  handed; the loop's `buildBudgetCtx` hard-codes those to `0` with a "#36 wires real usage" comment.
  That placeholder is **expected, not a defect** — truthful usage feed (incl. counting failed calls)
  lands with the real `LlmAdapter` in #36 (T6 assigns the feed to #36). The "failed calls still count"
  property is testable at the enforcer level in #33 (it enforces against whatever count it gets) and
  must be verified end-to-end at the caller in #36. (Note: #33's StartCrawlRun comment says "#33 wires
  it" while the enforcer says "#36" — cosmetic inconsistency, the substance is #36.)
- **Supply chain (CWE-1104):** exact-pin the LLM SDK, SCA gate, SDK isolated to `adapters/llm`
  (boundaries + dependency-cruiser enforce isolation).

Two adjacent E2 controls that are not strictly LLM but recur with it: the **redaction boundary**
(typed credential/OTP text redacted before graph/events/cache — NFR5) and the **no-production /
reset-safety-net** guard (engine must target test/sandbox + establish E1 snapshot reset before
destructive autonomous exploration). See [[scope-boundaries]] (vault=E6, durable store=E7) and
[[mandated-scanning-policy]].
