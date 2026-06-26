# ADR-0005 — E3 Node-Identity "Sameness": Tree Signature + Screen Embedding + Semantic Label

- **Status:** Accepted
- **Date:** 2026-06-26
- **Mode:** plan (per-epic refinement of ADR-0001 / ADR-0004 for Epic E3)
- **Ticket:** #53 (architecture ADR spike — architect-owned; no product code authored here)
- **Scope:** Epic E3 (#3) — the **outcome "sameness"** decision that unblocks duplicate/hidden-path
  detection (the success-metric differentiator). Fixes the composition of the three identity signals
  (a11y-tree signature + screen embedding + semantic label), the weighting/precedence, the decision rule,
  the concrete sameness threshold (replacing ADR-0004 §2.3's provisional cosine ≥ 0.92), the embedding
  model/provider/port, where embeddings are computed, and the budget/abort discipline E3 inherits.
- **Refines, does not supersede:** ADR-0001 (stack & reference architecture, R1 state-identity risk),
  ADR-0004 (E2 crawl engine — §2.3 composition seam, §3 LLM budget/cache discipline, the #44 abort fix).
  Every ADR-0001 / ADR-0004 invariant holds: the semantic engine lives in `application`/`domain` and
  depends **only on domain ports** — never `adapters/*`, never a provider SDK directly (NFR1,
  dependency-cruiser §6). Provider SDKs stay confined to their adapter package.
- **Decides:** PRD-e3 OQ1 (sameness composition + threshold + embedding model), OQ2 (LLM/embedding reuse
  the budgeted path), OQ4 (embedding source + where computed). **OQ3** (purpose/feature-group on the
  consumer contract) is touched here only to fix the additive shape; the binding E4-input decision stays
  with #56/#59.
- **Out of scope (boundaries, not designed here):** the workflow extractor (#54), intent inference (#55),
  naming/grouping (#56), the durable store (E7), the report (E4). This ADR fixes the **algorithm + ports +
  thresholds**; #57 and #58 implement them.

---

## 1. Context — what actually exists (grounding)

E2 is delivered (#31–#37). The E3 seams this ADR builds on are **already in the tree**, not hypothetical:

- **`packages/domain/src/ports/StateIdentityPort.ts`** — `StateIdentityInput` already carries the two
  additive E3 inputs as **optional** fields: `screenEmbedding?: readonly number[]` and
  `semanticLabel?: string`. The `StateIdentityStrategy.identify(input): StateIdentity` contract is
  **synchronous, deterministic, never-throws**. This is the frozen seam #57 extends.
- **`packages/domain/src/models/state-identity/A11ySignatureStrategy.ts`** — the E2 default: parses the
  a11y snapshot, projects each node to a `(role, stable-key)` structural token, normalizes volatile
  content (digit runs → `#`, timestamps → `<ts>`, currency/% → `<num>`), collapses repeated sibling rows
  (`MAX_SIBLING_ROWS = 3`), depth-bounds (`MAX_DEPTH = 10`), SHA-256s the skeleton, and has a degraded
  path that never throws. **This is the authoritative coarse bucket.** It is pure, free, deterministic.
- **`packages/domain/src/models/state-identity/CompositeStateIdentityStrategy.ts`** — today wraps a single
  `_primary` strategy and delegates fully (`identify` returns `_primary.identify(input)`). The class
  docstring already reserves the embedding-merge step for E3. **This is the composition seam #57 activates.**
- **`packages/domain/src/ports/DecisionCachePort.ts`** — `get(stateId)/set(stateId, decision)`, in-memory
  impl in `application` (`crawl/policy/InMemoryDecisionCache.ts`), swappable to persistent in E7. T7: stores
  redacted representations only.
- **`packages/adapters/llm/src/LlmAdapter.ts`** — the **only** sanctioned LLM path: `@anthropic-ai/sdk`
  exact-pinned and confined to this file, per-call `AbortController` forwarded to the SDK, timeout timer
  cleared on all settle paths (the #44 abort/leak fix), API key env-only/never-logged, no message bodies
  logged, token counts surfaced via `LlmCompletionResult`.
- **`packages/application/src/crawl/redaction/CredentialRedactor.ts`** — the single redaction boundary
  (`redact(raw)`), applied at the snapshot source before any sink. The E3 pattern E2 established.
- **`packages/application/src/crawl/duplicate/DuplicatePathDetector.ts`** — E2's **structural** detector:
  a node reached via >1 distinct `fromId` (O(E)). Its docstring explicitly defers **semantic** sameness to
  E3. #58 is the semantic complement, not a rewrite.
- **`packages/domain/src/models/workflow.ts`** — `WorkflowMap { runId, workflows, finalisedAt }`,
  `Workflow { id, name, description, steps, isHiddenPath, inferenceConfidence }`. The consumer contract E4
  builds against. Has no app-purpose / feature-group field yet (OQ3).

**Key constraint surfaced by grounding:** `StateIdentityStrategy.identify` is **synchronous**. An
embedding fetched from a provider is **async**. Therefore the embedding **must not be computed inside
`identify`** — the vector is passed in via `StateIdentityInput.screenEmbedding`, already computed. This is
why OQ4 ("where is the embedding computed") is load-bearing, and the ADR answers it in §4: embeddings are
produced **post-hoc in E3**, before identity refinement, through an async embedding port; the synchronous
`identify` contract is preserved unchanged (no domain-port signature break).

---

## 2. OQ1 — Outcome "sameness" composition, precedence, decision rule (the core decision)

### 2.1 Composition — a **gated cascade**, not a weighted blend

The three signals are **not** averaged into one similarity score. They are applied as a **gated cascade**
(a Chain of Responsibility over identity, mirroring the E2 DecisionPolicy chain). Precedence is fixed:

```
A11y structural signature  ──▶  the AUTHORITATIVE COARSE BUCKET (exact SHA-256 match)
        │  (two screens already share a bucket)            → SAME. Done. No embedding call.
        │  (two screens are in DIFFERENT buckets)
        ▼
Screen embedding (cosine)  ──▶  the CROSS-BUCKET MERGE GATE
        │  cosine < MERGE_THRESHOLD                         → DISTINCT. Done. (precision: do NOT merge)
        │  cosine ≥ MERGE_THRESHOLD                         → CANDIDATE MERGE → consult next gate
        ▼
Semantic label            ──▶  the TIE-BREAK / CONFIRMATION GATE (annotation, never the primary key)
        │  labels agree (or one absent)                     → MERGE the two buckets
        │  labels conflict (distinct, confident, disagree)  → VETO the merge → keep DISTINCT
```

**Why a gated cascade and not a weighted sum.** A weighted blend (`w1·a11y + w2·emb + w3·label`) lets a
high embedding score _drown out_ a structural disagreement, and makes the threshold un-interpretable
("0.84 of what?"). The success metric demands **precision over recall** — a false merge is worse than a
miss. A cascade gives each signal an explicit, auditable role and lets the **weakest-but-cheapest signal
gate first**: the a11y hash (free, deterministic) decides the common case with zero cost; the embedding is
consulted **only across buckets**; the label can only ever **veto** a merge, never _create_ one. That
asymmetry is the precision bias, stated as a rule rather than a number.

### 2.2 Precedence & roles (fixed)

| Signal               | Role                                     | May it MERGE buckets?          | May it SPLIT a bucket?                             | Cost                                           |
| -------------------- | ---------------------------------------- | ------------------------------ | -------------------------------------------------- | ---------------------------------------------- |
| **A11y signature**   | Authoritative coarse bucket (exact hash) | — (it _defines_ buckets)       | —                                                  | free, sync                                     |
| **Screen embedding** | Cross-bucket merge gate (cosine)         | **Yes**, if ≥ threshold        | **Never**                                          | 1 embedding/screen, async, budgeted            |
| **Semantic label**   | Tie-break / merge **veto** + annotation  | **No** (cannot create a merge) | **Never splits**; only **vetoes a proposed merge** | free if reused from intent (#55); else 0 extra |

**Invariant (from the PRD AC and #53 AC): a refinement may MERGE buckets but MUST NEVER SPLIT one.**
The a11y signature is the floor of granularity. Embeddings + labels only ever _coarsen_ (merge) the
partition; they never _refine_ it into more buckets. This guarantees E3 can only ever **reduce** the node
count relative to E2, never explode it — and that re-running with refinement **off** (config-gated, FR4)
yields exactly E2 behaviour.

### 2.3 The decision rule (precise)

Two screens `A`, `B` are judged the **same outcome** iff:

1. `sig(A) == sig(B)` (exact a11y-signature match) — **OR** —
2. `sig(A) != sig(B)` **AND** `cosine(emb(A), emb(B)) ≥ MERGE_THRESHOLD` **AND** the semantic-label gate
   does not veto (labels are absent, equal after normalization, or non-confident).

A merge in case (2) unions the two a11y buckets into one **identity equivalence class**. The canonical
identity of the class is the **lexicographically-smallest a11y signature** in the class (deterministic,
stable across runs — no dependence on visit order). #57 produces the class; #58 consumes it.

---

## 3. OQ1 — Thresholds (concrete, tunable, precision-biased)

ADR-0004 §2.3 recorded a **provisional** merge threshold of cosine ≥ 0.92 "to tune". This ADR **fixes the
defaults** and the **band** around the threshold, biased hard toward precision. All are **named config
constants** (no magic numbers, ADR-0001 §6), defaulted in a `defaultSamenessConfig` factory in `domain`,
overridable at the composition root.

| Constant             | Default  | Rationale                                                                                                                                                                                                                                                                                                              |
| -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MERGE_THRESHOLD`    | **0.94** | The cross-bucket merge gate. **Raised from the provisional 0.92** because precision dominates recall (a false duplicate corrupts the differentiator). 0.94 demands near-identical screen vectors before crossing a structural-signature disagreement.                                                                  |
| `MERGE_MARGIN`       | **0.02** | A **dead-band**: scores in `[MERGE_THRESHOLD − MERGE_MARGIN, MERGE_THRESHOLD)` (i.e. `[0.92, 0.94)`) are **"uncertain" → DISTINCT** (do not merge) but recorded with a low-confidence telemetry note for eval tuning. The band prevents threshold-edge flapping and surfaces tuning candidates without acting on them. |
| `LABEL_VETO_ENABLED` | **true** | The label gate is on by default: a confident, normalized label disagreement **vetoes** a borderline embedding merge. Pure precision guard.                                                                                                                                                                             |
| `MIN_EMBEDDING_DIM`  | **256**  | Reject/degrade vectors below this dimensionality (a degenerate embedding must not silently merge everything).                                                                                                                                                                                                          |

**How the design biases precision over recall (stated explicitly, per #53 AC):**

1. **Embeddings can only merge, never split** — the worst an over-merge can do is bounded; the a11y floor
   means genuinely-different _structures_ already sit in different buckets and need an _active_ high-cosine
   crossing to merge.
2. **The merge gate is raised (0.94) and one-directional** — the default leans toward _keeping screens
   distinct_. A miss (two same-outcome screens left distinct) degrades to E2 behaviour (two nodes); a false
   merge (two different outcomes fused) is the costly error the gate is tuned to avoid.
3. **The label gate can only veto, never create** — it removes false merges; it cannot manufacture them.
4. **The dead-band** routes ambiguous scores to DISTINCT, not MERGE.
5. **Degraded embeddings degrade to a11y-only** — a missing/low-dim/NaN vector means the cascade stops at
   the a11y bucket (case 1 only), never a guessed merge (NFR6).

### 3.1 Eval scenarios (≥3, bite in CI) — `docs/sdlc/evals/node-identity-sameness/`

#57/#58 ship these as fixture-driven eval tests (the §2.3-style harness ADR-0004 established for
state-identity). The fakes provide **seeded deterministic embeddings** — no live provider:

1. **True merge (recall floor):** "Settings" reached from a tab bar vs. from a deep-linked overflow menu —
   **different** a11y signatures, **cosine ≥ 0.94**, labels agree ⇒ **MERGE** (the PRD's headline case).
2. **True distinct (precision floor):** two visually/structurally similar but genuinely different outcomes
   (e.g. "Order confirmed" vs "Order cancelled" — same chrome, different result) — cosine **below** 0.94 ⇒
   **DISTINCT** (the false-positive guard; PRD edge case "coincidentally-similar but different").
3. **Label veto:** different buckets, cosine in `[0.94, ...)` but confident **conflicting** labels
   ("Login" vs "Create account") ⇒ veto ⇒ **DISTINCT**.
4. **Dead-band:** cosine `0.93` (inside `[0.92, 0.94)`) ⇒ **DISTINCT** + low-confidence telemetry note.
5. **Degraded embedding:** missing/`MIN_EMBEDDING_DIM`-violating vector ⇒ falls back to a11y-only, never
   crashes, never guesses a merge (NFR6).
6. **Volatile-content tolerance (inherited):** dynamic outcome screen (content changes each visit) — same
   a11y signature via E2 normalization ⇒ same bucket, no embedding call needed (PRD edge case).

Acceptance: scenarios 1–4 + 6 must pass; #58's success-metric AC ("≥1 genuine duplicate/hidden path") is
proven structurally against the multi-screen fixture graph that includes a convergent same-outcome path.

---

## 4. OQ4 — Embedding model, port, adapter home, and _where computed_

### 4.1 Source: **a11y-text embedding** for the MVP; vision is a config-gated, deferred add

The embedding vector is produced from the **normalized, redacted a11y skeleton** (the same projection
`A11ySignatureStrategy` already builds — role/key tokens with volatile content suppressed and credentials
redacted), **not** the screenshot, for the MVP. Reasons:

- **Determinism & testability (NFR2):** text embeddings over the already-deterministic skeleton are
  reproducible; screenshot pixels are not (anti-aliasing, dynamic content, simulator chrome).
- **Cost & latency (NFR3):** a11y-text embeddings are an order of magnitude cheaper than vision and reuse
  the projection the engine already computes.
- **Secret hygiene (NFR5):** the skeleton is already redacted by `CredentialRedactor`; a screenshot can
  leak typed secrets/PII that are far harder to scrub. Embedding the redacted text keeps the redaction
  boundary intact.
- **Vision is reserved, not removed:** a `useVisionEmbedding` config flag (default `false`) and the port's
  `EmbeddingInput` carrying an **optional** `screenshotUri` keep the door open for a vision adapter without
  a contract change (Open/Closed). MVP ships text-only.

### 4.2 The embedding port (new domain port, additive — #57 implements against the fake)

A new domain port. **Async** (provider call), distinct from the synchronous `StateIdentityStrategy`:

```ts
// packages/domain/src/ports/EmbeddingPort.ts   (#57 lands; additive — flag to arch-review gate)
export interface EmbeddingInput {
  /** The normalized, REDACTED a11y skeleton text (NOT the raw snapshot). Mandatory. */
  readonly skeletonText: string;
  /** Optional screenshot URI — reserved for a vision embedding adapter (default unused). */
  readonly screenshotUri?: string;
  /** Stable cache key (the a11y StateIdentity) so re-encounters reuse the vector. */
  readonly cacheKey: StateIdentity;
}

export interface EmbeddingResult {
  /** The screen embedding vector. Empty array signals a degraded/unavailable embedding. */
  readonly vector: readonly number[];
  /** Provider model id (telemetry / cache invalidation). */
  readonly modelId: string;
}

export interface EmbeddingPort {
  /**
   * Compute a screen embedding. MUST be budget-counted and time-bounded by the
   * adapter (mirrors LlmAdapter). MUST never throw — returns an empty-vector
   * EmbeddingResult on failure/timeout (caller falls back to a11y-only, NFR6).
   */
  embed(input: EmbeddingInput): Promise<EmbeddingResult>;
}
```

The port returns a **degraded empty vector** rather than throwing, exactly like the LLM resilience path —
so a provider outage degrades E3 to E2 (a11y-only) identity, never a crash.

### 4.3 Provider/model & adapter home: **`adapters/llm`**, not a new `adapters/embedding`

**Decision: the embedding adapter lives in `packages/adapters/llm`** (the existing provider-SDK adapter),
**not** a new `adapters/embedding` package.

- **Why reuse `adapters/llm`:** the chosen provider is **Anthropic** (CLAUDE.md / ADR-0004 §3.1 mandate the
  current Claude stack), and the embedding adapter shares the _same_ governance the LLM adapter already has
  — exact-pinned SDK, API-key-env-only, per-call `AbortController` + timeout (the #44 pattern), token/usage
  surfacing, no-body-logging. A separate package would duplicate all of that, add a second provider-key
  surface, and tempt a parallel budget path. `adapters/llm` is already the **single provider boundary**;
  embeddings belong inside it as `EmbeddingAdapter.ts` alongside `LlmAdapter.ts`.
- **Model:** **config-pinned, not a constant** — `EMBEDDING_MODEL` env → adapter config, default the
  current Anthropic-stack embedding model id (resolved at the composition root, same pattern as
  `LLM_MODEL`/`DEFAULT_MODEL_ID`). If the provider's first-party embedding offering is unavailable at build
  time, the adapter is a **thin seam over whichever embedding endpoint is wired at the root** — the _port_
  is the contract #57 builds against; the concrete model id is a root-level config decision, never hardcoded
  in `application`/`domain`. dependency-cruiser already confines any provider SDK to `adapters/*`; no new
  rule needed (the existing `no-inward-adapter-dep` + `application-depends-only-on-domain` cover it).
- **The dimensionality (`MIN_EMBEDDING_DIM`) and cosine math live in `domain`** (pure, deterministic,
  `CompositeStateIdentityStrategy` consumes a vector and computes cosine — no SDK). Only the _production_ of
  the vector is in the adapter.

### 4.4 Where computed: **post-hoc in E3**, not during the E2 crawl

**Decision: embeddings are computed post-hoc in E3, over the finalized `StateGraph`, NOT during the E2
crawl loop.** This is the OQ4 answer:

- **The E2 crawl loop ships unchanged** — no `StartCrawlRun`/`CrawlLoop` edit (ADR-0004 §7 froze that
  shell). E2's hot path stays embedding-free, preserving its cache-first cost philosophy.
- **E3 walks the finalized graph's distinct a11y buckets** and computes **one embedding per distinct
  a11y signature** (not per visit) — embeddings are cached by the a11y `StateIdentity` (the
  `EmbeddingInput.cacheKey`), so a graph with 40 distinct screens costs **at most 40** embedding calls
  regardless of visit count. This is the NFR3 cost win and why post-hoc beats per-visit.
- **Synchronous `identify` is preserved:** #57's flow is (a) E3 async-computes the per-bucket embeddings up
  front, (b) attaches each as `StateIdentityInput.screenEmbedding`, (c) calls the **synchronous**
  `CompositeStateIdentityStrategy.identify` to refine. The async work is _outside_ `identify`; the domain
  port signature is untouched.

---

## 5. OQ2 — Budget / abort discipline E3 inherits (the hard constraint #57/#58 inherit)

**All embedding and any semantic LLM/vision call in E3 MUST flow through the existing budgeted, abortable,
cached, redacted path. No new uncontrolled path. This is a constraint, not a suggestion.**

- **No `@anthropic-ai/sdk` (or any provider SDK) outside `adapters/llm`.** The `EmbeddingPort` and
  `LlmPort` are the only ways `application`/`domain` reach a provider. dependency-cruiser enforces it
  (existing rules; CI gate, NFR1/NFR7).
- **Budget-counted:** every embedding call and every semantic LLM call counts against the same
  `CrawlBudget` (`maxLlmCalls` / `maxTokens`) via the `UsageReporter` collaborator pattern E2 established
  (`packages/application/src/crawl/UsageReporter.ts`). E3 adds embedding token/call usage to the same feed;
  the engine never names the concrete adapter. Hitting the budget **finalizes inference gracefully** with
  whatever was inferred (degraded, not crashed — NFR6). _(Coordinator note: if `CrawlBudget` needs a
  separate `maxEmbeddingCalls` knob rather than folding into `maxLlmCalls`, that is a small additive
  `run.ts` field for #57 to flag to the arch-review gate — additive-only, mirroring ADR-0004 §3.6's
  `plateauWindow` addition. Default: fold into the existing `maxLlmCalls`/`maxTokens` ceiling; split only
  if eval shows embedding volume needs independent bounding.)_
- **Time-bounded / abortable:** the `EmbeddingAdapter` MUST replicate `LlmAdapter`'s per-call
  `AbortController` + timeout-cleared-on-all-paths discipline (the #44 fix). A hung embedding call aborts
  and degrades to a11y-only.
- **Cache-first:** embeddings and semantic inferences are cached by a stable key. The embedding cache key
  is the a11y `StateIdentity` (one vector per bucket, §4.4). Semantic-label/intent inferences reuse the
  `DecisionCachePort` pattern (a sibling `SemanticCachePort` may be added additively by #56/#58 if the
  `PolicyDecision`-shaped cache value doesn't fit — additive, flag to gate). Re-runs reuse inference; the
  key must not preclude E7 persistence (it doesn't — it's `StateIdentity`-keyed like `DecisionCachePort`).
- **Redacted:** the embedding input is the **already-redacted** a11y skeleton (`CredentialRedactor`
  applied at the snapshot source in E2, §1). No raw a11y body, no credential/OTP/typed-secret text, no PII
  ever reaches the embedding or LLM prompt, the vector, the cache, the `WorkflowMap`, intent strings, or
  logs (NFR5). The vector itself is non-reversible numeric data over redacted text.

---

## 6. OQ3 — Carrying app-purpose + feature-group (additive shape only)

This ADR confirms the **shape** so #57/#58 don't block on it; the binding decision (with E4 input) stays
in #56/#59. **Decision: additive optional fields, no wrapper, no overload of `description`:**

- `Workflow` gains `readonly featureGroup?: string` (optional) — the feature group a workflow belongs to.
- `WorkflowMap` gains `readonly appPurpose?: string` and `readonly appPurposeConfidence?: ConfidenceScore`
  (optional) — the inferred one-line app purpose + its confidence.

All **additive optional** — zero break to the fields E4 already builds against (`runId`, `workflows`,
`name`, `description`, `steps`, `isHiddenPath`, `inferenceConfidence`, `finalisedAt`). This satisfies the
PRD "additive-only, no breaking change" and "must not overload `description`" constraints. **Flag to the
arch-review gate as a sanctioned additive domain change** (same category as ADR-0004's additive ports).
#56 authors these fields; #59 confirms with E4 before the capstone.

---

## 7. Seam confirmation — the right extension points, and how #57 activates them

**Confirmed: the existing seams are the correct extension points. No new port shape and no loop edit are
required to activate sameness.**

- **`StateIdentityInput.screenEmbedding` / `.semanticLabel`** (already optional) — #57 populates these.
  No port-signature change (the fields exist).
- **`CompositeStateIdentityStrategy`** — today a pass-through to `_primary`. #57 **activates the merge
  step inside it**: it keeps `_primary` (the `A11ySignatureStrategy`) as the bucket source, and adds the
  embedding cosine + label-veto cascade (§2) over a supplied **bucket index** so it can union across
  buckets. Because `identify` is per-screen and merging is cross-screen, #57 introduces a thin
  **`SamenessRefiner`** (domain, pure) that takes the set of `(bucketSignature, embedding, label)` for a
  run and returns the **equivalence classes** (§2.3 canonical-id rule); `CompositeStateIdentityStrategy`
  consults the refiner's class map. The `StateIdentityStrategy` _port_ is unchanged; the composite's
  _internals_ gain the refiner. This honours ADR-0004 §2.3's reserved seam exactly.
- **Activation path (#57):** at the E3 use-case (not the E2 loop), over the finalized `StateGraph`:
  (1) for each distinct a11y bucket, async-`embed` the redacted skeleton (budgeted, cached, §5);
  (2) build the `SamenessRefiner` from `(signature, vector, label?)`; (3) the refiner emits identity
  equivalence classes per §2.3; (4) downstream (#58) consumes classes as "same outcome". **Config-gated
  (FR4):** refinement off ⇒ classes are singletons ⇒ exact E2 behaviour.
- **No `StartCrawlRun` / `CrawlLoop` edit** — the E2 frozen shell (ADR-0004 §7) is untouched; E3 is a new
  application use-case over the graph the loop produced.

---

## 8. Implications — what #57 and #58 are cleared to build

### #57 (E3.4 — screen-embedding + semantic-label identity refinement)

**Builds:**

- `packages/domain/src/ports/EmbeddingPort.ts` (§4.2, additive port + barrel export).
- `packages/adapters/llm/src/EmbeddingAdapter.ts` (§4.3) — async, budgeted, abortable (the #44 pattern),
  token-surfacing, no-body-logging; config-pinned `EMBEDDING_MODEL`; a deterministic **fake** for tests.
- `domain` cosine + `defaultSamenessConfig` factory (§3 constants) + the pure `SamenessRefiner` (§7) and
  the activated merge step in `CompositeStateIdentityStrategy` (§2 cascade, §2.3 canonical-id).
- The post-hoc embedding pass (§4.4): one embedding per distinct a11y bucket, cached by `StateIdentity`.
- `docs/sdlc/evals/node-identity-sameness/` scenarios 1, 3, 4, 5, 6 (§3.1).

**Acceptance bar:** distinct-a11y-bucket screens with cosine ≥ 0.94 and non-conflicting labels **merge**;
borderline/dead-band/label-conflict/degraded cases stay **distinct** (precision); refinement is
**config-gated** (off ⇒ E2 behaviour); **all** embedding/LLM calls go through the budgeted/abortable/cached/
redacted path (§5) with **no provider SDK outside `adapters/llm`**; `identify` stays synchronous and
never-throws; coverage ≥ 85% line+branch on the new `application`/`domain` logic, adapter via contract test
with the fake. Boundaries/cruiser/cycles/duplication/coverage/gitleaks green (NFR7).

### #58 (E3.5 — semantic duplicate / hidden-path detection, the differentiator)

**Builds:** a semantic detector that, given the finalized `StateGraph`, the extracted `Workflow[]` (#54),
outcome-node intent (#55), and #57's **identity equivalence classes** (§7), flags two workflows reaching
the **same semantic outcome** despite distinct E2 identities — marking the less-prominent route
`isHiddenPath = true` and associating the converging workflows (so E4 can render "these N paths reach the
same place"). It is the **semantic complement** to E2's structural `DuplicatePathDetector` (§1), not a
rewrite of it.

**Acceptance bar:** on the multi-screen fixture graph (with a convergent same-outcome path + a genuinely
different-but-similar pair), **≥1 genuine duplicate/hidden path flagged** AND the different-but-similar pair
**not** falsely flagged (the precision floor — eval scenario 2 + the success metric). Deterministic with a
fake `EmbeddingPort` + fake `LlmPort` (no live provider, no simulator). Same budget/redaction/boundary
constraints as #57 (§5). Coverage ≥ 85%; gates green.

---

## 9. Consequences & risks

- **Positive:** OQ1/OQ2/OQ4 are concrete; #57/#58 have a fixed algorithm, threshold, port, and budget
  discipline — no open question remains for them. The gated cascade is precision-biased _by construction_
  (merge-only, raised threshold, veto-only label, dead-band, degrade-to-a11y). The E2 crawl shell and the
  synchronous `identify` contract are untouched (post-hoc, async-outside-`identify`). One embedding per
  distinct bucket keeps cost ≪ visit count (NFR3). Refinement is config-gated to exact E2 fallback.
- **R-1 (threshold is fixture-tuned, ADR-0001 R1 inherited):** 0.94 / 0.02 are documented starting points
  tuned on the fixture, not yet a real app. **Mitigation:** all are `defaultSamenessConfig` config; the
  dead-band surfaces tuning candidates as telemetry without acting on them; re-tuned in the eval scenarios
  on a representative app. The merge-only invariant bounds the blast radius of a mis-tuned threshold (worst
  case = under-merge = E2 behaviour, the safe direction).
- **R-2 (provider embedding-model availability):** the concrete Anthropic-stack embedding model id is a
  composition-root config decision; if unavailable, the root wires whichever embedding endpoint is current.
  **Mitigation:** `application`/`domain` bind to `EmbeddingPort`, never a model id; the fake covers all CI.
  A model swap is a single root-config line (Open/Closed, mirrors `LLM_MODEL`).
- **R-3 (additive domain changes):** `EmbeddingPort` (#57), the optional `Workflow.featureGroup` /
  `WorkflowMap.appPurpose*` fields (#56/#59), and any optional `CrawlBudget.maxEmbeddingCalls` (#57 if
  needed) are **additive-only** — flag each to the arch-review gate (sanctioned here, no existing contract
  broken), exactly as ADR-0004 §8 handled E2's additive ports. Anything **beyond** additive (e.g. making
  `identify` async, or splitting a bucket) requires a **new ADR**.
- **Inherited boundaries:** E4 (report rendering), E7 (durable store + persistent embedding/semantic
  cache), E8 (test plans) are out of scope; E3 binds to their ports and ships in-memory/fake stand-ins.

---

## 10. Touches (architect refinement for the coordinator)

- **#53 (this ADR):** `docs/sdlc/architecture/ADR-0005-e3-node-identity-sameness.md` (authored). Confirms
  seams in `packages/domain/src/models/state-identity/**` + `StateIdentityPort.ts` (**no code edit**).
- **#57 (E3.4):** `packages/domain/src/ports/EmbeddingPort.ts` (new) + barrel; `domain` sameness config +
  cosine + `SamenessRefiner` + activated `CompositeStateIdentityStrategy` merge;
  `packages/adapters/llm/src/EmbeddingAdapter.ts` (new) + fake; `docs/sdlc/evals/node-identity-sameness/**`.
  Inherits the §5 budget/abort/redaction/boundary constraint.
- **#58 (E3.5):** `packages/application/src/crawl/.../SemanticDuplicateDetector.ts` (or the E3 semantic
  subtree) — consumes #57's equivalence classes + #54 workflows + #55 intent; populates
  `Workflow.isHiddenPath`. Inherits §5.
- **Additive domain changes to flag to the arch-review gate (sanctioned, all additive):** `EmbeddingPort`
  (#57); `Workflow.featureGroup?` + `WorkflowMap.appPurpose?`/`appPurposeConfidence?` (#56/#59, OQ3);
  optional `CrawlBudget.maxEmbeddingCalls` (#57, only if eval shows it's needed).
  </content>
  </invoke>
