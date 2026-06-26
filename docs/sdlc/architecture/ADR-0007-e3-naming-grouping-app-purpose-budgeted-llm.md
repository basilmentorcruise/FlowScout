# ADR-0007 — E3.3 App-purpose + workflow naming & feature grouping (budgeted LLM)

- **Status:** Accepted
- **Date:** 2026-06-27
- **Mode:** plan (per-ticket design for #56 / E3.3, under PRD-e3 FR2/FR3 + FR6)
- **Scope:** Ticket #56 only — a new `packages/application/src/semantic/grouping/**` subtree + **additive**
  optional fields on the existing `Workflow`/`WorkflowMap` domain types (OQ3). Reuses, unchanged, the E2 LLM
  boundary: `LlmPort`/`LlmAdapter`, `CrawlBudget`, the `DecisionCachePort`/`IntentCachePort` caching _pattern_, and
  the `CredentialRedactor` — exactly as #55 did (ADR-0006).
- **Refines, does not supersede:** ADR-0001 (stack/layering), ADR-0004 (E2 LLM budget/cache/redaction discipline),
  ADR-0006 (E3.2 intent — #56 _consumes_ its `IntentModel` and reuses its budgeted-LLM pattern verbatim). All
  ADR-0004 §3 / §6 invariants hold: every LLM call goes through `LlmPort` (real impl confined to `adapters/llm`),
  counts against `CrawlBudget`, is cached, is time-bounded/abortable, and is redacted first.
- **Decides for #56:** the additive `Workflow.featureGroup` + `WorkflowMap.appPurpose`/`appPurposeConfidence`
  domain shape (the E4 consumer contract), the module layout, the budgeted-LLM naming/grouping design (LLM
  **labels/groups only** — it can neither invent nor drop a workflow), the injected-port set + DI, the AC
  refinement, the test strategy, and the disjoint `Touches:`.
- **Out of scope:** extraction (#54 — produces the authoritative `Workflow[]`); intent inference (#55 — produces
  the consumed `IntentModel`); identity refinement (#57); semantic duplicate / hidden-path detection (#58);
  `WorkflowMap` assembly + composition-root wiring + E2E (#59). No new LLM provider path; **no vision** (label/
  intent text only — same posture as ADR-0006 §3.5).

---

## 1. Context & the real seams (what #56 MUST reuse, verified on `main`)

E3.1 (#54) and E3.2 (#55) are merged. #56 binds to their real, shipped contracts and adds nothing to the LLM
boundary:

- **`Workflow[]` is authoritative and already populated** (`packages/domain/src/models/workflow.ts`,
  `packages/application/src/semantic/extraction/WorkflowExtractor.ts`). The extractor produces deterministic,
  content-id'd workflows with **provisional** `name`/`description` placeholders (`"<entry> → <outcome>"`) and
  `isHiddenPath=false`, `inferenceConfidence=null`. Its header comment explicitly states naming/grouping is "#56
  overwrites". **#56's contract: the set of `Workflow` objects (their `id`s and `steps`) is frozen input. #56 may
  only relabel (`name`/`description`/`inferenceConfidence`) and assign the new `featureGroup` — it MUST NOT add,
  drop, merge, split, or reorder workflows.** The rule-based set is the source of truth.
- **`IntentModel`** (`packages/domain/src/models/intent.ts`, produced by `InferIntent`) is the per-screen/
  per-control semantic overlay, keyed by `StateIdentity` (screen) + `StateEdge.id` (control). #56 **consumes** it
  (already redacted, structured, `confidence` non-null iff `source:"llm"`) as the naming/grouping signal — it joins
  to a `Workflow` via the `stateId`s in `workflow.steps[].stateId`. #56 does not recompute intent.
- **`LlmPort.complete(messages, options): Promise<LlmCompletionResult>`**
  (`packages/domain/src/ports/DecisionPolicyPort.ts`) — the exact injection point, identical to #55. `LlmMessage`
  is `{role:"user"|"assistant"|"system", content}`; result is `{content, promptTokens, completionTokens, modelId}`.
  Real impl `LlmAdapter` (`adapters/llm`) is time-bounded + AbortController-abortable (#44). #56 injects a
  `LlmPort`; tests inject a `FakeLlmPort`.
- **`CrawlBudget`** (`packages/domain/src/models/run.ts`) — `maxLlmCalls`/`maxTokens`. #56 counts every call+token
  and stops calling when exhausted, degrading to rule-based names + `"Ungrouped"`. #56 accepts a budget as input
  (DI); #59 decides the allocation.
- **`IntentBudgetGuard`** (`packages/application/src/semantic/intent/IntentBudgetGuard.ts`) — the proven
  single-chokepoint guard (`canCall()` / `recordUsage(...)`, failed calls count tokens 0). #56 **reuses this class
  directly** (it is generic over `CrawlBudget`, not intent-specific) rather than writing a second guard — DRY, and
  it keeps "every LLM call is counted" one tested invariant shared across E3. (If a same-shape but separately-named
  guard is preferred for readability, it MUST be the identical contract; reuse is the default.)
- **`CredentialRedactor`** (`packages/application/src/crawl/redaction/CredentialRedactor.ts`) — pure, no SDK/I/O,
  `redact(A11ySnapshot)` + `redactText(string)`. #56 reuses it directly. **No second redactor.**
- **`ConfidenceScore`** (`workflow.ts`, branded `[0,1]`, `makeConfidenceScore`) — reused for all #56 LLM-derived
  confidences (workflow name confidence → `Workflow.inferenceConfidence`; app-purpose confidence →
  `WorkflowMap.appPurposeConfidence`). No new confidence type.

**Disjointness with #54/#55/#57:** #56 lives in a new `semantic/grouping/**` subtree, reads the frozen `Workflow[]`

- `IntentModel`, writes a new domain-model field-set. Different subtree, different inputs, different outputs from
  #57 (which mutates identity/`isHiddenPath` over embeddings). The only file #56 and #57 both append to is the
  **`packages/application/src/index.ts` barrel** (additive export lines) — an expected trivial rebase, flagged in §6.

---

## 2. The additive domain model (OQ3 — the E4 consumer contract)

**Decision: extend the EXISTING `Workflow`/`WorkflowMap` types in `packages/domain/src/models/workflow.ts` with
optional, additive fields — NOT a new overlay structure, and NOT by overloading `description`.**

Rationale — why additive-on-`workflow.ts` here (vs. ADR-0006's separate-overlay choice for intent):

- Unlike intent (a per-screen/per-control overlay over an **E2-owned, frozen** `StateGraph` record — where adding
  fields would force every E2 producer to populate semantic fields), the `Workflow`/`WorkflowMap` types are
  **E3-owned and report-bound** (the E4/E8 consumer contract, threat-model A6). The producer of `featureGroup`/
  `appPurpose` (#56) and the schema owner are the same epic; the renderer (E4) reads these very objects. A
  per-workflow group + a per-map purpose belong **on** the workflow/map record, not in a side overlay keyed back to
  it. Separate-overlay here would be ceremony with no Open/Closed payoff.
- `Workflow` already carries `name`, `description`, `inferenceConfidence` — fields the extractor explicitly marks
  "#56 overwrites" — so the relabel path is already designed-for. The only genuinely new data is the **feature
  group** (per-workflow) and the **app purpose + its confidence** (per-map).
- **Additive-only, no breaking change:** the new fields are **optional** (`?`), so every existing `Workflow`/
  `WorkflowMap` literal on `main` (the extractor, #59 assembly, all tests) stays valid unchanged. No existing field
  is changed, narrowed, or repurposed. This is the **sanctioned additive domain change for #56** (flag to
  arch-review), exactly parallel to ADR-0006's `intent.ts`/`IntentCachePort` and ADR-0004's `DecisionCachePort`.

```ts
// packages/domain/src/models/workflow.ts  — ADDITIVE edits only (no existing field changed)

/** A grouped, named workflow discovered during the crawl. */
export interface Workflow {
  readonly id: string;
  readonly name: string; // (existing) #56 overwrites the extractor's provisional name
  readonly description: string; // (existing) #56 overwrites the provisional description; NEVER carries group/purpose
  readonly steps: readonly WorkflowStep[];
  readonly isHiddenPath: boolean;
  readonly inferenceConfidence: ConfidenceScore | null;

  /**
   * NEW (#56, ADR-0007). The feature this workflow belongs to, e.g. "Authentication",
   * "Cart & Checkout". Inert, untrusted-origin text (E4 MUST output-encode — T7).
   *   - omitted/undefined  ⇒ pre-#56 object (back-compat) — E4 renders it ungrouped.
   *   - "Ungrouped"        ⇒ #56 ran but produced no confident group (LLM disabled/over-budget/low-signal).
   * Never empty when present. The deterministic fallback sets "Ungrouped", not undefined,
   * so a #56-processed map is distinguishable from a raw extractor map.
   */
  readonly featureGroup?: string;
}

/** All workflows discovered in a single crawl run. */
export interface WorkflowMap {
  readonly runId: string;
  readonly workflows: readonly Workflow[];
  readonly finalisedAt: string;

  /**
   * NEW (#56, ADR-0007). The app's overall one-line purpose, e.g. "A ride-hailing app for booking trips".
   * Inert, untrusted-origin text (E4 MUST output-encode — T7). Never empty when present.
   *   - omitted/undefined  ⇒ pre-#56 / not-yet-inferred.
   *   - "Unknown"          ⇒ #56 ran but could not infer (LLM disabled/over-budget) — pairs with null confidence.
   */
  readonly appPurpose?: string;

  /**
   * NEW (#56, ADR-0007). Confidence for `appPurpose`.
   *   - a ConfidenceScore ⇒ LLM-derived purpose.
   *   - null              ⇒ rule-based / "Unknown" purpose (mirrors workflow.inferenceConfidence semantics).
   *   - undefined         ⇒ not inferred (pairs with appPurpose undefined).
   */
  readonly appPurposeConfidence?: ConfidenceScore | null;
}
```

**Shape guarantees (the E4 contract):** when present, `featureGroup`/`appPurpose` are non-empty strings; an
LLM-derived value carries a non-null `ConfidenceScore`, a rule/degraded value carries `null` (purpose) or sets
`inferenceConfidence=null` (name) — the same "confidence non-null iff LLM" rule as `intent.ts`/`workflow.ts`.
`description` is **never** overloaded to carry group/purpose. All four string fields (`name`, `description`,
`featureGroup`, `appPurpose`) are **untrusted-origin inert data** — recorded for E4's mandatory output-encoding (T7,
M56.5). These additions live on the existing `Workflow`/`WorkflowMap` types already re-exported by the domain
barrel, so **no domain-barrel line changes** — the barrel edit risk is `application/src/index.ts` only (§6).

---

## 3. Module layout + the budgeted-LLM naming/grouping design

### 3.1 Layout (new, disjoint subtree — mirrors `semantic/intent/**`)

```
packages/domain/src/
  models/workflow.ts                          ← #56 — ADDITIVE optional fields (§2); barrel UNCHANGED (types already exported)

packages/application/src/semantic/grouping/
  NameAndGroupWorkflows.ts                    ← #56 — the use-case / orchestrator (DI of all collaborators)
  RuleNameStrategy.ts                         ← #56 — TIER 1: deterministic names/desc/group from Workflow+IntentModel (no LLM, always runs)
  LlmNamingRefiner.ts                         ← #56 — TIER 2: optional LLM naming/grouping/purpose OVER the injected LlmPort
  AppPurposeInferer.ts                        ← #56 — the per-MAP purpose pass (rule fallback + optional budgeted LLM)
  GroupingCacheKey.ts                         ← #56 — stable content-hash key (redacted workflow+intent skeleton → key)
  InMemoryGroupingCache.ts                    ← #56 — in-memory GroupingCachePort impl (E7 swaps persistent)
  GroupingConfig.ts                           ← #56 — enable flag / refine-only-weak / char caps (no magic literals)
  index.ts                                    ← #56 — subtree barrel (mirrors extraction/index.ts)
  __tests__/*.test.ts                         ← #56 — per-file unit suites (rule paths need NO LlmPort)

packages/domain/src/ports/
  GroupingCachePort.ts                        ← #56 — NEW additive port (DecisionCachePort/IntentCachePort pattern) + barrel export

packages/application/src/test-support/
  FakeLlmPort.ts                              ← reuse #55's if present; else add (scripted, deterministic, no SDK)
```

`RuleNameStrategy`, `AppPurposeInferer`'s rule path, and the redactor reuse are **pure** (no LlmPort) → tier-1 is
fully testable with zero LLM. The SDK stays in `adapters/llm` (NFR1); nothing here imports `@anthropic-ai/sdk`/
`@ai-sdk`/`ai` or `adapters/*` — enforced by the existing `application-depends-only-on-domain` dependency-cruiser
rule (ADR-0004 §7.1, ADR-0006 §3.1), no new rule needed.

### 3.2 The two-tier flow (rule-first; LLM is the rare refinement — same shape as ADR-0006 §3.2)

`NameAndGroupWorkflows.execute(workflows, intent, budget): Promise<{workflows, appPurpose, appPurposeConfidence}>`

Per workflow:

1. **Build a redacted skeleton (NFR5 / T1 / T2).** Join the workflow's already-redacted signal: step descriptions,
   the per-step `ScreenIntent.purpose`, and the per-control `ControlIntent.intent` from the consumed `IntentModel`.
   The `IntentModel` is **already redacted** by #55, but #56 defensively passes any free text through
   `CredentialRedactor.redactText(...)` before it enters a key/prompt/output (defense-in-depth, T2 output rule).
   No raw a11y bytes are re-read — #56 consumes the redacted overlay, never the pre-redaction graph.
2. **Tier 1 — `RuleNameStrategy` (always, deterministic, no LLM).** Derive a human-readable `name`/`description`
   from the entry/outcome `ScreenIntent.purpose` (richer than the extractor's label-only provisional), and a
   provisional `featureGroup` from the dominant screen purpose / outcome class. Missing intent ⇒ fall back to the
   workflow's existing provisional name and `featureGroup="Ungrouped"`. Never empty, never throws. `source` rule ⇒
   `inferenceConfidence=null`.
3. **Cache check (FR6).** `key = GroupingCacheKey(redactedSkeleton)`; `cache.get(key)` → hit reuses with **zero**
   new LLM call (re-runs / identical workflows free).
4. **Tier 2 — `LlmNamingRefiner`, gated by the budget guard (optional, rare).** Only if (a) refinement enabled
   (config), (b) tier-1 is weak (config threshold — degraded/low-signal, _not_ every workflow), and (c)
   `budgetGuard.canCall()`. Then `llm.complete(...)` with a fixed code-owned system prompt + the redacted skeleton
   in a delimited untrusted block. Strict-JSON parse → `{name, description, featureGroup}` with `source:"llm"` and a
   `ConfidenceScore`. Record `promptTokens+completionTokens` into the guard (failures count, tokens 0).
   `cache.set(key, refined)`.
5. **Resilience (NFR6).** LLM unavailable / over budget / timeout / unparseable ⇒ **fall back to the tier-1 result**
   (`inferenceConfidence=null`). Never crash, never a torn workflow.

**App purpose (`AppPurposeInferer`, per-map, once).** Rule path: synthesize a provisional purpose from the most
frequent feature groups + outcome screens (deterministic, `appPurposeConfidence=null`, `"Unknown"` if no signal).
Optional tier-2: one budgeted, cached LLM call over the redacted set of group names + top screen purposes →
`{appPurpose}` with a `ConfidenceScore`. Over budget / disabled / unparseable ⇒ rule/`"Unknown"`. This is **one**
extra call for the whole map, not per-workflow — bounding fan-out (T3).

**The LLM can only label/group (M56.3 / T6, LLM06-bounded).** The refiner's output is **merged onto the existing
`Workflow` objects by `id`** (allowlist: only the input workflow ids are honoured; any id the LLM invents is
dropped; any workflow the LLM omits keeps its tier-1 labels) — the exact `merge()` allowlist discipline
`LlmIntentRefiner` already uses for edgeIds. **The workflow set's cardinality, ids, and `steps` are invariant
across naming/grouping** — asserted in tests (AC). The LLM never creates/deletes a workflow.

### 3.3 Budget — reusing `IntentBudgetGuard` (the HARD CONSTRAINT, encoded)

`LlmNamingRefiner` and `AppPurposeInferer` are constructed with a budget guard (`IntentBudgetGuard`, reused — it is
generic over `CrawlBudget`). Each MUST call `canCall()` before `llm.complete(...)` and `recordUsage(...)` after
**every** attempt (including failures, tokens 0). When `canCall()` is false, tier-2 is skipped and tier-1 stands.
This makes "every #56 LLM call is counted against `CrawlBudget`" a single tested invariant, shared with #55. #56
honours the budget it is handed (allocation is #59's root concern).

### 3.4 `GroupingCachePort` (new additive port — the `DecisionCachePort`/`IntentCachePort` pattern)

```ts
// packages/domain/src/ports/GroupingCachePort.ts  (NEW — additive, mirrors IntentCachePort)
export interface GroupingCachePort {
  get(key: string): Promise<WorkflowLabeling | null>; // key = stable hash of the REDACTED workflow+intent skeleton
  set(key: string, labeling: WorkflowLabeling): Promise<void>; // stores REDACTED labels only (T2)
}
/** The cacheable labeling result for one workflow (redacted-derived; no raw a11y/secret text). */
export interface WorkflowLabeling {
  readonly name: string;
  readonly description: string;
  readonly featureGroup: string;
  readonly confidence: ConfidenceScore | null;
}
```

Why a new port, not `IntentCachePort`: that stores `ScreenIntent` keyed by screen-skeleton. Grouping caches a
per-workflow labeling keyed by the **workflow+intent** skeleton (content hash via `GroupingCacheKey`), so two
identical workflows share a labeling and re-runs cost zero. Same Open/Closed posture: `InMemoryGroupingCache` now;
E7 swaps a persistent impl at the root, zero refiner change. Key is content-stable + process-independent (no E7
cross-run blocker). Cache stores **redacted-derived** labels only (NFR5 / T2).

### 3.5 Prompt / IO contract (label-only; reuse `LlmIntentRefiner`'s injection discipline verbatim)

- **Label-only (no vision).** Screenshots are never sent (ADR-0006 §3.5; threat-model M53.3 label-only for MVP).
  Tier-2 input is the redacted workflow+intent skeleton only — minimal tokens, minimal exfil surface.
- **Prompt-injection discipline (LLM01 / T6, reused from `LlmIntentRefiner`/`LLMPolicy`):** fixed code-owned
  `system` prompt declaring the app data UNTRUSTED OBSERVED DATA, never instructions; the redacted skeleton fenced
  in a delimited `user` block; strict `JSON.parse` only — **no `eval`/`new Function`**; the schema is
  `{name, description, featureGroup}` (per-workflow) / `{appPurpose}` (per-map); a control/workflow-id allowlist on
  merge; unparseable/invalid ⇒ tier-1 fallback. Prompt _wording_ may iterate; the IO _shape_ is the contract.
- **Token bounds:** skeleton truncated to a named `MAX_SKELETON_CHARS` constant; `maxTokens` per call bounded by
  config; per-call cost still counts against `CrawlBudget.maxTokens` via the guard. No magic literals.

### 3.6 DI / SOLID

`NameAndGroupWorkflows` constructor injects: `CredentialRedactor`, `RuleNameStrategy`, `LlmNamingRefiner` (which
injects `LlmPort` + `IntentBudgetGuard` + `GroupingCachePort`), `AppPurposeInferer` (injects the same guard +
`LlmPort` + cache), and a `GroupingConfig`. Every collaborator is an interface/class behind a constructor param →
fakes in tests, real wiring at the `packages/api` root (the wiring edit is **#59's**, not #56's — #56 ships
unit-tested classes + a fake-driven self-contained integration test; it does **not** edit `packages/api`). Depends
only on domain ports + `@flowscout/domain`; no leaky SDK types.

---

## 4. Test strategy (coverage gate ≥85% line+branch on `application` grouping logic)

- **Tier-1 unit suites — zero LLM.** `RuleNameStrategy` over deterministic `Workflow[]`+`IntentModel` fixtures:
  rich intent ⇒ concise name/desc/group; missing intent ⇒ provisional name + `"Ungrouped"`. `AppPurposeInferer`
  rule path ⇒ deterministic purpose from group frequencies; no signal ⇒ `"Unknown"`, `null` confidence. These
  carry the bulk of line/branch coverage (cost-first design = most logic is here).
- **Invariant: LLM never invents/drops a workflow.** A `FakeLlmPort` scripted to (a) return an extra workflow id,
  (b) omit a workflow, (c) blank a name — assert the output `workflows` array has the **same ids/cardinality/steps**
  as the input, omitted/blanked workflows keep tier-1 labels, and the invented id is dropped. (The §3.2 allowlist.)
- **Redaction (T1/T2).** A fixture workflow whose intent strings carry a seeded secret/OTP/PII ⇒ assert no secret
  reaches the cache key, the prompt (captured via `FakeLlmPort`), `name`/`description`/`featureGroup`/`appPurpose`,
  or the stored `WorkflowLabeling`. Asserts integration with the existing `CredentialRedactor`, not its internals.
- **Tier-2 with `FakeLlmPort`:** scripted parse-success (`source:"llm"`, non-null confidence), unparseable→tier-1
  fallback, timeout/throw→tier-1 fallback (`null` confidence). Deterministic + stably-ordered output (AC3).
- **Budget AC (T3).** `FakeLlmPort` counts invocations; assert (a) calls never exceed `maxLlmCalls`, (b) tokens
  accrue to the guard and stop tier-2 at `maxTokens`, (c) over-budget ⇒ rule-based names + `"Ungrouped"`/`"Unknown"`
  with `null`/low confidence, and the pipeline still returns a full result. App-purpose call is bounded to one.
- **Cache AC (FR6).** Run naming/grouping twice on the same inputs ⇒ second run makes **zero** new `FakeLlmPort`
  calls. Distinct skeletons ⇒ distinct keys ⇒ separate labelings.
- **Edge cases:** empty `Workflow[]` ⇒ valid result (`appPurpose="Unknown"`, no crash); workflow with no intent
  match ⇒ provisional name + `"Ungrouped"`; single-workflow map.
- **Eval scenarios (≥3, per ADR-0001 §7):** stored under `docs/sdlc/evals/grouping/` — (1) a login + a checkout
  workflow ⇒ correct names + groups ("Authentication" / "Cart & Checkout") + a coherent app purpose via tier-1;
  (2) a weak/low-signal workflow ⇒ degraded tier-1, and (with refinement enabled + scripted LLM) an `llm`-sourced
  refinement; (3) a secret-bearing intent string ⇒ redacted everywhere (name/group/purpose/cache). Deterministic
  with the fake LLM.

---

## 5. Acceptance criteria refinement (Given/When/Then)

1. **Tier-1 always runs (deterministic, stably ordered).** _Given_ the frozen `Workflow[]` (#54) + `IntentModel`
   (#55), _When_ naming/grouping runs, _Then_ each `Workflow` gets a human-readable `name`+`description` and a
   `featureGroup`, and the map gets a one-line `appPurpose`, from rules with **no LLM call**, `inferenceConfidence=
null` / `appPurposeConfidence=null`; identical inputs + identical (faked) LLM responses ⇒ deterministic, stably
   ordered output.
2. **LLM never invents or drops a workflow (M56.3 / T6).** _Given_ any LLM output, _When_ it is merged, _Then_ the
   output workflow set has the **same ids, cardinality, and `steps`** as the input; an invented id is dropped, an
   omitted/blanked workflow keeps its tier-1 labels. The LLM only **labels/groups existing** workflows.
3. **HARD CONSTRAINT — budgeted/cached/abortable LLM path (M56.2 / T3).** _Given_ tier-2 is enabled, _When_ it runs,
   _Then_ every call goes through the injected `LlmPort` (real impl confined to `adapters/llm`), is counted by the
   reused `IntentBudgetGuard` against `CrawlBudget` (`maxLlmCalls`/`maxTokens`), is time-bounded/abortable
   (inherited from `LlmAdapter`), and is cached by `GroupingCachePort` keyed by the redacted skeleton hash —
   re-running the same input makes **zero** new LLM calls. App-purpose is **one** call for the whole map.
4. **No uncontrolled LLM path (M56.4 / T4/T8).** _Given_ the #56 source, _When_ dependency-cruiser/boundaries run,
   _Then_ there is **no `@anthropic-ai/sdk`/`@ai-sdk`/`ai` import outside `adapters/llm`**, no `adapters/*` import in
   `grouping/**`, and no LLM call bypassing `LlmPort` + the budget guard; `LLM_API_KEY` never in logs/cache/output.
5. **Redaction before any sink (M56.1 / T1/T2).** _Given_ credential/OTP/PII text in the consumed intent strings,
   _When_ naming/grouping runs, _Then_ it is redacted (reusing `CredentialRedactor`) before reaching any cache key,
   prompt, stored labeling, `name`/`description`/`featureGroup`, or `appPurpose`; no secret appears in the output,
   prompt, cache, or logs (output-side check, defense-in-depth).
6. **Graceful degradation (NFR6).** _Given_ the LLM is unavailable / over budget / returns unparseable output,
   _When_ naming/grouping runs, _Then_ names/groups degrade to rule-based (`featureGroup="Ungrouped"`,
   `appPurpose="Unknown"`) with `null`/low confidence and the pipeline still produces **exactly one** full result —
   no crash, no torn map, no retry storm.
7. **Additive consumer contract (OQ3 / M56.5 / T7).** _Given_ this ticket lands, _When_ E4 consumes the map, _Then_
   purpose + per-workflow group are carried via the additive optional `Workflow.featureGroup` /
   `WorkflowMap.appPurpose` / `appPurposeConfidence` fields (no `description` overloading, no breaking change to
   existing fields); a purely rule-derived value sets `inferenceConfidence`/`appPurposeConfidence = null`; all four
   string fields are inert untrusted-origin data the PR flags to arch-review/E4 for mandatory output-encoding.
8. **Coverage gate.** `application` grouping logic ≥85% line+branch with deterministic fixtures + `FakeLlmPort`;
   tier-1 paths tested with no `LlmPort` at all; ≥3 eval scenarios under `docs/sdlc/evals/grouping/`.

---

## 6. Touches / coordinator notes (disjoint from #54/#55/#57)

- **#56 `Touches:`**
  - `packages/domain/src/models/workflow.ts` (ADDITIVE optional fields — §2; **domain barrel unchanged**, the
    `Workflow`/`WorkflowMap` types are already re-exported).
  - `packages/domain/src/ports/GroupingCachePort.ts` (NEW additive port — §3.4) + **domain barrel export line**.
  - `packages/application/src/semantic/grouping/**` (NEW subtree: `NameAndGroupWorkflows`, `RuleNameStrategy`,
    `LlmNamingRefiner`, `AppPurposeInferer`, `GroupingCacheKey`, `InMemoryGroupingCache`, `GroupingConfig`,
    `index.ts`, `__tests__/**`).
  - `packages/application/src/index.ts` (ADDITIVE export lines for the grouping subtree) — **the one file also
    appended-to by #57; expect a trivial additive rebase, no logical conflict.**
  - `packages/application/src/test-support/FakeLlmPort.ts` (reuse #55's; add only if absent).
  - `docs/sdlc/evals/grouping/**` (NEW eval scenarios).
  - **Reuses, does not edit:** `CredentialRedactor`, `LlmPort`/`LlmAdapter`, `CrawlBudget`, `IntentBudgetGuard`,
    `ConfidenceScore`, the merged `WorkflowExtractor` output, the merged `IntentModel`/`InferIntent` output.
- **Disjoint from #54** (extraction subtree + provisional labels — #56 overwrites those, reads its output value),
  **#55** (intent subtree + `intent.ts`/`IntentCachePort` — #56 consumes its model), and **#57** (identity/embedding
  refinement — different inputs/outputs). No shared file except the `application/src/index.ts` barrel (additive).
- **Composition-root wiring deferred to #59** (the E3 capstone owns the `packages/api` wiring + final `WorkflowMap`
  assembly that stamps `featureGroup`/`appPurpose` onto the persisted map). #56 ships unit + fake-driven
  integration tests; it does **not** edit `packages/api`.
- **Additive domain changes to flag to the arch-review gate** (all additive, no existing contract broken,
  sanctioned here): optional `Workflow.featureGroup`, `WorkflowMap.appPurpose`, `WorkflowMap.appPurposeConfidence`
  on `models/workflow.ts`, and the new `GroupingCachePort`. Anything beyond (e.g. changing an existing field's type
  or making it required) would need a new ADR — explicitly avoided (§2).
- **Provider SDK:** none added to `application`/`domain`. #56 introduces **no** new dependency; it reuses
  `adapters/llm` strictly through `LlmPort` (port-only).

---

## 7. Consequences & risks

- **Positive:** the HARD CONSTRAINT is structural, not aspirational — `LlmPort` injection + the reused
  `IntentBudgetGuard` + `GroupingCachePort` + `CredentialRedactor` + the id-allowlist merge make "budgeted, cached,
  abortable, redacted, no rogue SDK, never invents/drops a workflow" tested invariants. Rule-first keeps the LLM
  rare and the bulk of logic LLM-free + deterministic (the coverage gate bites in pure code). The additive
  fields-on-`workflow.ts` choice keeps the E4 contract on the report-bound record with zero break to existing
  literals; the per-map single app-purpose call bounds fan-out.
- **R-1 (intent-signal quality):** weak/icon-only screens yield weak tier-1 names/groups. _Mitigation:_ provisional
  name + `"Ungrouped"`/`"Unknown"` always present; confidence reflects it; tier-2 (when enabled + in budget)
  refines; eval scenario (2) bites this.
- **R-2 (grouping cache-key collisions):** distinct workflows with identical redacted skeletons share a labeling.
  _Mitigation:_ intended (cost amortization over identical content) and safe for labels (same content ⇒ same name/
  group); key is content-stable for E7 persistence.
- **R-3 (barrel rebase with #57):** both append to `application/src/index.ts`. _Mitigation:_ additive-only export
  lines, no logical overlap — a trivial rebase the coordinator should expect (flagged in §6), not a true conflict.
- **R-4 (budget shared with crawl + #55):** #56 counts against the same `CrawlBudget` shape via the shared guard;
  whether E3 inference gets a sub-budget or shares the run budget is a #59 root concern. _Mitigation:_ #56 takes the
  budget as input via DI — the root decides allocation; #56 honours whatever it is handed.

```

```
