---
name: e3-57-refinement-seam
description: #57 landed building-blocks+seam (PASS); post-hoc embedding ORCHESTRATOR deferred to #58 producer + #59 root-wiring — gate it there
metadata:
  type: project
---

PR #68 / ticket #57 (E3.4 screen-embedding + label identity refinement) PASSED arch gate (2026-06-27).

**What landed (correct, safe, ≥85% cov):** `EmbeddingPort` (domain), `EmbeddingAdapter` (adapters/llm,
injected `EmbeddingClientLike`, no SDK import, #44 abort+timeout-clear-on-finally, never-throws→degraded
empty vector), pure-domain `cosine`/`SamenessConfig`(0.94/0.02/256)/`SamenessRefiner` (union-find,
lexicographically-smallest canonical, merge-only), `CompositeStateIdentityStrategy` activated with an
optional read-only `CanonicalIdentityMap` seam, `FakeEmbeddingPort`. composite in `collaborators.ts:143`
is wired with NO canonical map ⇒ defaults to exact E2 (no behavioral merge happens yet).

**Adjudication (the load-bearing call):** ADR-0005 §4.4/§8 names "the post-hoc embedding pass" as a #57
deliverable, but the ORCHESTRATOR is absent (the application use-case that walks the finalized StateGraph's
distinct buckets, calls budgeted/redacted `EmbeddingPort.embed` ONCE per bucket cached by StateIdentity,
builds `SamenessRefiner`, emits the equivalence classes/`CanonicalIdentityMap`). Ruled **acceptably
deferred, NOT a FAIL** — delivered slice is correct, safe-by-default (merge-only + config-gated + E2
fallback ⇒ nothing can misfire until orchestrator runs), seam is exactly the ADR's reserved one. FAIL would
be churn, not risk reduction. Same seam-now/activate-in-consumer precedent as [[e2-decision-policy-chain]].
**Why:** a gate fails on wrong/unsafe/risky drift, not on a correct building-block slice whose activation
is better cohered with its consumer. **How to apply:** when gating #58/#59, these are tracked obligations —
do NOT let them silently drop (epic success metric depends on the merge actually running):

- **#58 (producer):** build the post-hoc orchestrator use-case (it is #58's input-producer — #58 consumes
  the equivalence classes it emits). Carries the `FakeEmbeddingPort` (currently imported by ZERO tests) +
  the "one-embedding-per-distinct-bucket" cache assertion + UsageReporter budget feed.
- **#59 (capstone):** wire the resulting `CanonicalIdentityMap` into the live crawl collaborators
  (`collaborators.ts` — today passes no map).

**Two should-fixes routed to #58 (not blockers):**

1. **Transitive label-veto bypass:** veto is applied PAIRWISE in `applyCascade` then union-find unions —
   an A–B merge vetoed by conflicting labels can still land in one class via an unlabeled middle C
   (A–C, C–B each clear 0.94 + don't veto ⇒ transitive A≡B). Bounded by merge-only (precision erosion, not
   a split/crash) + raised gate. Tune/measure on #58's convergent-path eval fixture.
2. **Eval README over-claim:** `docs/sdlc/evals/sameness/README.md` says the budget/cache one-per-bucket
   invariant is "asserted in the sibling adapter + composition suites" — it is NOT (no orchestrator; fake
   unused). That assertion travels with the orchestrator into #58.

**No ADR drift otherwise:** thresholds match §3; no `CrawlBudget.maxEmbeddingCalls` added (correctly
deferred per §5 — only if eval needs); frozen StartCrawlRun/CrawlLoop untouched; `identify` stays sync;
no provider SDK outside adapters/llm. `voyage-3` as `DEFAULT_EMBEDDING_MODEL_ID` (adapters layer,
EMBEDDING_MODEL/root-overridable) is consistent with §4.3's "thin seam over whichever embedding endpoint
is wired at the root" (Anthropic has no first-party embeddings; Voyage is the sanctioned partner).
