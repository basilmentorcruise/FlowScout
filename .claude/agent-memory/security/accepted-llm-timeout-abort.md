---
name: accepted-llm-timeout-abort
description: Accepted mitigation — LLM call timeout via Promise.race satisfies the time-bounded MUST; un-aborted SDK request + leaked timer is a tracked Medium, not a FAIL
metadata:
  type: project
---

The LlmAdapter time-bounds each LLM call with `Promise.race([client.create(), rejectAfterMs(timeoutMs)])`. On timeout the policy promise rejects and falls back to a safe backtrack, so the crawl cannot hang — this **satisfies the "time-bounded LLM call" MUST** in [[recurring-risks-llm-boundary]] (#36).

The known gap: no `AbortController`/`signal` is passed, so the underlying provider request is not actually aborted, and the `setTimeout` is not `clearTimeout`'d on the success path (timer leaks until it fires).

**Why:** the security intent of the MUST (no crawl hang, no unbounded retry) is met — caps + cache-on-fallback bound blast radius. The residual is a resource-hygiene cost/DoS issue (CWE-400/CWE-772), severity Medium.

**How to apply:** accept as PASS-with-conditions when this pattern appears; require a tracked follow-up to add an AbortController + clearTimeout. Do NOT FAIL a ticket solely for the un-aborted request as long as the policy resolves safely. Re-judge to High only if a future change removes the fallback or lets failed calls retry without counting toward budget.
