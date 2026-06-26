# ADR-0006 — E3.2 Per-screen & per-control intent inference (a11y-first, budgeted LLM)

- **Status:** Accepted
- **Date:** 2026-06-26
- **Mode:** plan (per-ticket design for #55 / E3.2, under PRD-e3 FR2 + FR6)
- **Scope:** Ticket #55 only — a new `packages/application/src/semantic/intent/**` subtree + an additive intent
  domain model in `packages/domain`. Reuses, unchanged, the E2 LLM boundary: `LlmPort`/`LlmAdapter`,
  `CrawlBudget`, the `DecisionCachePort` caching _pattern_, and the `CredentialRedactor`.
- **Refines, does not supersede:** ADR-0001 (stack/layering), ADR-0004 (E2 LLM budget/cache/redaction discipline).
  All ADR-0004 §3 / §6 invariants hold verbatim: every LLM call goes through `LlmPort` (real impl confined to
  `adapters/llm`), counts against `CrawlBudget`, is cached, is time-bounded/abortable, and is redacted first.
- **Decides for #55:** the intent domain-model shape (additive), the module layout, the two-tier (a11y-first,
  LLM-fallback) inference design over the _existing_ budgeted port, the injected-port set + DI, the AC refinement,
  and the disjoint `Touches:` (no overlap with #54).
- **Out of scope:** workflow extraction (#54); naming/grouping/app-purpose (#56 — _consumes_ this model); identity
  refinement (#57, blocked on #53 ADR); semantic duplicate detection (#58); embedding model choice (#53 ADR);
  vision/screenshot input (label-only for #55 — see §3.5); `WorkflowMap` assembly (#59).

---

## 1. Context & the real seams (what #55 MUST reuse, verified)

The E2 LLM boundary is delivered and is the only sanctioned LLM path. #55 binds to it, adds nothing to it:

- **`LlmPort.complete(messages, options): Promise<LlmCompletionResult>`** (`packages/domain/src/ports/DecisionPolicyPort.ts`).
  A low-level, message-in / `{content, promptTokens, completionTokens, modelId}`-out port. **This is the exact
  injection point #55 uses** — no new port, no provider type. The real impl `LlmAdapter` (`adapters/llm`) is
  time-bounded + AbortController-abortable (the #44 fix) and confined behind the SDK boundary. Intent inference
  injects a `LlmPort`; tests inject a `FakeLlmPort`.
- **`CrawlBudget`** (`packages/domain/src/models/run.ts`) — `maxLlmCalls` / `maxTokens` are the levers. Intent
  inference must **count every call and every token** against a budget and **stop calling the LLM when exhausted**,
  degrading to tier-1 (a11y-only) results. (ADR-0004 §3.6 numbers are the crawl defaults; #55 accepts a budget as
  input rather than inventing its own.)
- **`DecisionCachePort`** (`packages/domain/src/ports/DecisionCachePort.ts`) is keyed by `StateIdentity` and stores
  a `PolicyDecision`. That is **decision-shaped, not intent-shaped** — so #55 does **not** overload it. Instead #55
  adds a **sibling cache port of the same pattern** (`IntentCachePort`, §3.3) keyed by a stable content hash and
  storing the inferred intent. Same Open/Closed story (in-memory now, E7 persistent later); same "store redacted
  representations only" discipline. This mirrors how E2 added `DecisionCachePort` alongside, rather than bending an
  existing port.
- **`CredentialRedactor`** (`packages/application/src/crawl/redaction/CredentialRedactor.ts`) — a **pure
  application class** (no SDK, no I/O), exposing `redact(a11ySnapshot)` and `redactText(string)`. #55 reuses it
  directly (constructs/injects it); it is already the chokepoint that masks secure-entry values + OTP-shaped tokens.
  **No second redactor is written.**
- **`StateNode` / `StateEdge` / `StateGraph`** (`packages/domain/src/models/state-graph.ts`) — the inputs.
  `StateNode` carries `id: StateIdentity`, `label`, `a11ySnapshot: string`, `screenshotUri`. `StateEdge` carries
  `actionType`, `actionPayload`, `fromId`/`toId`. Per-control intent is derived from the **controls referenced by a
  node's outgoing edges** (the edge is the observed affordance) plus the a11y elements in the node snapshot.
- **`ConfidenceScore`** (`packages/domain/src/models/workflow.ts`) — branded `[0,1]`, with `makeConfidenceScore`.
  **Reused** for the LLM-derived confidence on intents (no new confidence type).

**Disjointness with #54:** #54 (`semantic/extraction/**`) reads the graph topology → `Workflow[]` (pure, no LLM,
no model addition beyond populating `workflow.ts`). #55 (`semantic/intent/**`) reads node/edge _content_ → a new
intent model (a11y + budgeted LLM). Different subtree, different domain model, different ports. No shared file.

---

## 2. The intent domain model (additive — new structure, NOT attached to StateNode)

**Decision: a new, separate `packages/domain/src/models/intent.ts` structure — NOT new fields on `StateNode`/`StateEdge`.**

Rationale (flagged to arch-review as the sanctioned additive domain change for #55):

- `StateNode`/`StateEdge` are **E2 crawl-time** records (frozen, owned by the crawl loop, persisted by the graph
  repo). Intent is an **E3 post-hoc semantic overlay** computed from a _finalized_ graph. Attaching inferred,
  possibly-LLM-derived, confidence-bearing fields onto the crawl record would (a) mutate an E2-owned contract for an
  E3 concern (coupling crawl persistence to semantics), and (b) force every E2 producer to populate semantic fields
  it does not own. **Separation of concerns + Open/Closed:** semantics layer _over_ the graph via a keyed overlay,
  it does not edit the graph record.
- The overlay is keyed by the existing `StateIdentity` (screen) and `StateEdge.id` (control), so it joins back to
  the graph without duplicating it. #56 consumes this overlay; #59 assembles it into the run's outputs.

```ts
// packages/domain/src/models/intent.ts  (NEW — additive; no edits to state-graph.ts/workflow.ts)
import type { StateIdentity } from "./state-graph.js";
import type { ConfidenceScore } from "./workflow.js"; // reuse — no new confidence type

/** How an intent value was derived (provenance — drives confidence + cost auditing). */
export type IntentSource = "a11y" | "llm" | "degraded";

/** Inferred intent for one control (an observed affordance / edge). */
export interface ControlIntent {
  /** Joins back to StateEdge.id (the observed affordance). */
  readonly edgeId: string;
  readonly actionType: string; // mirrors StateEdge.actionType (string-typed to avoid re-importing ActionType churn)
  /** What this control is for, e.g. "Submit the sign-in form". Never empty. */
  readonly intent: string;
  /** The affordance class, e.g. "navigation" | "submit" | "input" | "toggle" | "dismiss" | "unknown". */
  readonly affordance: string;
  readonly source: IntentSource;
  /** Confidence for LLM-derived intent; null for rule/degraded (mirrors workflow.inferenceConfidence). */
  readonly confidence: ConfidenceScore | null;
}

/** Inferred intent for one screen + its controls. */
export interface ScreenIntent {
  readonly stateId: StateIdentity;
  /** One-line purpose of the screen, e.g. "Sign-in screen". Never empty (degraded fallback used). */
  readonly purpose: string;
  readonly source: IntentSource;
  readonly confidence: ConfidenceScore | null;
  readonly controls: readonly ControlIntent[];
}

/** All inferred intents for one run's graph — the consumer contract for #56. */
export interface IntentModel {
  readonly runId: string;
  readonly screens: readonly ScreenIntent[];
}
```

**Shape guarantees (the consumer contract #56 builds on):** structured (not free prose); every `purpose`/`intent`
non-empty (degraded fallback fills it); `confidence` is non-null **iff** `source === "llm"`; `IntentModel` always
present and well-formed even on an empty/single-node graph (NFR6). This addition is **additive-only** — no existing
field changes — so it passes the arch-review additive-domain rule exactly like ADR-0004's `DecisionCachePort`.

---

## 3. Module layout + the budgeted-LLM integration design

### 3.1 Layout (new, disjoint subtree)

```
packages/domain/src/
  models/intent.ts                         ← #55 (NEW additive model, §2) + domain barrel export
  ports/IntentCachePort.ts                 ← #55 (NEW additive port, §3.3) + barrel export

packages/application/src/semantic/intent/
  InferIntent.ts                           ← #55 — the use-case / orchestrator (DI of all ports)
  A11yIntentDeriver.ts                     ← #55 — TIER 1: deterministic a11y-label pass (no LLM, always runs)
  LlmIntentRefiner.ts                      ← #55 — TIER 2: optional LLM refinement OVER the injected LlmPort
  IntentBudgetGuard.ts                     ← #55 — counts calls/tokens vs CrawlBudget; gates tier-2 (cost control)
  IntentCacheKey.ts                        ← #55 — stable content-hash key (redacted skeleton → key)
  InMemoryIntentCache.ts                   ← #55 — in-memory IntentCachePort impl (E7 swaps persistent)
  __tests__/*.test.ts                      ← #55 — per-file unit suites (a11y-only paths need NO LlmPort)

packages/application/src/test-support/
  FakeLlmPort.ts                           ← #55 — scripted LlmPort fake (deterministic, no SDK) [if not already present]
```

`A11yIntentDeriver` and the redactor are **pure** (no LlmPort) → tier-1 is fully testable with zero LLM. The SDK
stays in `adapters/llm` (NFR1); nothing here imports `@anthropic-ai/sdk` or `adapters/*` — enforced by the existing
`application-depends-only-on-domain` dependency-cruiser rule, no new rule needed (ADR-0004 §7.1).

### 3.2 The two-tier flow (a11y-first; LLM is the rare refinement)

`InferIntent.execute(graph, budget): Promise<IntentModel>` — for each `StateNode`:

1. **Redact first (NFR5 / T7).** `redacted = credentialRedactor.redact(node.a11ySnapshot)`. **All** downstream
   work (key, tier-1 parse, any prompt) uses the redacted snapshot. Edge payloads use `redactText(...)`. No raw
   secret ever reaches a key, a prompt, the cache, or the stored intent.
2. **Tier 1 — `A11yIntentDeriver` (always, deterministic, no LLM).** Derive `purpose` + per-control `intent`/
   `affordance` from a11y labels/roles/traits of the redacted snapshot and the node's outgoing edges. Missing/empty
   labels ⇒ a **degraded-but-present** intent (role + position, e.g. `"button at row 2"`), `source:"degraded"`,
   `confidence:null`. Never empty, never throws (PRD edge case).
3. **Cache check (FR6).** Compute `key = IntentCacheKey(redactedSkeleton)` (§3.4). `cache.get(key)` → on hit, reuse
   with **zero** new LLM call (re-runs / repeated identical screens are free).
4. **Tier 2 — `LlmIntentRefiner`, gated by `IntentBudgetGuard` (optional, rare).** Only if (a) refinement is
   enabled (config), (b) tier-1 is weak (degraded or low-signal — a config threshold, _not_ "every screen"), and
   (c) `budgetGuard.canCall()` (under `maxLlmCalls` **and** under `maxTokens`). Then call `llm.complete(...)` with a
   fixed code-owned system prompt + the redacted skeleton in a delimited untrusted-data block (mirroring
   `LLMPolicy`'s prompt-injection discipline, §3.5). Parse strict JSON → `{purpose, controls[]}` with `source:"llm"`
   and a `confidence`. Record `promptTokens + completionTokens` into the guard. `cache.set(key, refined)`.
5. **Resilience (NFR6).** LLM unavailable / over budget / timeout / unparseable ⇒ **fall back to the tier-1 result**
   with `source` left as tier-1 and `confidence:null`. Never crash, never a torn `IntentModel`. Identical to the
   `LLMPolicy` safe-fallback discipline (return the degraded value, not an exception).

**Cost control is structural:** tier-1 does the bulk; tier-2 is gated by _both_ an enable flag and the budget guard;
the cache makes repeated screens free. On the fixture, LLM-call count is bounded by `maxLlmCalls` and far below the
screen count (the epic NFR3 assertion).

### 3.3 `IntentBudgetGuard` — counting against `CrawlBudget` (the HARD CONSTRAINT, encoded)

```ts
// IntentBudgetGuard.ts — pure, injected with the run's CrawlBudget (maxLlmCalls / maxTokens)
class IntentBudgetGuard {
  constructor(private readonly budget: CrawlBudget) {}
  canCall(): boolean; // callsUsed < maxLlmCalls && tokensUsed < maxTokens
  recordUsage(promptTokens: number, completionTokens: number): void; // increments both counters
  get callsUsed(): number;
  get tokensUsed(): number;
}
```

The guard is the single chokepoint that makes "every LLM call is counted against `CrawlBudget`" a tested invariant:
`LlmIntentRefiner` MUST call `canCall()` before `llm.complete(...)` and `recordUsage(...)` after every call —
**including failed calls** (a failed/timed-out call still counts a call, tokens 0), exactly as `LLMPolicy` reports
failed-call usage. When `canCall()` is false, tier-2 is skipped and tier-1 stands. (#55 accepts the budget as input;
it does not redefine the ADR-0004 defaults.)

### 3.4 `IntentCachePort` (new additive port, the `DecisionCachePort` pattern)

```ts
// packages/domain/src/ports/IntentCachePort.ts  (NEW — additive, mirrors DecisionCachePort)
export interface IntentCachePort {
  get(key: string): Promise<ScreenIntent | null>; // key = stable hash of the REDACTED skeleton
  set(key: string, intent: ScreenIntent): Promise<void>; // stores REDACTED intent only (T7)
}
```

Why a new port, not `DecisionCachePort`: that port is `StateIdentity → PolicyDecision`, a crawl-decision cache.
Intent is content-derived (two distinct identities with the same redacted skeleton should share an inference), so
the key is a **content hash of the redacted skeleton** (`IntentCacheKey`), not the identity. Same Open/Closed
posture: `InMemoryIntentCache` now; E7 swaps a persistent impl at the composition root, zero refiner change. The key
is content-stable and process-independent so it **does not preclude E7 cross-run persistence** (PRD edge case).
Cache stores **redacted** intents only (NFR5).

### 3.5 Prompt / IO contract + label-only for #55

- **Label-only (no vision) for #55.** `screenshotUri` is **not** sent. ADR-0004 §3.3 and `LLMPolicy` send no
  screenshots; vision is an explicit OQ for the #53/#56 line, out of scope here. Tier-2 input is the **redacted a11y
  skeleton** only — keeps tokens + secret-exposure surface minimal.
- **Prompt-injection discipline (reused from `LLMPolicy`):** fixed, code-owned system prompt declaring the app data
  is UNTRUSTED OBSERVED DATA (not instructions); the redacted skeleton fenced in a delimited block; strict JSON
  output `{purpose, controls:[{edgeId, intent, affordance}]}` parsed with `JSON.parse` only — **no `eval`/`new
Function`**; unparseable ⇒ tier-1 fallback. Prompt _wording_ may iterate; the IO _shape_ is the contract.
- **Token bounds:** `maxTokens` per call bounded by config (skeleton truncated to a `MAX_*_CHARS` constant, named —
  no magic literals), and the per-call cost still counts against `CrawlBudget.maxTokens` via the guard.

### 3.6 DI / SOLID

`InferIntent` constructor injects: `CredentialRedactor`, `A11yIntentDeriver`, `LlmIntentRefiner` (which itself
injects `LlmPort` + `IntentBudgetGuard` + `IntentCachePort`), and a config object (enable flag, weakness threshold,
char caps). Every collaborator is an interface/class behind a constructor param → fakes in tests, real wiring at the
`packages/api` composition root (the wiring edit is owned by the #59 capstone, not #55 — #55 ships the unit-tested
classes + a self-contained integration test using fakes). Depends only on domain ports; no leaky SDK types.

---

## 4. Test strategy (coverage gate ≥85% line+branch on `application` semantic logic)

- **Tier-1 unit suites — zero LLM.** `A11yIntentDeriver` against deterministic redacted-snapshot fixtures: full
  labels ⇒ concise intent; empty/missing labels ⇒ degraded role+position intent (never empty); per-control intent
  from outgoing edges. These alone carry most of the line/branch coverage (cost-first design = most logic is here).
- **Redaction unit:** a fixture snapshot with secure-entry + OTP text ⇒ assert no secret reaches the key, the
  prompt (captured via `FakeLlmPort`), or the stored `ScreenIntent` (NFR5 AC). Reuses the existing `CredentialRedactor`
  (so this asserts integration, not re-tests the redactor internals).
- **Tier-2 with `FakeLlmPort`:** scripted responses cover parse-success, unparseable→tier-1 fallback, and
  timeout/throw→tier-1 fallback. Assert `source:"llm"` + non-null confidence on success; `confidence:null` on
  fallback.
- **Budget AC:** `FakeLlmPort` counts invocations; assert (a) calls never exceed `maxLlmCalls`, (b) tokens accrue to
  the guard and stop tier-2 when `maxTokens` is hit, (c) over-budget ⇒ tier-1 result. Deterministic.
- **Cache AC:** run inference twice on the same redacted input ⇒ second run makes **zero** new `FakeLlmPort` calls
  (FR6). Distinct skeletons ⇒ distinct keys ⇒ separate inferences.
- **Edge cases:** empty/single-node graph ⇒ valid well-formed `IntentModel`; node with no edges ⇒ screen intent with
  empty `controls`, no crash.
- **Eval scenarios (≥3, per ADR-0001 §7):** stored under `docs/sdlc/evals/intent/` — (1) labelled login screen ⇒
  correct screen purpose + per-control intents via tier-1; (2) unlabelled/icon-only screen ⇒ degraded tier-1, and
  (with refinement enabled + a scripted LLM) an `llm`-sourced refinement; (3) secret-bearing snapshot ⇒ redacted
  everywhere. Deterministic with the fake LLM.

---

## 5. Acceptance criteria refinement (Given/When/Then)

1. **Tier-1 always runs (deterministic).** _Given_ a `StateNode` with a11y labels, _When_ intent inference runs,
   _Then_ the screen and each edge-referenced control get a concise structured intent from a11y labels with **no LLM
   call**, `source:"a11y"`, `confidence:null`.
2. **Degraded tier-1 never empty.** _Given_ a node with missing/empty a11y labels, _When_ tier-1 runs, _Then_ it
   yields a degraded-but-present intent (role + position), `source:"degraded"`, and never crashes or emits an empty
   `purpose`/`intent`.
3. **HARD CONSTRAINT — budgeted/cached/abortable LLM path.** _Given_ tier-2 refinement is enabled, _When_ it runs,
   _Then_ every call goes through the injected `LlmPort` (real impl confined to `adapters/llm`), is counted by
   `IntentBudgetGuard` against `CrawlBudget` (`maxLlmCalls`/`maxTokens`), is time-bounded/abortable (inherited from
   `LlmAdapter`), and is cached by `IntentCachePort` keyed by the redacted-skeleton hash — re-running the same input
   makes **zero** new LLM calls.
4. **No uncontrolled LLM path.** _Given_ the #55 source, _When_ dependency-cruiser/boundaries run, _Then_ there is
   **no `@anthropic-ai/sdk` import outside `adapters/llm`** and no LLM call bypassing `LlmPort` + the budget guard.
5. **Redaction before any sink.** _Given_ typed-secret/credential text in a node's a11y snapshot, _When_ inference
   runs, _Then_ it is redacted (reusing `CredentialRedactor`) before reaching any cache key, prompt, or stored
   intent; no secret appears in the `IntentModel`, prompt, or logs.
6. **Graceful degradation.** _Given_ the LLM is unavailable, over budget, or returns unparseable output, _When_
   refinement runs, _Then_ intent degrades to the tier-1 result with `null` confidence and the pipeline does not
   crash; exactly one well-formed `IntentModel` is produced.
7. **Structured consumer contract.** _Given_ the `IntentModel` is produced, _When_ #56 consumes it, _Then_ it is
   structured (not free prose), `confidence` is non-null iff `source:"llm"`, and it is well-formed even for an
   empty/single-node graph.
8. **Coverage gate.** `application` semantic intent logic ≥85% line+branch with deterministic fixtures + `FakeLlmPort`;
   tier-1 paths tested with no LlmPort at all.

---

## 6. Touches / coordinator notes (disjoint from #54)

- **#55 `Touches:`**
  - `packages/domain/src/models/intent.ts` (NEW additive model) + domain barrel export.
  - `packages/domain/src/ports/IntentCachePort.ts` (NEW additive port) + barrel export.
  - `packages/application/src/semantic/intent/**` (NEW subtree: `InferIntent`, `A11yIntentDeriver`,
    `LlmIntentRefiner`, `IntentBudgetGuard`, `IntentCacheKey`, `InMemoryIntentCache`, `__tests__/**`).
  - `packages/application/src/test-support/FakeLlmPort.ts` (NEW, if not already present) + `application` index export.
  - `docs/sdlc/evals/intent/**` (NEW eval scenarios).
  - **Reuses, does not edit:** `CredentialRedactor` (`crawl/redaction`), `LlmPort`/`LlmAdapter`, `CrawlBudget`,
    `DecisionCachePort` (as the _pattern_ reference), `ConfidenceScore`, `StateNode`/`StateEdge`/`StateGraph`.
- **Disjoint from #54** (`semantic/extraction/**` + `workflow.ts` population) — different subtree, different model,
  no shared file. #54 and #55 remain concurrent (PRD "immediately eligible" pair confirmed).
- **Composition-root wiring deferred to #59** (the E3 capstone owns the `packages/api` `wire.ts` edit). #55 ships
  self-contained unit + fake-driven integration tests; it does **not** edit `packages/api`.
- **Additive domain changes to flag to the arch-review gate** (all additive, no existing contract broken, sanctioned
  here): `models/intent.ts` and `ports/IntentCachePort.ts`. Anything beyond (e.g. editing `StateNode`) would require
  a new ADR — explicitly avoided (§2).
- **Provider SDK:** none added to `application`. #55 introduces **no** new dependency in `packages/application` or
  `packages/domain` (port-only); it reuses `adapters/llm` strictly through `LlmPort`.

---

## 7. Consequences & risks

- **Positive:** the HARD CONSTRAINT is structural, not aspirational — `LlmPort` injection + `IntentBudgetGuard` +
  `IntentCachePort` + `CredentialRedactor` make "budgeted, cached, abortable, redacted, no rogue SDK" tested
  invariants; tier-1 a11y-first keeps the LLM rare and the bulk of logic LLM-free and deterministic (the coverage
  gate bites in pure code); the additive overlay model keeps E2 crawl records untouched (separation of concerns).
- **R-1 (a11y-label quality):** icon-only / unlabelled screens yield weak tier-1 intent. _Mitigation:_ degraded
  fallback is always present + confidence reflects it; tier-2 (when enabled + in budget) refines; eval scenario (2)
  bites this.
- **R-2 (intent cache key collisions):** distinct screens with identical redacted skeletons share an inference.
  _Mitigation:_ this is _intended_ (cost amortization across identical content) and safe for intent (same content ⇒
  same purpose); the key is content-stable for E7 persistence.
- **R-3 (budget shared with crawl):** #55 counts against the same `CrawlBudget` shape; whether E3 inference gets its
  own sub-budget or shares the run budget is a #59 composition-root concern. _Mitigation:_ #55 takes the budget as
  input via DI — the root decides the allocation; #55 just honours whatever budget it is handed.
  </content>
