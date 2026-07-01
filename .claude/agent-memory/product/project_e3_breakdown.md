---
name: project-e3-breakdown
description: How E3 (semantic understanding & workflow mapping) was sliced into tickets #53-#59, the ADR-blocked slices, and the scope cut lines
metadata:
  type: project
---

E3 (epic #3, semantic understanding & workflow mapping — purpose + duplicate-path detection) was broken into
an architect ADR spike + 6 vertical slices. PRD: docs/sdlc/prd/PRD-e3-semantic-workflow-mapping.md.

- #53 ADR spike — node-identity "sameness" (tree sig + screen embedding + semantic label) — architect-owned, dispatch FIRST
- #54 E3.1 workflow extraction from the state graph (rule-based, entry->outcome) — immediately eligible
- #55 E3.2 per-screen/control intent inference (a11y tier-1 + budgeted LLM tier-2) — immediately eligible
- #56 E3.3 app-purpose + workflow naming & feature grouping (LLM, budgeted) — Depends-on #54,#55
- #57 E3.4 screen-embedding + semantic-label identity refinement — BLOCKED on #53 (ADR)
- #58 E3.5 semantic duplicate/hidden-path detection (the differentiator) — BLOCKED on #53; Depends-on #54,#57
- #59 E3.6 WorkflowMap assembly + composition-root wiring + E2E (capstone) — Depends-on #54,#55,#56,#58

**Why this cut:** E2 (#31-#37, [[project-e2-breakdown]]) already shipped the seams E3 fills, so E3 is "populate
the scaffolding", not "design ports": the `Workflow`/`WorkflowStep`/`WorkflowMap`/`ConfidenceScore` domain model
already exists empty (packages/domain/src/models/workflow.ts); `StateIdentityInput` already reserves optional
`screenEmbedding`+`semanticLabel` as additive E3 inputs and `CompositeStateIdentityStrategy` is the frozen merge
seam (delegates-only in E2); the `LlmPort`/`LlmAdapter` (with the #44 AbortController timeout fix) + `CrawlBudget`
(maxLlmCalls/maxTokens) + `DecisionCachePort` are the ONLY sanctioned LLM path. So #54 (pure rule-based extraction,
reads StateGraph -> Workflow[]) and #55 (new intent model + a11y pass) are genuinely dependency-free and disjoint,
start immediately. Sophistication layers after: naming/grouping (#56) -> identity refinement (#57) -> semantic
sameness (#58) -> capstone (#59).

**The hard part is gated on an architect ADR (#53):** outcome "sameness" = when two STRUCTURALLY-DISTINCT paths
(different state identities) reach the SAME semantic outcome — the case E2's structural `duplicatePathNodeIds`
misses. The composition/weighting/threshold (ADR-0004 §2.3 recorded a PROVISIONAL cosine >= 0.92 "to tune") +
embedding model/provider + embedding-port home are research-grade and deferred. #57 and #58 are BLOCKED until #53
lands; coordinator dispatches the architect first. Precision matters: a false "duplicate" is worse than a miss.

**Key scope decisions (don't let downstream contradict):** E3 reuses the E2 budgeted/cached/redacted LLM path —
NOT a new uncontrolled LLM call and NO provider SDK import outside adapters/llm (FR6/NFR1). E3 produces the
IN-MEMORY WorkflowMap bound to repository ports; durable Postgres store + cross-run workflow diffing is E7. HTML
rendering is E4 (E3 produces WorkflowMap as E4's data contract — additive-only changes to the model). Test-plan
gen is E8. OQ3: app-purpose + per-workflow feature-group are carried as ADDITIVE optional fields on
WorkflowMap/Workflow (architect confirms with E4 input) — must NOT overload `description`.

**Status note:** this breakdown (PRD + all 7 issues on Project #4, Status=Todo, labels mvp + type:feature/task,
Parent #3) was produced in a prior run; a later pass corrected stale cross-references in #53/#54/#55 bodies that
still pointed at an earlier draft numbering (#48-#53) instead of the final #53-#59. All bodies now reference only
#3 + #53-#59. See [[project-flowscout-sdlc-pipeline]].
