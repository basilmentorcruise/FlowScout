---
name: e2-crawl-engine-decomposition
description: E2 crawl-engine ADR-0004 — frozen StartCrawlRun shell + injected-collaborator decomposition, default StateIdentity/LLM/budget decisions
metadata:
  type: project
---

ADR-0004 (`docs/sdlc/architecture/ADR-0004-crawl-engine-state-identity-policy-budgets.md`) resolves PRD-e2
OQ1–OQ5 and decomposes the crawl engine (#31–#37) so they build with minimal shared-file overlap.

**Decomposition pattern (the E1 facade lesson re-applied to a non-facade unit):** the engine is ONE
`StartCrawlRun` use-case, not a facade-over-capabilities. So the analogue of E1's frozen facade is a **frozen
orchestrator shell + injected collaborator interfaces**: the dependency-free foundation ticket (#31) lands
`StartCrawlRun.ts` + `CrawlLoop.ts` + `collaborators.ts` (interfaces + `defaultCollaborators()`) + **stub**
collaborators (BudgetEnforcer, Frontier) + the in-memory graph repo + test-support fakes/fixtures. Each later
ticket REPLACES the one collaborator subtree it owns (`crawl/budget/**` #33, `crawl/frontier/**` #34,
`crawl/frontier/probes/**` #35, `crawl/policy/**` #36, `crawl/{duplicate,redaction,twofa}/**` #37) and never edits
`StartCrawlRun.ts`/`collaborators.ts`. Per-ticket `__tests__` only — no shared mega-suite, no `vitest.config` edits
after #31 (the E1 Wave-1 shared-test/`vitest.config` fight, see [[e1-conformance-harness]]).

**Key OQ decisions:** OQ1 default StateIdentity = embedding-free **normalized a11y structural signature**
(SHA-256 of a depth-bounded skeleton; digit/timestamp/currency normalization + repeated-sibling collapse for
volatile tolerance), pluggable `StateIdentityStrategy` in domain; embedding+label are additive composables
deferred to E3 (cosine sameness threshold 0.92 recorded as the E3 default to tune). OQ2 LLM = **Claude
`claude-opus-4-8`** (config-pinned via `LLM_MODEL`, SDK only in `adapters/llm`), CachedKnowledge→LLM chain;
**default CrawlBudget: maxSteps 400, maxLlmCalls 40, maxTokens 120k, maxRevisitsPerState 3, plateauWindow 40**.
OQ3 plateau = distinct-StateIdentity-count delta over a window. OQ4 in-memory graph store lives in
`application/src/crawl/persistence/` (NOT adapters/persistence, NOT test-only). OQ5 hidden probes: scroll/swipe/
overflow are driver-supported; **long-press has NO `MobileDriverPort` primitive** → degraded no-op + fake-fixture
coverage; adding `longPress`/`gesture` to the port is a SEPARATE future ADR + E1 follow-up (do not block E2).

**Corrections I made to the tickets:** #36 originally put `CachedKnowledgePolicy` in `adapters/llm` — moved to
`application` (it makes no LLM call, must not sit in the provider adapter); only `LLMPolicy`+chain+`LlmAdapter`
stay in `adapters/llm`. New additive domain ports/edits sanctioned: `StateIdentityPort` (#32),
`DecisionCachePort` (#36), `CrawlBudget.plateauWindow/plateauWarnRatio`+`defaultCrawlBudget`+`BudgetWarningEvent`
budgetType `revisits`/`plateau` (#33). **Batching:** Wave0 {#31,#32}; after #31 {#33,#34} concurrent, #36 joins as
#33 lands; #35 after #34; #37 capstone (owns the `packages/api` wire.ts edit). See also
[[e1-adapter-decomposition]].
</content>
