---
name: e3-58-duplicate-detection
description: #58 plan — post-hoc embedding orchestrator + semantic duplicate/hidden-path detector; precision-first, additive contracts
metadata:
  type: project
---

#58 (E3.5) plan: `docs/sdlc/architecture/E3.5-semantic-duplicate-detection-plan.md` (per-ticket plan, NOT a new
ADR — ADR-0005 already fixed the algorithm/threshold/port/budget; #58 is implementation + sanctioned-additive
contracts). Builds the two responsibilities deferred from #57 ([[e3-57-refinement-seam]]).

**Why / How to apply (gate #58 against this):**

- **R1 orchestrator** `RefineIdentities` (application/semantic/sameness/): walks `graph.nodes` (each node = one
  distinct a11y bucket) sorted by id; redact(2-pass like InferIntent)→`projectSkeleton`→budget-gated
  `EmbeddingPort.embed` once per bucket, cached via NEW `EmbeddingCachePort`; feeds the UNCHANGED #57
  `SamenessRefiner`; returns `CanonicalIdentityMap`+classes. FakeEmbeddingPort's first consumer; the
  one-embedding-per-bucket cache assertion lives HERE (callCount===N distinct buckets).
- **R2 detector** `SemanticDuplicateDetector` (pure/sync): groups workflows by canonical outcome id; flags only
  CROSS-identity convergence (raw outcome ids differ, canonical same — the case E2's structural detector misses);
  marks less-prominent route (fewest steps, lexicographic tie-break) `isHiddenPath=true`; emits NEW additive
  `DuplicatePathGroup` (separate domain model, NOT a Workflow field).
- **Precision bias:** detector adds NO new merging (reads refiner classes only) + a class-level intent-confirmation
  gate at flag time (suppress if outcome ScreenIntent llm-labels confidently conflict) — this is where the
  transitive-veto-bypass should-fix is handled, NOT by editing #57's refiner.
- **Sanctioned-additive (flag to arch-review):** `EmbeddingCachePort`+InMemory impl; `DuplicatePathGroup`
  (duplicate-path.ts); `projectA11ySkeleton` export (pure extract of A11ySignatureStrategy.buildSkeleton, identity
  hash byte-for-byte unchanged); `EmbeddingBudgetGuard` (shape-clone of IntentBudgetGuard). Budget folds into
  maxLlmCalls/maxTokens (no maxEmbeddingCalls — YAGNI).
- **#59 owns (NOT #58):** wiring CanonicalIdentityMap into collaborators.ts/composite; binding DuplicatePathGroup[]
  onto WorkflowMap (optional `duplicateGroups?` field, confirm w/ E4); ONE shared budget counter across
  intent/naming/embedding passes.
- ≥85% cov; ≥3 evals in docs/sdlc/evals/duplicate-paths/ (true-dup-flagged / false-dup-rejected / transitive-guard);
  fix the sameness/README one-per-bucket over-claim. Security: M58.1-3 + T1/T2/T3/T8.

**Arch-review GATE PASS (PR #71, head fa862ce, 2026-06-27):** built to plan. projectA11ySkeleton extract is
behaviour-preserving (identify delegates; right seam, domain stays pure/no I/O). Detector precision is structural
(cross-identity-only + flag-time outcome-intent conflict gate resolves #57 transitive-veto should-fix w/o editing
refiner). Additive contracts clean (EmbeddingCachePort/DuplicatePathGroup/EmbeddingBudgetGuard). No SDK leak, no
collaborators.ts/WorkflowMap edit, no ADR drift. Coverage 100% line / 95.34% branch on sameness subtree (detector
branch 91.83% floor). #59 still owns: WorkflowMap.duplicateGroups? binding + collaborators wiring + shared budget.
