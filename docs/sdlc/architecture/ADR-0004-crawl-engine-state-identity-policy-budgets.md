# ADR-0004 — Crawl Engine: State-Identity Strategy, DecisionPolicy Chain, Budgets & E2 Decomposition

- **Status:** Accepted
- **Date:** 2026-06-22
- **Mode:** plan (per-epic refinement of ADR-0001 for Epic E2)
- **Scope:** Epic E2 (#2) — the autonomous crawl & state-graph engine in `packages/application` +
  `packages/domain` additions (StateIdentity strategy, plateau/budget config), `packages/adapters/llm` (real
  policy chain + LLM adapter), `packages/api` composition-root wiring, and a new test-support fixture lane.
  Tickets #31–#37.
- **Refines, does not supersede:** ADR-0001 (stack & reference architecture), ADR-0002/ADR-0003 (E1 mobile-mcp
  adapter decomposition + per-capability conformance harness). All ADR-0001 invariants hold: the engine lives in
  `application`/`domain` and depends **only on domain ports** — never `adapters/mobile-mcp`, the MCP SDK, or any
  LLM provider SDK (NFR1, dependency-cruiser §6). The engine consumes the E1 `MobileDriverPort` PORT, not the
  adapter.
- **Decides:** PRD-e2 OQ1–OQ5 concretely, the per-ticket file/module ownership so #31–#37 minimize shared-file
  overlap (applying the E1 lessons), and the first-wave batching recommendation.
- **Out of scope (boundaries, not designed here):** E3 semantic understanding / screen grouping / duplicate
  _semantics_; E4 HTML report; E5 dashboard + SSE; E6 vault internals + 2FA resume; E7 durable Postgres store +
  cross-run decision-cache persistence + diffing. E2 binds to ports for all of these and ships in-memory
  implementations for what it needs to run.

---

## 1. Context

E1 is delivered: `MobileDriverPort` + `SimulatorLifecycle` (the mobile-mcp adapter facade) and a `FakeMobileDriver`

- per-capability contract suite. `packages/domain` already defines everything the engine consumes as types/ports:
  `StateGraph`/`StateNode`/`StateEdge`/`StateIdentity` (`models/state-graph.ts`), `CrawlBudget`/`Run`
  (`models/run.ts`), `DecisionPolicy`/`DecisionContext`/`PolicyDecision`/`LlmPort` (`ports/DecisionPolicyPort.ts`),
  `CrawlEventStream` + the full `CrawlEvent` union (`ports/CrawlEventStream.ts`), and `StateGraphRepository`
  (`ports/RepositoryPorts.ts`). The `LlmAdapter`/`LlmDecisionPolicy` (`adapters/llm`) and the persistence repos are
  **stubs that reject every call**. `packages/application` has only `AppContext`/`AppPorts` + a `UseCase` marker —
  **no engine yet**.

E2 is the highest-risk MVP epic (Confidence 0.5) for two reasons flagged in ADR-0001 (R1, R3) and the PRD
(OQ1–OQ5): **state-node identity** (when are two screens "the same"?) and **LLM cost**. This ADR fixes the default
algorithms, the model, and the concrete budget numbers so #31–#37 build against decisions, not open questions.

**E1 decomposition lessons (from memory `e1-adapter-decomposition`, `e1-conformance-harness`) applied to E2:**
when many tickets layer onto **one engine file**, they will fight over that file and over shared test fixtures /
`vitest.config` exactly as E1's capability tickets did over `MobileMcpDriver.ts`. The E1 fix was: a dependency-free
foundation ticket lands a **frozen seam** (facade + stub modules + shared injectable), and every later ticket owns
a **disjoint subtree**. E2's engine is not a facade-over-capabilities (it's a single use-case with sequential
behavioural layers), so the analogous move is different and is the core decomposition decision in §7: **the loop is
a pipeline of injected, independently-owned collaborators** behind a frozen `StartCrawlRun` shell that #31 lands —
later tickets replace/extend a collaborator they own, not the loop body.

---

## 2. OQ1 — StateIdentity strategy: default algorithm, composition, threshold (#32)

**Decision.** `StateIdentity` is a pluggable **Strategy** in `packages/domain` (`ports/StateIdentityPort.ts` +
`models/state-identity/` default impl). The default impl #32 ships is the **A11y-tree structural signature
strategy** — a deterministic, embedding-free, LLM-free hash of a _normalized structural skeleton_ of the
accessibility tree. Embedding + semantic-label inputs are **designed as additive composables now but not
implemented in #32** (they arrive with E3's semantic layer); the contract and the composition seam exist from day
one so the loop never changes when they land.

### 2.1 The strategy interface (the frozen seam #32 lands)

