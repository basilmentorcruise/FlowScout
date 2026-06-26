# PRD — E3: Semantic understanding & workflow mapping (purpose + duplicate-path detection)

- **Epic:** #3 (`type:epic`, `mvp`) — RICE 15.0 (Confidence 0.5, Effort 10). The **second half of the core
  differentiator**: turns E2's raw state graph into named, purpose-inferred, grouped end-to-end workflows and
  surfaces the duplicate/hidden paths a human missed.
- **Owner agent:** product. **Builds on E2 (delivered, #31–#37):** the connected `StateGraph`
  (`nodes`/`edges`/`duplicatePathNodeIds`), the pluggable `StateIdentityStrategy` +
  `CompositeStateIdentityStrategy` E3 seam, the `LlmPort`/`LlmAdapter`/`DecisionCachePort`/`PolicyChain` cost
  discipline, and the scaffolded-but-unpopulated `Workflow`/`WorkflowMap` domain model
  (`packages/domain/src/models/workflow.ts`).
- **Per-epic refinement is the architect's next ADR** (node-identity "sameness": tree signature + screen
  embedding + semantic label — the open design question; see Open questions OQ1). **No product code authored here.**
- **Consumed by:** E4 (HTML report — `WorkflowMap` is the report's data contract; `Report` already wraps it),
  and later E8 (test-plan generation). **Status:** ready for breakdown.

## Problem & users

**Users:** primarily FlowScout's own downstream capabilities — **E4** (renders the grouped HTML workflow report)
and **E8** (derives test plans) — and, through them, the internal developers/testers who run FlowScout to learn
what an unknown app actually does and where it has redundant/hidden paths. After E2, FlowScout can produce a
**connected state graph** but no **knowledge**: a graph of opaque node ids + edges is unreadable. Nobody can tell
from it what the app is _for_, which sequence of taps constitutes a coherent feature ("sign in", "checkout"), or
that two different-looking routes actually reach the **same outcome**.

**Problem:** A raw state graph is not a map. Three semantic problems remain, in rising difficulty:

1. **Workflow extraction** — the graph encodes transitions but not _journeys_; the end-to-end workflows
   (entry → outcome) are implicit in graph traversals and must be extracted, named, and grouped by feature.
2. **Intent inference** — what each screen/control/workflow _means_ (app purpose + per-screen/per-control intent)
   must be inferred from accessibility labels, screenshots (vision), and an LLM — within the **E2 LLM budget**,
   not via a new uncontrolled LLM path.
3. **Outcome "sameness"** (the differentiator, and the hardest, lowest-confidence part) — deciding when two
   _structurally distinct_ paths reach the **same outcome**. E2 only detects **structural** convergence (the same
   identity node reached via ≥2 paths, `duplicatePathNodeIds`). E3 must detect **semantic** sameness: two screens
   with **different** state identities that nevertheless _mean the same thing_ (e.g. "Settings" reached from a tab
   bar vs. from a deep-linked overflow menu, rendered slightly differently). This is the
   "hidden/duplicate path a human missed" promise in the success metric. It depends on an **architect ADR**
   (OQ1) before it is implementable.

## Goals / non-goals

**Goals**

- **Workflow extraction (rule-based, no LLM).** From a finalized `StateGraph`, extract end-to-end workflows
  (entry node → outcome node) as ordered `WorkflowStep[]`, populating the existing `Workflow`/`WorkflowMap` domain
  model. Deterministic; needs no LLM and no embeddings — the immediately-buildable foundation.
- **Per-screen & per-control intent inference.** Infer a concise intent/label for each screen and each control
  from accessibility labels (cheap, deterministic first pass) with an LLM/vision refinement path that **reuses the
  E2 `LlmPort` + budget/abort discipline**. Produces a structured intent model the naming/grouping step consumes.
- **App-purpose inference + workflow naming & feature grouping (LLM, budgeted).** Infer the app's overall purpose
  and assign each extracted workflow a human-readable **name** and a **feature group**, with an
  `inferenceConfidence` for every LLM-derived value (the model field already exists). All LLM calls flow through
  the **same budget-counted, cached, time-bounded path E2 established** — no new provider SDK import, no
  un-budgeted calls.
- **Screen-embedding + semantic-label identity refinement.** Activate the `CompositeStateIdentityStrategy` E3
  seam: supply the `screenEmbedding` and/or `semanticLabel` inputs (already optional on `StateIdentityInput`) so
  identity can _merge_ buckets the a11y-only hash kept distinct — **per the algorithm/threshold the architect's
  ADR fixes (OQ1)**. The a11y signature stays the authoritative coarse bucket; embeddings only refine.
- **Semantic duplicate / hidden-path detection (the differentiator).** Beyond E2's structural `DuplicatePathNodeIds`,
  detect when two workflows with **distinct** state identities reach the **same semantic outcome**, and flag the
  less-obvious one as a hidden/duplicate path (`Workflow.isHiddenPath`). On a representative app this must surface
  **≥1 genuine duplicate/hidden path** a real dev/tester confirms they had missed (the epic success metric).
- **A structured, finalized `WorkflowMap`** keyed by `runId` — the consumer contract for E4 (report) and E8 (test
  plans), assembled at a use-case + wired at the `packages/api` composition root, exercised end-to-end against a
  fixture graph with **no real LLM and no simulator** (deterministic, coverage-gateable).

**Non-goals (this epic)**

- **HTML report rendering / layout / styling** (E4). E3 produces the `WorkflowMap` data; E4 renders it. The
  `ReportRendererPort`/`HtmlReportRenderer` is out of scope here.
- **The crawl/exploration loop itself** (E2, delivered). E3 consumes the finalized `StateGraph`; it does not drive
  the simulator or extend the crawl loop.
- **Choosing the embedding model, the a11y/embedding/label weighting, and the "sameness" cosine threshold** — these
  are **research-grade** and fixed by the architect's E3 ADR (OQ1). Tickets specify the _contract_ (distinct paths
  to the same outcome merge / are flagged; volatile content tolerated), not the algorithm.
