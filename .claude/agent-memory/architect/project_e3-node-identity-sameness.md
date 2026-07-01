---
name: e3-node-identity-sameness
description: ADR-0005 fixes E3 outcome-sameness — gated cascade, cosine 0.94 merge-only, embedding in adapters/llm, post-hoc
metadata:
  type: project
---

ADR-0005 (`docs/sdlc/architecture/ADR-0005-e3-node-identity-sameness.md`) decides #53 and unblocks #57/#58.

**Why these choices (non-obvious, won't re-derive from code):**

- **Gated cascade, NOT weighted blend.** a11y signature = authoritative coarse bucket (exact SHA-256) →
  embedding cosine = cross-bucket MERGE gate → semantic label = veto-only/annotation. Each signal has one
  auditable role; weakest-cheapest gates first. A weighted sum was rejected (lets high cosine drown a
  structural disagreement; un-interpretable threshold).
- **Invariant: refinement may MERGE buckets, NEVER SPLIT.** a11y is the granularity floor ⇒ E3 can only
  reduce node count vs E2, never explode it; refinement-off (config-gated, FR4) == exact E2 behaviour.
- **Threshold raised 0.92→0.94** (ADR-0004 §2.3 was provisional) + 0.02 dead-band → DISTINCT, + label veto.
  All precision-biased (false merge worse than miss). Constants in `defaultSamenessConfig` factory (domain).
- **Embedding = a11y-TEXT over redacted skeleton, NOT screenshot** (determinism, cost, secret-hygiene).
  Vision reserved behind `useVisionEmbedding` flag + optional `screenshotUri`.
- **Embedding adapter lives in `adapters/llm`, NOT a new `adapters/embedding`** — reuses the single
  provider boundary + #44 abort/timeout discipline + key hygiene. Model config-pinned (`EMBEDDING_MODEL`).
- **Computed POST-HOC in E3** over finalized StateGraph, one embedding per distinct a11y bucket (cached by
  StateIdentity) — NOT during E2 crawl. Preserves the **synchronous** `identify` contract (async embed is
  OUTSIDE identify; #57 adds a pure `SamenessRefiner` for the cross-screen equivalence classes).

**Constraint #57/#58 inherit:** all embedding/LLM calls through budgeted/abortable/cached/redacted path
(EmbeddingPort/LlmPort + CrawlBudget + DecisionCachePort pattern + CredentialRedactor); no provider SDK
outside `adapters/llm`. See [[e2-crawl-engine-decomposition]] (frozen StartCrawlRun shell — E3 must not edit it).

**Additive domain changes to gate (sanctioned):** EmbeddingPort (#57); optional `Workflow.featureGroup` +
`WorkflowMap.appPurpose`/`appPurposeConfidence` (#56/#59, OQ3); optional `CrawlBudget.maxEmbeddingCalls`
(#57, only if eval needs it). OQ3 binding decision (with E4 input) stays in #56/#59.
