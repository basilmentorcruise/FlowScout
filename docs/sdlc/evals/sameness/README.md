# Evaluation Scenarios — Screen-embedding & label identity refinement (E3.4 / #57)

Per ADR-0001 §7 and ADR-0005 §4. These scenarios are encoded as runnable unit tests in
`packages/domain/src/__tests__/SamenessRefiner.test.ts` and
`packages/domain/src/__tests__/CompositeStateIdentityRefinement.test.ts`, and run in CI on
every PR. They define the correctness invariants of the **gated sameness cascade**: the
post-hoc, embedding+label refinement that MERGES a11y-distinct buckets that are the same
screen — while the synchronous E2 `identify` contract stays unchanged.

The cascade is a **recall floor → precision floor → label veto** sequence over the cosine
similarity of the (already-redacted) screen embeddings:

1. **degraded-embedding guard** — a missing / low-dimensional vector ⇒ a11y-only (no merge);
2. **precision floor** — cosine below the dead-band floor ⇒ keep distinct;
3. **dead-band** — cosine inside the uncertain band ⇒ keep distinct + record a tuning note;
4. **recall floor + label veto** — cosine ≥ threshold MERGES, unless confident labels conflict.

All scenarios are deterministic — driven by fixed vectors and labels (no network, no SDK, no
real embedding model). The real `EmbeddingPort` adapter is covered separately in
`packages/adapters/llm/src/__tests__/EmbeddingAdapter.test.ts`.

---

## EVAL-1: Same screen reached two ways → MERGE (recall floor)

**Scenario:** Two a11y-distinct buckets (different structural skeletons / hashes) describe the
same screen reached via two paths. Their redacted-skeleton embeddings point in near-identical
directions (cosine ≥ the merge threshold) and their semantic labels agree (or one is absent).

**Expected behavior:**

- The two buckets collapse into **one** equivalence class with a single canonical id
  (lexicographically-smallest member) — `identify(A)` and `identify(B)` resolve to the same
  refined identity downstream.
- An absent label on either side never vetoes the merge (absence ≠ conflict).

This is the primary **recall** invariant (ADR-0005 §4.3): E2's structural identity under-merges
the same screen across paths; E3.4 recovers those merges.

**Tests:**
`"merges two distinct buckets when cosine ≥ threshold and labels agree"`,
`"merges when one label is absent (absent never vetoes)"`.

---

## EVAL-2: Genuinely different screens → stay DISTINCT (precision floor + label veto)

**Scenario:** Two buckets whose embeddings are far apart (cosine below the dead-band floor),
plus a borderline pair whose cosine clears the threshold but whose **confident** semantic
labels conflict (e.g. `"Sign in"` vs `"Create account"`).

**Expected behavior:**

- Low-cosine pair: **no merge** — kept as separate classes.
- Borderline pair with conflicting confident labels: the **label veto** kills the merge
  (precision over recall), so the two screens stay distinct.
- Cosine in the dead-band `[floor, threshold)`: **no merge**, and a tuning note is recorded for
  offline threshold calibration (telemetry only — never a guessed merge).

This is the primary **precision** invariant (ADR-0005 §4.3): a near-collision in embedding
space must not silently fuse two different screens.

**Tests:**
`"keeps buckets distinct when cosine is below the dead-band floor"`,
`"vetoes a merge when confident labels conflict (above threshold)"`,
`"does NOT merge a cosine inside [0.92, 0.94) but records a tuning note"`.

---

## EVAL-3: NEVER-SPLIT + refinement-OFF == E2 (the safety invariants)

**Scenario:** Across varied fixtures (mergeable clusters mixed with spread-out singletons), and
with refinement toggled OFF.

**Expected behavior:**

- **NEVER-SPLIT:** the refined class count is **always ≤** the bucket (E2 node) count — the
  cascade can only ever MERGE, never partition an E2 bucket into finer nodes. Merges are
  transitive within a cluster but never invent a finer partition.
- **Refinement OFF == E2:** with refinement disabled the refiner returns **one singleton class
  per bucket**, byte-for-byte E2 behaviour — embeddings are ignored regardless of cosine.
- **Degraded embedding ⇒ a11y-only:** a missing or below-`MIN_EMBEDDING_DIM` vector never
  merges; the bucket falls back to its E2 identity (NFR6 — never a guessed merge, never a crash).
- **Synchronous `identify`:** `CompositeStateIdentityStrategy.identify(...)` still returns a
  `StateIdentity` value (not a `Promise`) and never throws — the async embedding work happens
  post-hoc, outside `identify` (ADR-0005 §4.2/§4.4).

This is the primary **safety** invariant: refinement is strictly additive and reversible to E2.

**Tests:**
`"class count is always ≤ bucket count across varied fixtures"`,
`"merge is transitive within a cluster but never invents a finer partition"`,
`"returns one singleton class per bucket regardless of cosine"`,
`"does not merge when a vector is missing"`,
`"does not merge when a vector is below MIN_EMBEDDING_DIM"` (SamenessRefiner suite), and
`"identify is synchronous — returns a StateIdentity value, not a Promise"`
(CompositeStateIdentityRefinement suite).

---

## Gated cascade (what the scenarios protect)

| Gate               | Condition                                      | Outcome                      |
| ------------------ | ---------------------------------------------- | ---------------------------- |
| Degraded-embedding | vector missing / `< MIN_EMBEDDING_DIM`         | a11y-only (no merge)         |
| Precision floor    | cosine `< dead-band floor`                     | distinct                     |
| Dead-band          | cosine in `[floor, threshold)`                 | distinct + tuning note       |
| Recall floor       | cosine `≥ threshold`                           | candidate MERGE              |
| Label veto         | confident labels conflict on a candidate merge | merge cancelled (distinct)   |
| Refinement OFF     | feature flag disabled                          | singleton per bucket (== E2) |

**Budget / cache / redaction invariants** (asserted in the sibling adapter + composition suites):

- **Budget / abort:** every embedding call is time-bounded by `timeoutMs` and forwards a per-call
  `AbortController`; the timeout timer is cleared on ALL settle paths (the #44 leak discipline,
  replicated from `LlmAdapter`). `EmbeddingAdapter.embed` **never throws** — failure / timeout /
  malformed ⇒ a DEGRADED empty-vector result that triggers a11y-only fallback (NFR6).
- **Cache:** the embedding cache key is the bucket's a11y `StateIdentity` (`EmbeddingInput.cacheKey`)
  — exactly ONE embedding per distinct bucket (ADR-0005 §4.4); re-encounters reuse the vector.
- **Redaction:** the embedding is computed over the NORMALIZED, ALREADY-REDACTED a11y skeleton
  text (the E2 `A11ySignatureStrategy` projection) — never the raw snapshot, never a screenshot.
  No raw credential / OTP / PII ever reaches the provider, the vector, the cache, or any log
  (NFR5 / T1/T7).
- **Provider isolation:** the provider SDK lives ONLY in `adapters/llm`; `application`/`domain`
  bind to the `EmbeddingPort` interface only (NFR1 — enforced by dependency-cruiser).