- **A new LLM provider/path.** All semantic LLM/vision inference reuses E2's `LlmPort` + `CrawlBudget`
  (`maxLlmCalls`/`maxTokens`) + `DecisionCachePort`-style caching + the `LlmAdapter` timeout/abort/redaction
  controls. No `@anthropic-ai/sdk` import outside `adapters/llm`; no un-budgeted, unbounded calls (OQ2).
- **Durable persistence of the `WorkflowMap`.** E3 binds to the repository **ports** and produces the in-memory
  `WorkflowMap`; the durable Postgres/Prisma store is **E7**. (E2's in-memory store pattern is reused.)
- **Test-plan generation** (E8) and **cross-run / version diffing of workflows** (E7) — E3 produces one run's map.

## Requirements

### Functional

- **FR1 — Workflow extraction from the graph (rule-based).** A pure extractor turns a finalized `StateGraph` into
  `Workflow[]`: identify **entry** node(s) (e.g. the launch/root state and other graph sources) and **outcome**
  nodes (terminal/leaf states, and states E2 already flagged), enumerate the distinct entry→outcome traversals as
  ordered `WorkflowStep[]` (each step carries its `stateId`, the `edge` taken, and a `description`), and bound the
  enumeration so cyclic graphs do not explode (path/length caps, config — no magic numbers). Deterministic: same
  graph ⇒ same workflows. No LLM, no embeddings.
- **FR2 — Per-screen & per-control intent inference.** For each `StateNode` and each control referenced by its
  edges, produce a concise **intent** (what this screen/control is for) via a **two-tier** strategy: (1) a
  deterministic accessibility-label pass (free, always runs); (2) an optional LLM/vision refinement that **only**
  runs through the E2 `LlmPort` and is **budget-counted and cached** (FR6). The intent model is structured (not
  free prose) so FR3 can consume it. Missing/empty a11y labels ⇒ a degraded-but-present intent, never a crash.
- **FR3 — App-purpose inference + workflow naming & feature grouping (LLM, budgeted).** Infer (a) the app's overall
  **purpose** (one-line), (b) a human-readable **name** for each extracted workflow, and (c) a **feature group**
  each workflow belongs to. Every LLM-derived value carries an `inferenceConfidence` (`ConfidenceScore`, model
  field exists); rule-derived values set it `null`. Grouping is stable and deterministic given the same inputs +
  same (faked) LLM responses. All LLM calls go through the budgeted path (FR6).
- **FR4 — Screen-embedding + semantic-label identity refinement.** Supply `screenEmbedding` and/or `semanticLabel`
  on `StateIdentityInput` and activate the `CompositeStateIdentityStrategy` merge step so that screens the
  a11y-only hash left distinct can be **merged** when they are the same screen — **using exactly the composition,
  weighting, and threshold the architect's E3 ADR fixes (OQ1)**. The a11y signature remains the authoritative
  coarse bucket (a refinement never _splits_ a bucket, only merges across buckets); embeddings/labels are the
  refinement. Behaviour is config-gated so a run can use a11y-only (E2 behaviour) or the refined identity.
- **FR5 — Semantic duplicate / hidden-path detection (differentiator).** Detect when two workflows reach the
  **same semantic outcome** despite **distinct** state identities (the case E2's structural detector misses), using
  outcome-node intent (FR2) + the refined identity (FR4) + the ADR's sameness rule (OQ1). Mark the less-prominent
  route's workflow `isHiddenPath = true` and associate the converging workflows so E4 can render "these N paths
  reach the same place". Must distinguish a **genuine** duplicate from two coincidentally-similar-but-different
  outcomes (precision matters — a false "duplicate" is worse than a miss for the success metric).
- **FR6 — Reuse the E2 LLM budget/abort discipline (no new uncontrolled path).** Every semantic LLM/vision call in
  E3 is made through the existing `LlmPort` (real impl `LlmAdapter`, confined to `adapters/llm`), is **counted
  against the `CrawlBudget`** (`maxLlmCalls`/`maxTokens`), is **time-bounded/abortable** (the `LlmAdapter` already
  enforces this), is **cached by a stable key** (the `DecisionCachePort` pattern, so re-runs reuse inference), and
  has **typed-secret/credential text redacted** before the prompt (the E2 redactor pattern). Hitting the budget
  finalizes inference gracefully with whatever was inferred (degraded, not crashed). **No semantic feature may
  import a provider SDK or open an un-budgeted LLM path.**
- **FR7 — `WorkflowMap` assembly + composition-root wiring + integration proof.** A `BuildWorkflowMap` (or
  equivalently-named) application use-case takes a finalized `StateGraph` (from the `StateGraphRepository` port) and
  produces the finalized `WorkflowMap` (`runId`, `workflows`, `finalisedAt`), constructed at the `packages/api`
  composition root from resolved ports. An integration test runs the full pipeline against a **fixture state graph**
  (multi-screen, including a convergent path and a hidden/duplicate path) + a **fake LLM**, asserting: workflows
  extracted and grouped, app purpose inferred, ≥1 semantic duplicate/hidden path flagged, every value carries a
  confidence (or `null`), and the LLM call count respects the budget — **no real LLM, no simulator**.

### Non-functional

- **NFR1 — Port purity / boundaries.** The semantic engine lives in `application`/`domain` and depends only on
  domain ports (`StateGraphRepository`, `LlmPort`/`DecisionPolicy`-family, `StateIdentityStrategy`,
  `DecisionCachePort`, a new embedding port if the ADR adds one). It must **never** import `adapters/*`, the MCP
  SDK, or any LLM/embedding provider SDK directly. Provider SDKs stay in `adapters/llm`. (eslint-boundaries +
  dependency-cruiser stay green, ADR-0001 §6, mirroring the E2 NFR1.)
- **NFR2 — Determinism / testability.** With a fixture `StateGraph` + a fake `LlmPort` (and fake/seeded embeddings),
  the whole pipeline is reproducible: same inputs ⇒ same `WorkflowMap`. This is what the application coverage gate
  bites on. No semantic feature requires a live LLM or simulator to be unit-tested.
- **NFR3 — Cost control is first-class.** Semantic inference is **cache-first and budget-bounded** (FR6). The
  deterministic a11y/rule passes (FR1, FR2 tier-1) do the bulk of the work; the LLM is the refinement, not the
  default. An assertion proves LLM-call count is bounded by `CrawlBudget` on the fixture.
- **NFR4 — Coverage.** `application` (extraction, intent, grouping, sameness, use-case) ≥ 85% line+branch; `domain`
  additions (intent model, any new ports, identity refinement) at the domain gate; any new adapter (embedding)
  covered via contract/unit tests.
- **NFR5 — Secret hygiene.** No credential values, OTP codes, typed-secret text, or PII in any LLM/embedding prompt,
  in the `WorkflowMap`, in intent strings, in caches, or in logs. Typed-secret text from a11y snapshots is redacted
  before it reaches any prompt or stored intent (reuse the E2 `CredentialRedactor` pattern). gitleaks + redaction
  stay green.
- **NFR6 — Graceful degradation.** Any inference failure (LLM timeout/parse error/budget exhaustion, missing a11y
  labels, missing embeddings) degrades to a present-but-lower-confidence result, never a crash and never a torn
  `WorkflowMap`. Every run yields exactly one finalized `WorkflowMap`.
- **NFR7 — Quality gates green.** Every ticket leaves lint, typecheck, boundaries, cycles, duplication, coverage,
  and gitleaks passing (coordinator auto-merge requires the green check).

## UX notes

No end-user UI in E3 (the report is E4; the dashboard is E5). The observable "interface" is the **`WorkflowMap`**
(`packages/domain/src/models/workflow.ts`) — its shape **is** the consumer contract E4 and E8 build against, so the
field semantics below must be honoured exactly and not changed without a coordinated E4 update.

## Consumer contract for E4 (the `WorkflowMap` shape)

E4 (and E8) consume the **existing** `WorkflowMap` model. E3 **populates** it; it must not break the shape without a
coordinated change. The contract E3 guarantees:

- `WorkflowMap { runId, workflows: Workflow[], finalisedAt }` — exactly one per finished run.
- `Workflow { id, name, description, steps: WorkflowStep[], isHiddenPath, inferenceConfidence }`:
  - `name` + `description` are human-readable (rule- or LLM-derived); `inferenceConfidence` is a `ConfidenceScore`
    for LLM-derived names/grouping and `null` for purely rule-derived ones.
  - `isHiddenPath = true` flags a workflow detected (FR5) as a duplicate/hidden route to an outcome another workflow
    also reaches.
  - `steps` are ordered `WorkflowStep { stepIndex, stateId, edge, description }`; the terminal step has `edge = null`.
- **App purpose** and **feature grouping** must be expressible on the map. If the existing model cannot carry
  app-purpose / a per-workflow feature-group without a field addition, that addition is an **additive domain change**
  (new optional field — flag to the arch-review gate, like E2's additive ports). **This is OQ3**: the architect/E4
  confirm whether purpose+group live as new optional fields on `WorkflowMap`/`Workflow` or a thin wrapper. E3 must
  not silently overload `description`. The breakdown isolates this in FR3/FR7's ticket so E4 can review the shape.

## Success metrics

- **Primary (epic success metric):** on a representative real app, FlowScout **names the app purpose correctly**,
  **groups workflows coherently**, and **flags ≥1 genuine duplicate/hidden path** to a shared outcome that a real
  dev/tester confirms they had missed. (Proven structurally in CI against the fixture graph; validated on a real
  app in the architect's eval scenarios.)
- **Workflow extraction:** every reachable outcome in the fixture graph appears as a workflow; cyclic graphs do not
  explode the enumeration (bounded by config).
- **Semantic sameness accuracy:** the sameness detector passes its eval scenarios (≥3) — distinct-identity paths to
  the same outcome are merged/flagged; genuinely different outcomes are **not** falsely merged (precision).
- **Cost control:** on the fixture, LLM-call count is bounded by `CrawlBudget` and far below the workflow/screen
  count (cache-first + deterministic-first working).
- **Consumer-readiness for E4:** a complete, well-formed `WorkflowMap` E4 can render with **no E3 code changes**.

## Edge cases & error states

- **Empty / single-node graph** (crawl found almost nothing) → a valid empty/near-empty `WorkflowMap`, not a crash.
- **Cyclic graph** (A→B→A…) → workflow enumeration is bounded (path-length / count caps, config); no infinite loop,
  no combinatorial explosion.
- **Disconnected components** (states reached only via a path E2 couldn't link) → each component's reachable
  workflows still extracted; orphans surfaced, not dropped silently.
- **Screen with no accessibility labels / vision-only content** → intent falls back to a degraded label (e.g. role +
  position), confidence reflects the degradation; never an empty/crash.
- **LLM unavailable / over budget / unparseable output** → naming/grouping/purpose degrade to rule-based or
  "unknown" with low/`null` confidence; the map still finalizes (NFR6).
- **Two coincidentally-similar but genuinely different outcomes** → must **not** be falsely flagged as a duplicate
  path (false positive is worse than a miss); the sameness rule's threshold (OQ1) guards this.
- **Genuinely dynamic outcome screen** (content changes each visit) → identity refinement tolerates volatile content
  (inherits E2's normalization); not flagged as N distinct outcomes.
- **Typed-secret text present in a node's a11y snapshot** → redacted before any prompt or stored intent (NFR5).
- **Re-run of the same app version** → cached inference (FR6) is reused; not required to persist across process
  restarts until E7, but the cache key must not preclude it.

## Open questions (for the architect's E3 ADR — do not pre-decide here)

- **OQ1 — Outcome "sameness" / node-identity composition & threshold (ADR-0001 R1; roadmap cross-cutting).** How two
  paths are judged to reach the **same outcome** — the composition of a11y-tree signature + screen embedding +
  semantic label, the weighting, and the **sameness cosine threshold** (ADR-0004 §2.3 recorded a _provisional_
  default of cosine ≥ 0.92 for the E3 merge, explicitly "to tune") — is **research-grade and deferred to the
  architect's E3 ADR**. It also fixes the **embedding model/provider** and where the embedding port lives. **The
  semantic-duplicate-detection ticket (E3.5) and the identity-refinement ticket (E3.4) are BLOCKED on this ADR**;
  the coordinator must dispatch the architect first. This PRD fixes only the contract (distinct paths to the same
  outcome merge/are flagged; genuinely different outcomes are not; volatile content tolerated), not the algorithm.
- **OQ2 — LLM/vision usage must reuse the E2 budget path (ADR-0001 R3; ADR-0004 §3).** The `LlmPort` + the
  budget-counted, cached, time-bounded, redacted call discipline E2 established (`LlmAdapter`, `CrawlBudget`,
  `DecisionCachePort`) is **the only sanctioned LLM path**. The architect's ADR fixes the **prompt/IO contract** for
  the semantic inferences (purpose / screen-intent / naming-grouping), the **cache key** for semantic results, and
  whether vision (screenshot) input is in scope for the MVP or label-only. Tickets enforce "through the budgeted
  port, redacted, cached"; they do not invent a new provider path or hardcode prompt wording as a contract.
- **OQ3 — Carrying app-purpose + feature-group on the consumer contract.** Whether the app's overall **purpose** and
  each workflow's **feature group** are new **optional additive fields** on `WorkflowMap`/`Workflow` or a thin
  wrapper model is a small design decision the architect makes **with E4's input** (E4 renders these). E3 must not
  overload `description`. Additive-only (no breaking change to the existing fields E4 builds on).
- **OQ4 — Embedding source & where it is computed.** If FR4 uses screen embeddings, the embedding may come from the
  screenshot (vision) and/or the a11y text. The model, the port shape, the adapter home (`adapters/llm` vs a new
  `adapters/embedding`), and whether embeddings are computed during the crawl (E2 emits them) or post-hoc in E3 is
  an ADR decision (folds into OQ1). E3 binds to a port and ships a deterministic fake for tests.

## Ticket breakdown (links to issues)

Vertical slices, each independently shippable. **Two are immediately eligible** (no unmet deps): **E3.1**
(workflow extraction — pure, rule-based, reads `StateGraph`, writes `Workflow[]`) and **E3.2** (per-screen/control
intent inference — new intent model + deterministic a11y pass, LLM refinement behind the budgeted port). The
**architecture ADR spike** (node-identity sameness, OQ1) must be dispatched first so it unblocks the hardest slices.
**E3.4** (identity refinement) and **E3.5** (semantic duplicate/hidden-path detection — the differentiator) are
**BLOCKED on the ADR**. **E3.3** (purpose + naming/grouping) depends on extraction + intent. **E3.6** (map assembly

- composition-root + E2E) is the capstone and comes last. The architect refines `Touches:` and fixes OQ1–OQ4 in the
  E3 ADR.

| Issue | Ticket    | Title                                                       | Effort | Depends-on             |
| ----- | --------- | ----------------------------------------------------------- | ------ | ---------------------- |
| #53   | ADR spike | Node-identity "sameness" ADR (tree sig + embedding + label) | ~1.5d  | none (architect first) |
| #54   | E3.1      | Workflow extraction from the state graph (rule-based)       | ~2d    | none                   |
| #55   | E3.2      | Per-screen & per-control intent inference (a11y + budgeted) | ~2d    | none                   |
| #56   | E3.3      | App-purpose + workflow naming & feature grouping (LLM)      | ~2d    | #54, #55               |
| #57   | E3.4      | Screen-embedding + semantic-label identity refinement       | ~2d    | #53                    |
| #58   | E3.5      | Semantic duplicate / hidden-path detection (differentiator) | ~2d    | #53, #54, #57          |
| #59   | E3.6      | WorkflowMap assembly + composition-root wiring + E2E        | ~2d    | #54, #55, #56, #58     |

**Immediately eligible (no unmet deps):** **#54 (E3.1)** and **#55 (E3.2)** — disjoint (extraction reads the graph
→ `Workflow[]`; intent builds a new intent model). The **ADR spike #53** should be dispatched to the architect
**first/concurrently** so it unblocks #57/#58. **Blocked-on-ADR:** **#57 (E3.4)** and **#58 (E3.5)** — neither is
implementable until #53 fixes the sameness composition/threshold + embedding model. **#56** unblocks after #54+#55;
**#59** is the capstone and integrates everything.
