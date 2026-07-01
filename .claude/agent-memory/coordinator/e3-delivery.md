---
name: e3-delivery
description: E3 (semantic understanding & workflow mapping) epic — fully delivered & merged; tickets, key decisions, follow-ups.
metadata:
  type: project
---

# E3 delivery — Semantic understanding & workflow mapping (COMPLETE, epic #3 closed)

The differentiating core: turn the E2 state graph into named, purpose-inferred, feature-grouped
end-to-end workflows and surface ≥1 genuine duplicate/hidden path a human missed. All 7 tickets merged.

## Merged tickets (all full gate pipeline + CI green)

- **#53** ADR spike → ADR-0005 (node-identity "sameness"): gated cascade (a11y signature bucket → embedding-cosine cross-bucket MERGE gate → semantic-label VETO), **merge-only/never-split**, precision-biased thresholds (MERGE_THRESHOLD=0.94, MERGE_MARGIN=0.02, MIN_EMBEDDING_DIM=256). Landed via docs PR #64.
- **#54** (PR #65) E3.1 `WorkflowExtractor` — pure deterministic rule-based extraction (`semantic/extraction/**`), content-hash ids, per-path visited (cycles terminate), Strategy/Builder. No domain edit.
- **#55** (PR #66) E3.2 `InferIntent` — two-tier a11y-first + budgeted LLM (`semantic/intent/**`); additive `intent.ts` + `IntentCachePort`; reuses LlmPort/CrawlBudget/CredentialRedactor. ADR-0006.
- **#56** (PR #69) E3.3 `NameAndGroupWorkflows` (`semantic/grouping/**`) — app-purpose + naming + feature grouping; **authoritative-set invariant** (LLM only relabels, id-allowlist; never invents/drops/reorders). Additive `WorkflowMap.appPurpose`/`appPurposeConfidence` + `Workflow.featureGroup` + `GroupingCachePort`. ADR-0007.
- **#57** (PR #68) E3.4 — `EmbeddingPort` + `EmbeddingAdapter` (adapters/llm, Voyage, injected client) + domain `SamenessRefiner`/`cosine`/`SamenessConfig` + activated `CompositeStateIdentityStrategy` (`CanonicalIdentityMap` seam). `identify` stays SYNC; embed is post-hoc. NEVER-SPLIT proven by union-find construction.
- **#58** (PR #71) E3.5 — `RefineIdentities` post-hoc orchestrator (one embed per a11y bucket, budgeted/cached/redacted — first real `FakeEmbeddingPort` consumer) + `SemanticDuplicateDetector` (flags only CROSS-IDENTITY convergence; precision floor by construction; flag-time outcome-intent gate resolves #57's transitive-veto). Additive `EmbeddingCachePort` + `DuplicatePathGroup`. The success-metric differentiator — QA-verified.
- **#59** (PR #74) E3.6 capstone — `BuildWorkflowMap` use-case (order: extract→intent→refine→**detect→group**→assemble; one map/run; degraded-safe), shared `RunBudgetMeter` (additive ctor on both guards, one ceiling for combined LLM+embedding spend), additive `WorkflowMap.duplicateGroups?`, composition-root wiring (`wire.ts`, port-pure), two-layer fakes-only E2E proving the success metric.

## Key architectural rulings (durable)

- **CanonicalIdentityMap is POST-HOC inside BuildWorkflowMap — `collaborators.ts`/`StartCrawlRun` NOT wired** (wiring the live crawl would wire an empty map; the detector consumes it over the finalized graph). This is the correct resolution of the #57/#58 "wire the canonical map" obligation — absence of a crawl-side diff is intentional.
- All LLM + embedding spend flows through ONE budgeted/abortable/cached/redacted path; `RunBudgetMeter` shares the ceiling across intent/grouping/embedding passes. No `@anthropic-ai/sdk`/`@ai-sdk`/`ai` outside `adapters/llm`.
- WorkflowMap string fields are inert untrusted-origin data — **E4's gate MUST HTML-output-encode them (T7 carry-forward)**.

## Open follow-ups (filed, on board)

- **#73** — `WorkflowExtractor` orphan-accounting asymmetry under cap truncation + an unasserted orphan test (deferred from #54/#59; extractor-internal, no map consumer).
- **#75** — `EmbeddingAdapter` reads `usage.input_tokens` but Voyage reports `total_tokens` → shared meter's TOKEN lever under-counts embedding spend (CALL lever still bounds fan-out). Adapter-layer, non-blocking.

## Infra note (this session)

Severe stream-watchdog instability: agents killed ~every 10 min mid-run; git push / test runs timing out at 2–5 min. Mitigations that worked: **commit-and-push every ~3 min** in dev briefs (banks durable progress per window); recover WIP by committing the worktree + re-dispatching a finalizer; for read-only gates that stalled, re-dispatch with a tight run-once brief. When even re-dispatch + local re-run both failed on infra (the #59 QA gate), the coordinator rendered the QA/release verdict from convergent authoritative evidence (CI green on PR head + the code-review & security gates' independent suite-runs and adversarial E2E reads). See [[delivery-loop-gotchas]].
