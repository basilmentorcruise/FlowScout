---
name: e3-intent-inference
description: E3.2 (#55) intent inference — additive overlay model + reuse of E2 LlmPort/budget/cache/redactor (ADR-0006)
metadata:
  type: project
---

E3.2 (#55) per-screen/per-control intent inference design is fixed in `docs/sdlc/architecture/ADR-0006-e3-intent-inference-budgeted-llm.md` (NOTE: it is ADR-0006; ADR-0005 is the node-identity sameness ADR). PR #66 (head 399683a) PASSED the arch gate on 2026-06-27: domain additions additive-only (no state-graph/workflow/DecisionCachePort edit), depcruise clean (no SDK outside adapters/llm), intent coverage 100% stmt / 96.2% branch, packages/api untouched (wiring still #59).

Key decisions (for gating #55 and informing #56/#59):

- **Intent model is a NEW additive overlay** `packages/domain/src/models/intent.ts` (`ScreenIntent`/`ControlIntent`/`IntentModel`), keyed by `StateIdentity` + `StateEdge.id`. NOT new fields on `StateNode`/`StateEdge` — semantics overlay the graph, do not mutate E2 crawl records (separation of concerns). Reuses `ConfidenceScore` from `workflow.ts`.
- **Two-tier, a11y-first:** tier-1 `A11yIntentDeriver` always runs, deterministic, no LLM, degraded-but-never-empty fallback. Tier-2 LLM refinement is gated by BOTH an enable flag AND `IntentBudgetGuard`.
- **HARD CONSTRAINT encoded:** every LLM call via the existing `LlmPort` (real impl only in `adapters/llm`); counted vs `CrawlBudget` (maxLlmCalls/maxTokens) by `IntentBudgetGuard` (failed calls still count); cached via NEW `IntentCachePort` keyed by a content-hash of the REDACTED skeleton (NOT `DecisionCachePort`, which is StateIdentity→PolicyDecision); redacted by reusing the existing `CredentialRedactor` (packages/application/src/crawl/redaction). Label-only, NO vision/screenshot for #55.
- **New additive domain changes to expect at arch-review:** `models/intent.ts`, `ports/IntentCachePort.ts`. Both additive — sanctioned. Editing `StateNode` would need a new ADR (avoided).
- **#55 does NOT edit packages/api** — composition-root wiring is the #59 capstone's job. #55 ships unit + fake-driven integration tests.
- Disjoint from #54 (`semantic/extraction/**`); #55 owns `semantic/intent/**`.

**Why:** PRD-e3 FR2/FR6 + the ticket's HARD CONSTRAINT — no new uncontrolled LLM path; reuse E2's budgeted/abortable/cached/redacted boundary verbatim.
**How to apply:** when gating #55, verify no `@anthropic-ai/sdk` outside adapters/llm, the budget guard counts every call, the intent cache makes re-runs zero-call, and redaction precedes every sink. For #56, consume `IntentModel` as a structured contract (confidence non-null iff source=="llm"). See [[e2-decision-policy-chain]] for the LLMPolicy prompt/redaction pattern this mirrors.