```ts
// packages/domain/src/ports/StateIdentityPort.ts
export interface StateIdentityInput {
  readonly a11ySnapshot: A11ySnapshot; // mandatory (E2)
  readonly screenEmbedding?: readonly number[]; // additive, E3-supplied (optional, ignored by default impl)
  readonly semanticLabel?: string; // additive, E3-supplied (optional)
  readonly platform: Platform;
}
export interface StateIdentityStrategy {
  /** Stable identity for a screen. Never throws on empty/malformed input — returns a degraded identity. */
  identify(input: StateIdentityInput): StateIdentity;
}
```

The loop (#31/#34) depends only on `StateIdentityStrategy` injected via DI. #31 ships with a trivial placeholder
strategy; #34 swaps in the real default — **zero loop edits** (the loop calls `strategy.identify(...)`).

### 2.2 Default algorithm — normalized A11y structural signature

The default `A11ySignatureStrategy.identify(input)`:

1. **Parse** the `A11ySnapshot` (opaque serialized string at the domain boundary — the default impl owns its
   parsing; if parse fails, go to step 5 degraded path).
2. **Project each node** to a **structural token** = `(role/type, stable-key)` where `stable-key` is, in priority
   order: a stable accessibility identifier / test-id if present; else a **normalized** label (see step 3); else
   just the role. Drop pure-value/leaf text nodes that carry no role (they are content, not structure).
3. **Normalize labels to suppress volatile content** (the FR3 / "tolerate volatile content" requirement) via a
   fixed, configurable redaction pass _before_ hashing: collapse digit runs → `#`, ISO/clock timestamps → `<ts>`,
   currency/percentages → `<num>`, and **drop repeated sibling rows** beyond the first _k_ of an identical
   role-pattern (dynamic list bodies: 200 chat rows and 3 chat rows hash the same). This is the single most
   important knob for not exploding the graph on dynamic screens (PRD edge case "genuinely dynamic screen").
4. **Build a structural signature** = a canonical, **order-significant for containers, count-collapsed for
   repeated siblings** serialization of the projected tree (depth-bounded to a configured `maxDepth`), then
   **SHA-256** it → the raw identity string → `makeStateIdentity(hash)`.
5. **Degraded path (never throw):** empty/oversized/unparseable snapshot → identity =
   `makeStateIdentity("degraded:" + sha256(rawTruncatedSnapshot))`. Distinct degraded screens still get distinct
   ids; the loop records a telemetry note. (PRD edge case "empty/oversized snapshot → handled, not swallowed".)

### 2.3 Composition & weighting (designed, not yet active)

The three inputs compose by a **`CompositeStateIdentityStrategy`** (also defined in #32 but the default wiring uses
only the a11y strategy): identity = a primary **bucket** from the a11y signature, **refined** by an optional
embedding-nearest-neighbour merge and an optional semantic label. The **weighting/threshold question is therefore
deferred to E3, not E2** — because E2's default uses _only_ the exact a11y hash, sameness is **exact-match on the
hash** (threshold = 1.0 / identical). When E3 adds embeddings:

- **Composition:** a11y-signature is the **coarse bucket** (cheap, exact); embedding cosine similarity is a
  **within-bucket / cross-bucket merge** step; semantic label is a **tie-break/label only**, never the primary key
  (labels drift across versions). Recommended default weighting when activated: a11y bucket is authoritative;
  embedding merges two buckets only at **cosine ≥ 0.92** (the **sameness threshold** — recorded here as the E3
  default to tune); semantic label never splits a bucket, only annotates.
- **Why a11y-first, embedding-second:** the a11y signature is deterministic and free (NFR2 determinism, NFR3 cost);
  embeddings cost money/latency and are the F2/R1 risk — making them a _refinement_ of an exact bucket keeps the
  hot path embedding-free, matching the cache-first cost philosophy of the policy chain (§3).

**Eval scenarios (≥3, per ADR-0001 §7, shipped by #32 under `docs/sdlc/evals/state-identity/`):** (1) same screen
via two paths differing only in volatile content (timestamp + list length) ⇒ same id; (2) two materially different
screens ⇒ different ids; (3) dynamic-content tolerance — same screen with 3 vs 200 list rows ⇒ same id; plus the
degraded-input case. These are the `same-screen / different-screen / volatile-tolerance` AC of #32.

---

## 3. OQ2 — LLM provider/model, DecisionPolicy chain, prompt/IO contract, default CrawlBudget (#36, #33)

### 3.1 Provider & model

**Decision: Anthropic Claude, default model `claude-opus-4-8` (the latest/most capable Claude model per CLAUDE.md
guidance), via `@anthropic-ai/sdk`, isolated entirely inside `packages/adapters/llm`.** The model id is **config,
not a constant** (`LLM_MODEL` env → adapter config; default `claude-opus-4-8`), so it is updated without code
change and a cheaper model (e.g. a Haiku-class model) can be selected at the composition root for cost-sensitive
runs — Open/Closed via config. The provider SDK import is permitted **only** in `adapters/llm` (dependency-cruiser

- boundaries enforce; #36 AC).

* **Why Claude / why config-pinned:** CLAUDE.md mandates the most capable current Claude model; pinning by exact id
  in config (not a hardcoded literal) satisfies "no magic values" and ADR-0001 R3 ("default model deferred to the
  per-epic ADR"). `temperature` defaults low (≈0.2) for reproducible-ish decisions; `maxTokens` per call is bounded
  by config and counts against the run budget.
* **Cost amortization:** because the chain is **cache-first** (§3.2) and identity-keyed (§2), the LLM is the rare
  path. The expensive model is affordable precisely because it is seldom called.

### 3.2 The DecisionPolicy chain (Chain of Responsibility) — #36

Replaces the stub `LlmDecisionPolicy`. The chain, constructed at the composition root and injected into the loop as
the single `DecisionPolicy`:

```
CachedKnowledgePolicy  ──(cache can decide)──▶ PolicyDecision { usedLlm:false }
        │ (cache cannot decide)
        ▼
   LLMPolicy  ──(over LlmPort)──▶ PolicyDecision { usedLlm:true }, decision cached by StateIdentity
```

- **`CachedKnowledgePolicy`** (LLM-less, lives in `adapters/llm` per #36 `Touches:`, or — see §3.5 — in
  `application`; **decision in §3.5**): given `DecisionContext`, selects the next **untried** `CandidateAction` for
  `currentStateId` from accumulated per-state knowledge. "Knowledge" = the set of candidate actions known for a
  state (the a11y elements + hidden-affordance probes the frontier enumerates) minus `triedActions`. If an untried
  action exists → return it `usedLlm:false`. If none → it cannot decide → fall through.
- **`LLMPolicy`** (over `LlmPort`): consulted only on fall-through. It asks the model to choose/prioritize among
  remaining candidates or to judge "this screen looks fully explored / is a 2FA wall". Its decision is **cached
  keyed by `StateIdentity`** in a **`DecisionCachePort`** (new domain port, §3.4) so re-encounters and re-crawls
  reuse it with no new call (FR5, NFR3).
- **Resilience:** LLM call failure / timeout / unparseable output ⇒ counts toward the budget, falls back **safely**
  (return `backtrack` or `done`-for-this-state, never crash) — PRD edge case + #36 AC.

### 3.3 Prompt / IO contract (LLMPolicy ⇄ LlmPort)

Fixed here so #36 builds a stable contract (the prompt _wording_ may iterate; the IO **shape** is the contract):

- **System message:** role framing — "You are an app-exploration agent choosing the next action to maximize
  coverage of an iOS app's screens and hidden options. You never invent elements not in the candidate list."
- **User message (structured, redacted):** the **normalized a11y skeleton** (same projection as §2.2 — _not_ raw
  snapshot, keeps tokens + secrets down), the enumerated **candidate actions** (id + type + rationale), the
  **tried actions**, and `visitCount`. **No credential/typed-secret text** ever enters the prompt (NFR5; redaction
  is applied by the loop before the snapshot reaches any policy — §6).
- **Expected output:** strict JSON `{ "choice": "<candidateId>" | "backtrack" | "done", "reason": "<short>" }`,
  parsed into `PolicyDecision`. Unparseable ⇒ resilience path (§3.2). Token usage from `LlmCompletionResult`
  (`promptTokens`/`completionTokens`) is reported up so the engine counts it (FR4/FR5).

### 3.4 New domain port — `DecisionCachePort`

`#36` adds a small port (the PRD anticipates "the cache port must not preclude E7 persistence"):

```ts
// packages/domain/src/ports/DecisionCachePort.ts
export interface DecisionCachePort {
  get(stateId: StateIdentity): Promise<PolicyDecision | null>;
  set(stateId: StateIdentity, decision: PolicyDecision): Promise<void>;
}
```

E2 ships an **in-memory** implementation (process-lifetime). E7 swaps a persistent impl at the composition root —
Open/Closed, zero policy change. This is a **domain port addition** → flag to the arch-review gate (allowed: it is
an additive port, no existing contract changes; recorded here as the sanctioned change for #36).

### 3.5 Where `CachedKnowledgePolicy` lives — resolving the `Touches:` tension

The #36 ticket says `CachedKnowledgePolicy` lives in `adapters/llm`. **That is architecturally wrong: a policy that
makes _no_ LLM call and no provider-SDK call is pure application/domain logic and must not sit in the LLM provider
adapter** (it would force `application` cache wiring to reach into an adapter, and it has nothing to do with the
provider SDK). **Decision:**

- **`CachedKnowledgePolicy` → `packages/application/src/crawl/policy/CachedKnowledgePolicy.ts`** (pure, no SDK).
- **`LLMPolicy` + the chain composition (`PolicyChain`) → `packages/adapters/llm`** alongside the real
  `LlmAdapter` (these touch the provider SDK / `LlmPort`).
- The in-memory `DecisionCachePort` impl → `packages/application/src/crawl/policy/InMemoryDecisionCache.ts`
  (test-support-grade, like the in-memory graph repo, §5).

This keeps the provider SDK strictly in `adapters/llm` (NFR1) and the cost-control logic testable with **zero**
provider dependency. **Coordinator: amend #36 `Touches:` accordingly (see §8).**

### 3.6 Default `CrawlBudget` numbers (the concrete decision)

`CrawlBudget` (`models/run.ts`) currently has `maxSteps`, `maxLlmCalls`, `maxTokens`, `maxRevisitsPerState`. **#33
must add `plateauWindow`** (see OQ3 §4) — a domain edit. Defaults (a **`defaultCrawlBudget` factory** in `domain`,
config-overridable at the root — **no magic numbers in the loop**, ADR-0001 §6):

| Field                 | Default      | Rationale                                                                                                                                                                         |
| --------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxSteps`            | **400**      | Upper bound on a single-app exploration; large enough to cover a real app's screens, small enough to bound wall-clock + cost. Hit ⇒ `partial`.                                    |
| `maxLlmCalls`         | **40**       | The F2 lever. With cache-first, the LLM is the rare path; ~10% of steps is the _ceiling_, and NFR3 asserts actual ≪ this. Bounds worst-case spend.                                |
| `maxTokens`           | **120,000**  | ≈ `maxLlmCalls × ~3k tokens/call` headroom (skeleton prompt + short JSON). A hard money cap independent of call count.                                                            |
| `maxRevisitsPerState` | **3**        | Breaks A→B→A loops; 3 allows a re-entry to try a still-untried action before the engine forces backtrack.                                                                         |
| `plateauWindow`       | **40 steps** | No new state in 40 consecutive steps ⇒ coverage plateau ⇒ `partial`. ~10% of `maxSteps`; long enough to clear a deep but finite branch, short enough to not burn budget spinning. |

These are **defaults, read from config** (`CrawlBudget` is per-`Run`); the loop reads them and never hardcodes
(#33 AC). They are tuned against the FakeMobileDriver fixture for CI and re-tuned against a real app in the eval
scenarios (the values above are the documented starting point, satisfying ADR-0001 R3 "default per-run budget").

---

## 4. OQ3 — Coverage-plateau measurement & default window (#33)

**Decision.** Coverage is measured as **count of distinct `StateIdentity` nodes discovered**. The engine keeps a
sliding record of "steps since the last _new_ node id". When **`stepsSinceNewState ≥ plateauWindow`** (default 40,
§3.6) the run finalizes `status=partial` with reason `plateau`. A `BudgetWarningEvent` fires when the window is
**75% elapsed** (config `plateauWarnRatio`, default 0.75) so observers see the run winding down.

- **Why distinct-node delta over a time/edge metric:** the epic's success metric is _coverage of screens/options_;
  new **state identities** are the direct proxy. Edges/time would keep a run alive while it re-walks known states
  (defeating the cost goal). This composes cleanly with `maxRevisitsPerState`: revisit caps stop local thrash;
  plateau stops global "nothing new is happening".
- **Interaction with hidden probes (#35):** a probe that reveals a new control which leads to a new state resets
  the plateau counter — so an app whose depth is behind hidden affordances is not prematurely cut off, provided
  probes run before plateau elapses (they do: probes are part of frontier enumeration, §7).

`plateauWindow` + `plateauWarnRatio` are added to `CrawlBudget` (domain edit, #33) with the `defaultCrawlBudget`
factory. No fixed heuristic in the loop — both are config (PRD OQ3 "configurable plateau stop, not a fixed
heuristic").

---

## 5. OQ4 — In-memory state-graph store home for E2 (#31, #37)

**Decision: the in-memory `StateGraphRepository` lives in `packages/application/src/crawl/persistence/InMemoryStateGraphRepository.ts`** — a small first-class application-layer class, **not** test-only and **not** in
`adapters/persistence`. Reasons:

- **It must run in dev/CI without a DB** (PRD OQ4, FR10 integration test) — so it cannot be `*.test.ts`-only; the
  composition root and the E2E integration test both construct it.
- **It implements the existing `StateGraphRepository` PORT** (no new contract). The durable Prisma impl (E7) lives
  in `adapters/persistence` and is selected at the root — Open/Closed, single-line swap, mirroring how
  `MobileMcpDriver` is swapped (ADR-0002 §2).
- **Why application, not `adapters/persistence`:** putting an in-memory stand-in in the persistence _adapter_ would
  pollute the adapter that ADR-0001 reserves for the real Postgres impl, and would make `application` tests depend
  on an adapter (a dependency-cruiser-discouraged direction). An in-memory reference impl of a port that the engine
  needs to _run_ is application-layer infrastructure — same category as `InMemoryDecisionCache` (§3.5) and the
  `InProcessCrawlEventStream` already in `api`.

It is exercised by the unit/integration tests directly (the 85% gate bites here). E7 is explicitly out of scope and
will not need to touch this class — it adds a sibling adapter impl.

---

## 6. OQ5 — Hidden-affordance probe set vs. E1 driver coverage (#35)

**Decision.** The probe set is derived from what `MobileDriverPort` actually exposes (E1), and any probe whose
driver primitive is absent **degrades to a recorded no-op with telemetry, never a failure** (ADR-0001 R2, ADR-0002
§4 gesture-fallback rule, PRD OQ5 / #35 AC).

| Probe (hidden affordance)                | Driver primitive used                                                              | Coverage today                                                     | Degrade rule                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| **Scroll-to-reveal** off-screen controls | `swipe(udid, "up"/"down")` then re-`snapshotAccessibilityTree`                     | **Supported** (E1 `swipe` direct/fallback, ADR-0002 §4)            | n/a                                                                              |
| **Swipe-reveal** (row actions, drawers)  | `swipe(udid, "left"/"right", distance)` then re-snapshot                           | **Supported**                                                      | n/a                                                                              |
| **Overflow / "more" menu**               | `tap` on detected overflow element (it is a normal tappable, just often unlabeled) | **Supported** (it's a `tap`)                                       | n/a                                                                              |
| **Long-press / multi-touch gesture**     | requires a `longPress`/`gesture` primitive                                         | **NOT in `MobileDriverPort`** (port has `tap/typeText/swipe` only) | **No-op + telemetry**; recorded as an attempted probe with `unsupported` outcome |

- **Key finding for the coordinator:** `MobileDriverPort` (E1) exposes `tap`, `typeText`, `swipe` — **there is no
  `longPress`/`gesture` method**. So the long-press probe in #35's AC ("a control reachable only via long-press")
  **cannot be driven against the real adapter today**. Two options, **decided as follows:**
  - **For E2 / #35:** implement long-press as the **degraded path** against the real driver (no-op + telemetry),
    AND have the **FakeMobileDriver fixture** model a long-press affordance so the _probe-generation + recording
    logic_ is fully unit-tested (the `actionType:"gesture"` edge is exercised) without needing a real gesture
    primitive. This satisfies #35's AC structurally (the success-metric "≥1 control not on the primary nav
    surface" is met via **scroll-reveal + swipe-reveal**, which _are_ supported) while keeping long-press wired for
    when the port gains the primitive.
  - **Port extension is a separate, later decision:** adding `longPress`/`gesture` to `MobileDriverPort` +
    implementing it in `adapters/mobile-mcp` (WDA gesture) is **a new ADR + an E1-follow-up ticket**, not E2 work.
    E2 must not block on it. Flagged as **R-1** (§9).
- **Probe enumeration is a frontier concern** (§7, #35 extends #34's frontier): for each observed state the
  frontier yields directly-tappable candidates **plus** the supported hidden-affordance probes; each probe is a
  reified `CandidateAction` (Command pattern) with its own `actionType`, so a revealed control becomes a normal
  candidate and any transition a normal edge (FR6).

---

## 7. Layering, boundaries & the engine decomposition (the primary batching output)

### 7.1 Boundaries (confirmed, unchanged)

The engine = `application` + `domain`, depending **only on domain ports**: `MobileDriverPort`,
`StateIdentityStrategy`, `DecisionPolicy`, `DecisionCachePort`, `StateGraphRepository`, `CrawlEventStream`. It
**never** imports `adapters/*`, the MCP SDK, or the LLM SDK. The existing `.dependency-cruiser.cjs` rules
(`application-depends-only-on-domain`, `no-inward-adapter-dep`, `no-cross-adapter-dep`, `no-circular`) already
enforce this — **no new rule needed**; #36's provider-SDK-only-in-`adapters/llm` is covered by
`application-depends-only-on-domain` + the package not declaring `@anthropic-ai/sdk`. Every ticket leaves
boundaries/cruiser/coverage/gitleaks green (NFR7).

### 7.2 The decomposition pattern — pipeline of injected collaborators behind a frozen `StartCrawlRun` shell

The E1 lesson: when N tickets layer onto one unit, a dependency-free foundation ticket must land a **frozen seam +
stubs**, and each later ticket owns a **disjoint file**. The engine is **one `StartCrawlRun` use-case**, so the
analogue of E1's facade is: **#31 lands `StartCrawlRun` as a thin orchestrator that delegates each loop phase to an
injected collaborator interface, with a default trivial impl for each.** Later tickets **replace/extend the one
collaborator they own** — never the loop body, never each other's files.

```
packages/application/src/crawl/
  StartCrawlRun.ts            ← #31 owns + FREEZES (the orchestration shell; delegates every phase)
  CrawlLoop.ts                ← #31 owns (the observe→identify→decide→act→record step driver)
  collaborators.ts            ← #31 owns + FREEZES (the collaborator interfaces + defaultCollaborators())
  identity/PlaceholderIdentity.ts        ← #31 stub  → REPLACED by injecting #32's strategy (wired by #34)
  budget/BudgetEnforcer.ts               ← #33 owns (engine-owned caps + plateau)   [stub shipped by #31]
  budget/PlateauDetector.ts              ← #33 owns
  frontier/Frontier.ts                   ← #34 owns (visited/untried + backtrack)   [stub shipped by #31]
  frontier/probes/HiddenAffordanceProbes.ts ← #35 owns (extends frontier candidate enumeration)
  policy/CachedKnowledgePolicy.ts        ← #36 owns (pure, no SDK — §3.5)
  policy/InMemoryDecisionCache.ts        ← #36 owns
  persistence/InMemoryStateGraphRepository.ts ← #31 owns (the in-memory graph store, §5)
  duplicate/DuplicatePathDetector.ts     ← #37 owns
  redaction/CredentialRedactor.ts        ← #37 owns (NFR5)
  twofa/CredentialBoundaryDetector.ts    ← #37 owns (2FA detection + blocked-on-2fa)
packages/application/src/test-support/
  fakes.ts / FakeDecisionPolicy.ts       ← #31 owns (FakeDecisionPolicy + shared crawl test helpers)
  fixtures/                              ← #31 lands the dir + 2-screen fixture; #37 adds the multi-screen capstone fixture
```

**#31 is the linchpin (the E1 `#12` analogue):** it lands `StartCrawlRun`, `CrawlLoop`, the **frozen
`collaborators.ts`** (interfaces + `defaultCollaborators()` wiring), the in-memory graph repo, the placeholder
identity, **stub `BudgetEnforcer` + `Frontier`** (no-op pass-throughs so the loop compiles and the walking skeleton
runs), and the test-support `FakeDecisionPolicy` + fixtures dir. After #31:

- **#33** replaces the stub `BudgetEnforcer`/`PlateauDetector` (its own files) — the loop already calls
  `this.budget.beforeStep(...)`/`afterStep(...)`; #33 fills them. No `StartCrawlRun` edit.
- **#34** replaces the stub `Frontier` (its own files) and **injects #32's real `StateIdentityStrategy`** at the
  composition seam (the strategy is injected into `defaultCollaborators`, which #31 froze to accept it). No loop
  edit.
- **#35** adds `frontier/probes/**` and registers probes through a `Frontier` extension point #34 exposes — owns
  new files; touches `Frontier` only via the extension API #34 publishes (coordinate #34→#35 ordering, they are
  sequential by dependency anyway).
- **#36** owns `policy/**` (in `application`) + `adapters/llm` (LLMPolicy/chain/real adapter) + the
  `DecisionCachePort` (domain) — disjoint from the loop internals.
- **#37** owns `duplicate/**`, `redaction/**`, `twofa/**` (its own files), the **`packages/api` composition-root
  edit**, and the capstone fixture — it integrates, it does not rewrite collaborators.

**The one frozen shared file** — `StartCrawlRun.ts` + `collaborators.ts` — is written **once by #31** and not
edited by #33/#34/#35/#36/#37 (each calls through the collaborator interface it owns). This is the exact E1
guarantee, re-applied: foundation ticket freezes the seam; feature tickets own disjoint subtrees.

### 7.3 Avoiding the E1 shared-test-file / `vitest.config` fight

E1's Wave-1 tickets collided on shared test files + `vitest.config`. Mitigations baked in here:

- **Per-ticket test files only:** each collaborator ticket adds its **own** `src/crawl/<area>/__tests__/*.test.ts`.
  No shared mega-suite. (Mirrors ADR-0003's per-capability section runners.)
- **`application/vitest.config.ts` already globs `src/**/**tests**/**/\*.test.ts`** — so new test files need **no
  config edit**. **#31 must not narrow the glob**; if a coverage `include`/`exclude` tweak is needed, #31 makes it
  once and freezes it. **No other ticket edits `vitest.config.ts`** (flag any PR that does to the gate).
- **Shared fakes are additive, owned by #31:** `test-support/FakeDecisionPolicy.ts` + `fakes.ts` are written by
  #31 and only **imported** (never edited) by later tickets; #37 adds a _new_ fixture file, not an edit to #31's.
- **`packages/application/package.json`** gains no runtime deps (engine is port-only); #36's `@anthropic-ai/sdk`
  goes in **`adapters/llm/package.json`** only.

---

## 8. Coordinator actions — `Touches:` / `Depends-on:` edits

1. **#31 `Touches:`** → expand to: owns `packages/application/src/crawl/StartCrawlRun.ts`, `CrawlLoop.ts`,
   **frozen `collaborators.ts`**, `identity/PlaceholderIdentity.ts`, **stub** `budget/BudgetEnforcer.ts` +
   `frontier/Frontier.ts`, `persistence/InMemoryStateGraphRepository.ts`, and
   `packages/application/src/test-support/{fakes.ts,FakeDecisionPolicy.ts,fixtures/}`; may make a **one-time**
   `vitest.config.ts` coverage-include tweak then **freeze it**. (Linchpin: lands the frozen loop seam + stubs.)
2. **#32 `Touches:`** → `packages/domain/src/ports/StateIdentityPort.ts`,
   `packages/domain/src/models/state-identity/**` (default `A11ySignatureStrategy` + `CompositeStateIdentityStrategy`),
   `docs/sdlc/evals/state-identity/**`, domain barrel export. **Consumes `state-graph.ts` types only (no edit).**
3. **#33 `Touches:`** → `packages/application/src/crawl/budget/**` (replaces #31 stub) + **`packages/domain/src/models/run.ts`** (add `plateauWindow` + `plateauWarnRatio` to `CrawlBudget` + a `defaultCrawlBudget` factory) +
   **`packages/domain/src/ports/CrawlEventStream.ts`** (extend `BudgetWarningEvent.budgetType` to include
   `"revisits"` and `"plateau"`). **Add `Depends-on:` note:** domain edits to `run.ts`/`CrawlEventStream.ts` are
   small additive changes — coordinate so #36 (which also reads budget/usage) rebases after them.
4. **#34 `Touches:`** → `packages/application/src/crawl/frontier/**` (replaces #31 stub) + injects #32's strategy
   via `defaultCollaborators` (the seam #31 froze — **#34 does not edit `StartCrawlRun`/`collaborators.ts`
   signatures, only the default wiring body** if #31 left strategy injection as a TODO; preferable: **#31 already
   wires strategy as an injected param defaulting to the placeholder, so #34 only changes the default at the
   composition seam**).
5. **#35 `Touches:`** → `packages/application/src/crawl/frontier/probes/**` only; consumes the `Frontier` probe
   **extension point** #34 publishes (so #34 must expose a `registerProbeSource`/candidate-extension API — note on
   #34). Long-press is the **degraded/no-op + fake-fixture** path (§6), not a real driver gesture.
6. **#36 `Touches:`** → **corrected:** `packages/adapters/llm` (real `LlmAdapter` over `@anthropic-ai/sdk` +
   `LLMPolicy` + `PolicyChain`), `packages/application/src/crawl/policy/**` (`CachedKnowledgePolicy` +
   `InMemoryDecisionCache` — **moved out of `adapters/llm` per §3.5**), `packages/domain/src/ports/DecisionCachePort.ts`
   (new additive port) + barrel. Add `@anthropic-ai/sdk` (pinned) to **`adapters/llm/package.json` only**.
7. **#37 `Touches:`** → `packages/application/src/crawl/{duplicate,redaction,twofa}/**`,
   `packages/api/src/composition-root/wire.ts` (**edit** — construct `StartCrawlRun` from `AppPorts`; swap the stub
   `LlmDecisionPolicy` line for the real `PolicyChain`), `packages/api` integration test, and
   `packages/application/src/test-support/fixtures/` capstone fixture (**new file, not an edit to #31's fixture**).
8. **Domain port additions to flag to the arch-review gate** (sanctioned here, all additive — no existing contract
   broken): `StateIdentityPort` (#32), `DecisionCachePort` (#36), `CrawlBudget.plateauWindow/plateauWarnRatio` +
   `defaultCrawlBudget` (#33), `BudgetWarningEvent.budgetType` enum extension (#33). Anything **beyond** these
   (e.g. adding `longPress` to `MobileDriverPort`) requires a **new ADR** (R-1).

---

## 9. Consequences & risks

- **Positive:** OQ1–OQ5 are concrete; the engine is one frozen `StartCrawlRun` shell with disjoint collaborator
  subtrees, so #33/#34/#36 develop largely in parallel after #31 with **no shared-file edits** (the E1 fight is
  designed out); cost control is first-class and cache-first (the expensive Claude model is affordable because
  rarely called); the in-memory graph store + decision cache let the whole engine run in CI with no DB and no real
  LLM (NFR2 determinism, the 85% gate bites in `application`).
- **R-1 (long-press / gesture gap, from §6):** `MobileDriverPort` has no `longPress`/`gesture` primitive, so the
  long-press hidden probe cannot run against the real adapter. **Mitigation:** E2 ships it as degraded no-op +
  fake-fixture coverage; the success metric is met via supported scroll/swipe reveals. Adding the primitive is a
  **separate ADR + E1-follow-up ticket** — E2 is not blocked. Flag to coordinator as a backlog item.
- **R-2 (StateIdentity accuracy, ADR-0001 R1):** the a11y-only default may over-merge (two genuinely different
  screens with identical structure) or under-merge (volatile content not caught by the normalization rules).
  **Mitigation:** Strategy is swappable; eval scenarios (§2.3) bite in CI; the normalization rules + the E3
  embedding refinement (§2.3) are the tuning surface. `maxRevisitsPerState` + plateau bound the blast radius of
  under-merging.
- **R-3 (budget defaults are estimates):** the §3.6 numbers are tuned to the fixture, not yet a real app.
  **Mitigation:** all are config; re-tuned in the eval scenarios / E1 macOS E2E plane; the loop never hardcodes
  them.
- **R-4 (#34→#35 frontier coupling):** #35 extends #34's frontier via a published extension point; if #34 doesn't
  expose one, #35 would edit `Frontier.ts`. **Mitigation:** #34 must ship a `registerProbeSource`/candidate-source
  extension API (Open/Closed) — called out in §8 item 5; they are sequential (Depends-on) anyway.
- **Inherited boundaries:** E3 (semantics/grouping), E4 (report), E5 (dashboard/SSE), E6 (vault/2FA resume), E7
  (durable store + persistent decision cache + diffing) are out of scope; E2 binds to their ports and ships
  in-memory/degraded stand-ins. No persistence or semantic decision is made here.

---

## 10. Batching recommendation (for the coordinator)

- **Wave 0 (now, dependency-free, fully concurrent, zero file overlap):** **#31** (`packages/application/src/crawl/**`
  shell + stubs + in-memory graph repo + test-support) and **#32** (`packages/domain` StateIdentity strategy +
  evals). Disjoint packages/subtrees — exactly the PRD's "start immediately & concurrently" pair, confirmed.
- **Wave 1 (after #31 merges — the frozen seam — concurrent, disjoint subtrees):** **#33** (`crawl/budget/**` +
  the small additive `domain` `run.ts`/`CrawlEventStream.ts` edits) and **#34** (`crawl/frontier/**`, injects #32's
  strategy — so #34 also needs #32 merged). #33 and #34 touch different `crawl/*` subtrees → concurrent. **#36**
  (`crawl/policy/**` + `adapters/llm` + `DecisionCachePort`) can **also** run in Wave 1: it needs #32 (identity for
  cache keys) and #33 (budget/usage shape) per its Depends-on — so **start #36 once #32 + #33 land**; it shares no
  loop-internal file with #33/#34 (`policy/**` vs `budget/**` vs `frontier/**`). Practical sequencing: **#33 + #34
  concurrent first; #36 starts as #33 lands.**
- **Wave 2 (after #34):** **#35** (`crawl/frontier/probes/**`) — extends #34's frontier extension point; runs
  concurrently with #36 (disjoint: `probes/**` vs `policy/**`).
- **Wave 3 (after #33, #34, #35, #36):** **#37** — duplicate-path + redaction + 2FA + composition-root wiring +
  E2E integration. Integrates everything; comes last; owns the `packages/api` edit + the capstone fixture.

**Maximal concurrency:** Wave 0 = {#31, #32}; once #31 lands, {#33, #34} run together; #36 joins as soon as #33
lands; #35 joins after #34; #37 is the capstone. The only files written-once-and-frozen are `StartCrawlRun.ts` +
`collaborators.ts` (#31) and the shared test-support fakes (#31) — everything else is a disjoint subtree per
ticket.
</content>
</invoke>
