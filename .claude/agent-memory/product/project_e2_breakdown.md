---
name: project-e2-breakdown
description: How E2 (autonomous crawl & state-graph engine) was sliced into tickets #31-#37 and the scope decisions behind the cut lines
metadata:
  type: project
---

E2 (epic #2, autonomous crawl & state-graph engine) was broken into 7 vertical slices:
#31 E2.1 walking-skeleton crawl loop, #32 E2.2 StateIdentity strategy, #33 E2.3 budget/termination enforcement,
#34 E2.4 frontier/visited + backtrack, #35 E2.5 hidden-option probes, #36 E2.6 DecisionPolicy chain (CachedKnowledge->LLM),
#37 E2.7 duplicate-path detection + composition-root + E2E. PRD: docs/sdlc/prd/PRD-e2-crawl-engine.md.

**Why:** The scaffold already shipped almost the entire E2 port surface in packages/domain — `StateGraph`/`StateNode`/
`StateEdge`/`StateIdentity` (state-graph.ts), `DecisionPolicy`+`LlmPort` (DecisionPolicyPort.ts, explicitly documenting
the CachedKnowledgePolicy->LLMPolicy chain), `CrawlEventStream` (incl. CredentialPrompt/BudgetWarning events),
`CrawlBudget` (run.ts: maxSteps/maxLlmCalls/maxTokens/maxRevisitsPerState), `StateGraphRepository`, and stub
`LlmAdapter`/`LlmDecisionPolicy` in packages/adapters/llm marked "TODO E2/E3". So E2 is "build the loop + fill the
stubs", not "design the ports". That made E2.1 (loop) and E2.2 (identity) genuinely dependency-free and disjoint
(application vs domain), so they start concurrently. Slices were cut walking-skeleton-first (thin loop -> caps ->
frontier -> hidden-path -> policy chain -> integrate) per the coordinator's instruction to layer sophistication.

**Key scope decisions (don't let downstream contradict):** E2 binds to the StateGraphRepository PORT and ships an
in-memory impl; durable PostgreSQL/Prisma persistence stays E7 (persistence adapter is stubbed). E2 only DETECTS the
2FA/credential boundary (emits CredentialPromptEvent + enters blocked-on-2fa); vault + resume is E6. Structural
duplicate-path detection (duplicatePathNodeIds) is E2; SEMANTIC interpretation/grouping is E3. Budget caps are
engine-enforced, not policy-enforced.

**Deferred to architect's E2 ADR (NOT invented here):** OQ1 StateIdentity composition/embedding/threshold (ADR-0001 R1),
OQ2 LLM provider/model/prompt + default CrawlBudget numbers (R3), OQ3 coverage-plateau tuning, OQ4 in-memory-vs-where
state-graph store home, OQ5 hidden-affordance probes vs E1 driver gesture coverage (R2). See [[project-e1-breakdown]]
and [[project-flowscout-sdlc-pipeline]].
