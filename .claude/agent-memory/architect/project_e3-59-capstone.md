---
name: e3-59-capstone
description: #59 plan — BuildWorkflowMap assembly; canonical-map post-hoc (no collaborators edit); shared RunBudgetMeter; duplicateGroups additive; orphan debt deferred
metadata:
  type: project
---

#59 (E3.6) capstone plan: `docs/sdlc/architecture/E3.6-workflowmap-assembly-plan.md` (per-ticket plan, NOT a new
ADR — architecture fixed by ADR-0005/0006/0007; #59 is integration + 3 wiring decisions). Assembles merged
#54/#55/#56/#58. Gate #59 against this:

**Orchestration order (BuildWorkflowMap.execute):** reset budget → load graph (null/empty ⇒ one empty map, NFR6)
→ extract(#54) → inferIntent(#55) → refineIdentities(#58, produces CanonicalIdentityMap) → detect(#58, applies
map raw→canonical, sets isHiddenPath + duplicateGroups) → nameAndGroup(#56, relabel-only, preserves isHiddenPath
via spread) → assemble WorkflowMap{runId,workflows,finalisedAt,appPurpose,appPurposeConfidence,duplicateGroups}.
detect MUST run before group (group is last relabel pass; isHiddenPath must already be on the objects it emits).
intent once, before refine+group (both consume it; refine uses confident-label veto). No try/catch around passes —
each degrades internally.

**3 key decisions (the load-bearing rulings):**

1. **CanonicalIdentityMap = POST-HOC inside BuildWorkflowMap; collaborators.ts NOT touched.** Resolves the
   #57/#58 coordinator obligation. Why: the map is a product of the FINALIZED graph — it doesn't exist during the
   live crawl, so wiring it into CompositeStateIdentityStrategy's seam would wire an EMPTY map (non-empty only on a
   later crawl = cross-run priming = E7, YAGNI). Correct consumer of a post-hoc map = the detector
   (canonicalMap.get(rawOutcome)). The merge runs in step 4→5. **Absence of a collaborators.ts diff is CORRECT, not
   a missed obligation** (R-3). Composite seam stays dormant until E7. No maxEmbeddingCalls.
2. **Shared budget = ONE `RunBudgetMeter` (NEW, semantic/budget/) injected into all 3 passes' guards.** Both
   IntentBudgetGuard(#55, reused by #56) and EmbeddingBudgetGuard(#58) get an **additive** ctor overload: accept a
   shared RunBudgetMeter (delegate) OR a CrawlBudget (existing self-meter, default → all merged tests stay green).
   Structural substitution is impossible (private fields ⇒ nominal). reset() per execute (wire-once + single-flight,
   E2 StartCrawlRun precedent; concurrency = R-2/E7). Bounds total LLM+embedding spend by ONE maxLlmCalls/maxTokens.
3. **#54 orphan should-fixes = TRACKED DEBT, not fixed in #59.** orphanStateIds is extractor-internal, no
   WorkflowMap/E4 consumer; fixing the visitedNodes asymmetry changes zero observable map behavior; perturbing the
   DFS in the broad capstone risks the determinism the whole pipeline rests on. Coordinator files a focused
   follow-up (uses #54's own evals). #59 E2E must NOT assert orphan internals.

**Additive domain change (flag to arch-review):** `WorkflowMap.duplicateGroups?: readonly DuplicatePathGroup[]`
(optional; omitted=pre-#59, []=ran-none, mirrors appPurpose semantics). DuplicatePathGroup already exists/exported.

**Wiring:** wire.ts assembles BuildWorkflowMap from AppPorts.stateGraphRepository + composition-root adapters
(EmbeddingAdapter exists in adapters/llm; add createEmbeddingClient if missing — adapter layer; caches; shared
RunBudgetMeter). BuildWorkflowMap imports NO adapter (NFR1). Expose via AppContextWithWorkflowMap (mirrors
…WithCrawl). AppPorts NOT expanded.

**E2E:** 2 layers (E2.7 precedent). Fixture graph = BOTH a structural same-raw-id convergent node (must NOT be
flagged semantic — precision) AND two distinct-raw-identity outcomes with ≥0.94 fake-embedding cosine (merge →
≥1 DuplicatePathGroup, hidden route flagged). FakeEmbeddingPort + FakeLlmPort + tiny CrawlBudget. Assert:
extracted+grouped, appPurpose inferred, ≥1 semantic dup flagged, every confidence-or-null, combined LLM+embedding
calls ≤ maxLlmCalls (one-embedding-per-distinct-bucket), degraded-safe (one map on throw), deterministic
(deep-equal), redaction (synthetic secret in no field/prompt), no real LLM/simulator.

**Gate outcome (PR #74, head 1ef3ece):** PASS. Verified — BuildWorkflowMap port-pure (depcruise clean, 554
modules), order/one-map/no-try-catch as planned, all 3 rulings correctly implemented (collaborators/StartCrawlRun/
CompositeStateIdentity/WorkflowExtractor untouched per git diff --stat), additive duplicateGroups?, two-layer
fakes-only E2E proves success-metric+precision+shared-budget-starvation+degraded-safe+determinism+OTP-redaction.
Coverage 100% line/branch on BuildWorkflowMap/RunBudgetMeter/both guards (measured, not trusted). **E3 epic COMPLETE.**
One tracked should-fix (Voyage token-field accounting) + #54 orphan-accounting follow-up (#73) remain as debt.

See [[e3-58-duplicate-detection]] (producer), [[e3-57-refinement-seam]] (deferred obligations this discharges),
[[e3-node-identity-sameness]] (ADR-0005 post-hoc), [[e2-decision-policy-chain]] (seam-now/activate-in-consumer).
