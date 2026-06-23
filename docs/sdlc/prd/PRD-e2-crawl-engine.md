# PRD — E2: Autonomous crawl & state-graph engine (option discovery incl. hidden)

- **Epic:** #2 (`type:epic`, `mvp`) — RICE 12.5 (Confidence 0.5, Effort 12). The differentiating core and the
  highest-risk MVP epic. E3 (semantic mapping) and E4 (HTML report) consume its output.
- **Owner agent:** product. **Aligns with:** ADR-0001 §2.5 (crawl engine + agent loop), §2.7 (persistence),
  §3.4 (decision policy). E2's per-epic refinement is the architect's next ADR (state-identity strategy +
  policy chain + budget defaults — see Open questions). **Builds on E1 (delivered):** the `MobileDriverPort` +
  `SimulatorLifecycle` adapter and `FakeMobileDriver`.
- **Status:** ready for breakdown. No product code authored here.

## Problem & users

**Users:** primarily FlowScout's own downstream capabilities (E3 semantic mapping, E4 HTML report, E5 dashboard
live-crawl view, E7 persistence) and, indirectly, the internal developers/testers who run FlowScout to discover
what an unknown app actually does. Today FlowScout can _drive_ a simulator (E1) but cannot _explore_ one: there
is no loop that decides what to do, records where it has been, or builds a map.

**Problem:** Real apps accrete features and hidden options nobody documented. Given only an installed app, there
is no autonomous way to discover every option — visible **and** hidden (long-press, swipe-reveal, overflow menus,
off-screen/scrolled controls) — and record exploration as a connected, queryable map. Two further hard problems
make this the riskiest epic: (1) **LLM cost** — naive per-step LLM calls do not scale; and (2) **state-node
identity** — deciding when two screens/paths are "the same" is what makes the map connected and powers
duplicate/hidden-path detection. Both are flagged as open design questions in the roadmap and ADR-0001 (R1, R3).

## Goals / non-goals

**Goals**

- A working **autonomous crawl loop** in `packages/application` that, given a booted simulator with the app
  launched (via the E1 `SimulatorLifecycle`/`MobileDriverPort`), repeatedly **observes → identifies state →
  decides next action → acts → records**, building a connected `StateGraph` (domain model already defined) and
  publishing `CrawlEvent`s over `CrawlEventStream`.
- A **pluggable `StateIdentity` strategy** (Strategy pattern) that computes a stable node identity from an
  accessibility-tree signature, with screen-embedding + semantic-label inputs designed as additive composables —
  so two distinct paths reaching the same screen resolve to the same node (the basis of duplicate-path detection).
- **Hard cost/termination controls enforced by the engine** (not the policy): per-run step cap, LLM-call cap,
  token-budget cap, per-state revisit cap, and coverage-plateau termination — all from `CrawlBudget` config (no
  magic numbers). Hitting any cap finalizes the run gracefully with a partial map + reason, never silently spins.
- A **layered `DecisionPolicy`** (Chain of Responsibility): a **CachedKnowledgePolicy** that picks most actions
  LLM-lessly from accumulated per-state knowledge, falling through to an **LLMPolicy** only when the cache cannot
  decide — the F2 cost mitigation. LLM reasoning is cached/persisted keyed by state identity for reuse.
- **Hidden-option discovery:** the engine probes beyond the primary navigation surface — long-press, swipe-reveal,
  overflow/more menus, and off-screen/scrolled controls — recorded as edges like any other action.
- **Frontier/visited tracking** with loop, dead-end, and backtrack handling so exploration makes forward progress
  and terminates.
- **Duplicate/hidden-path detection** recorded on the graph (`duplicatePathNodeIds`): nodes reached by multiple
  distinct edge-paths.
- The whole engine is **unit-testable with no simulator and no real LLM** — against `FakeMobileDriver` and a fake
  `DecisionPolicy` — exercising state-identity, caps/budgets, hidden-path probing, duplicate detection, and the
  2FA-pause event boundary.

**Non-goals (this epic)**

- **Semantic understanding** of what a screen/workflow _means_, screen grouping, purpose inference, and the final
  duplicate-path _semantics_ (E3). E2 records the graph and the structural fact that two paths converge; E3
  interprets it.
- **HTML report rendering** (E4) and **dashboard live view** (E5). E2 emits `CrawlEvent`s; consumers render them.
- **Durable persistence** of the graph. E2 binds to the `StateGraphRepository` **port**; the real
  PostgreSQL/Prisma implementation is E7. E2 ships with an in-memory repository adapter for tests/dev so the
  engine is exercisable end-to-end without a database (see OQ4).
- **Credential vault internals + actual 2FA resume** (E6). E2 must _detect_ a credential/2FA surface and emit the
  `CredentialPromptEvent` + enter the `blocked-on-2fa` terminal/pause state; the vault and resume flow are E6.
- **The E1 driver/simulator lifecycle** itself (delivered). E2 only consumes the port.
- **Choosing the LLM provider, embedding model, and concrete budget numbers** — fixed as ports + caps here;
  concrete values are the architect's per-epic ADR (OQ1, OQ2).

## Requirements

### Functional

- **FR1 — Crawl loop use-case.** A `StartCrawlRun` use-case (application layer) runs the loop:
  `observe (MobileDriverPort.snapshotAccessibilityTree + screenshot) → identify (StateIdentity) → decide
(DecisionPolicy) → act (MobileDriverPort.tap/typeText/swipe/gesture) → record (StateGraph node/edge +
CrawlEventStream)`. It depends only on domain ports; it never imports a concrete adapter.
- **FR2 — State-graph construction.** Each newly observed state is added as a `StateNode` (id from StateIdentity,
  label, a11y snapshot, screenshot URI); each action is recorded as a `StateEdge` (from→to, actionType,
  payload). The graph is connected: revisiting a known state resolves to the existing node, not a new one.
- **FR3 — StateIdentity strategy.** A `StateIdentity` strategy computes a stable identity for a screen from its
  accessibility-tree signature (initial, mandatory input), structured so screen-embedding and semantic-label
  inputs can be composed in additively without changing the loop. Cosmetic/volatile differences (e.g. timestamps,
  dynamic list content) must not, by default, fork identity for otherwise-identical screens. The strategy is
  swappable behind a port/interface and has its own test scenarios.
- **FR4 — Budget & termination enforcement (engine-owned).** The engine enforces, from `CrawlBudget` config:
  `maxSteps`, `maxLlmCalls`, `maxTokens`, `maxRevisitsPerState`, plus a coverage-plateau stop (no new states for
  N steps, N configurable). Each cap nearing/at its limit emits a `BudgetWarningEvent`; reaching a terminal
  condition finalizes the run with a `CrawlFinishedEvent` carrying `status` (`completed` | `partial`) and a
  reason. Caps are enforced by the engine regardless of what any policy returns.
- **FR5 — Decision policy chain.** A composable `DecisionPolicy` chain: (1) **CachedKnowledgePolicy** selects the
  next untried action for the current state from accumulated knowledge with no LLM call; (2) **LLMPolicy** (over
  the `LlmPort` / `LlmAdapter`) is consulted only when the cache cannot decide. LLM call/token usage is counted
  toward the budget (FR4) and reported in `PolicyDecision.usedLlm`. LLM decisions are cached keyed by state
  identity so re-crawls/version-diffs reuse them.
- **FR6 — Hidden-option discovery.** Beyond enumerating directly-tappable elements, the engine probes
  hidden-affordance action types from a state: long-press/gesture, swipe-reveal (e.g. row actions, drawers),
  overflow/"more" menus, and scrolling to surface off-screen controls. Newly revealed controls become candidate
  actions and discovered transitions become edges. On a representative app this must reach ≥1 control not present
  on the primary navigation surface (the epic success metric).
- **FR7 — Frontier, loop & dead-end handling.** A frontier/visited model tracks per-state untried actions.
  Re-entering a fully-explored or revisit-capped state triggers backtrack (`PolicyDecision.backtrack`) toward a
  state with unexplored actions; a dead end (no actions, nowhere to backtrack) contributes to termination. The
  loop must not livelock between two states.
- **FR8 — Duplicate / hidden-path detection (structural).** When a state node is reached via ≥2 distinct
  edge-paths, its id is recorded in `StateGraph.duplicatePathNodeIds`. (Semantic interpretation of duplicates is
  E3; E2 records the structural fact.)
- **FR9 — Credential / 2FA boundary.** When the crawl reaches a login/OTP/2FA surface it cannot proceed past, the
  engine emits a `CredentialPromptEvent` (redacted — no credential values) and enters `blocked-on-2fa`,
  finalizing the run with that status. (Vault-backed credential supply + resume is E6; E2 owns detection + the
  event + the pause state.)
- **FR10 — Composition-root wiring + integration proof.** `StartCrawlRun` is constructed at the `packages/api`
  composition root from the resolved ports (`AppPorts`/`AppContext` already defined). An integration test runs the
  full loop against `FakeMobileDriver` (a scripted multi-screen fixture app, including a hidden-control screen and
  a convergent/duplicate path) + a real CachedKnowledgePolicy + a fake LLM, asserting a connected graph,
  ≥1 hidden control reached, ≥1 duplicate-path node, and graceful budget termination.

### Non-functional

- **NFR1 — Port purity / boundaries.** The engine lives in `application`/`domain` and depends only on domain
  ports (`MobileDriverPort`, `DecisionPolicy`/`LlmPort`, `StateGraphRepository`, `CrawlEventStream`,
  `StateIdentity`). It must never import `adapters/mobile-mcp`, the MCP SDK, or any LLM provider SDK directly
  (eslint-plugin-boundaries + dependency-cruiser stay green, ADR-0001 §6).
- **NFR2 — Determinism / testability.** With a deterministic `FakeMobileDriver` and fake policy/LLM, a crawl is
  reproducible: same fixture + same budget ⇒ same graph. This is what the 85% application coverage gate bites on.
- **NFR3 — Cost control is first-class.** Budgets are config (no magic numbers, ADR-0001 §6) and emitted as
  telemetry; most actions on a typical run are taken without an LLM call (the cache-first design is the F2
  mitigation, verified by an assertion that LLM-call count ≪ step count on the fixture).
- **NFR4 — Coverage.** `application` (crawl engine + policies + use-cases) ≥ 85% line+branch; `domain` additions
  (StateIdentity, graph helpers) at the domain gate; any LLM/state-store adapter covered via contract/unit tests.
- **NFR5 — Secret hygiene.** No credential values, OTP codes, or secrets in `CrawlEvent`s, the state graph
  (a11y snapshots may contain typed text — typed credential text must be redacted before recording), logs, or LLM
  prompts. gitleaks + redaction stay green.
- **NFR6 — Graceful finalization.** No terminal condition (cap, plateau, dead-end, 2FA, error) leaves the run
  hanging or the simulator in an undefined state; every run ends with exactly one `CrawlFinishedEvent`.
- **NFR7 — Quality gates green.** Every ticket leaves lint, typecheck, boundaries, cycles, duplication, coverage,
  and gitleaks passing (coordinator auto-merge requires the green check).

## UX notes

No end-user UI in E2 (the dashboard is E5; the report is E4). The observable "interface" is the **`CrawlEvent`
stream** (already typed in `CrawlEventStream`) and the **`StateGraph`** it produces — these are the contract E3,
E4, and E5 consume, so event ordering and the `crawl:started … crawl:finished` envelope must be correct and
complete. Operator-facing concerns (2FA prompt copy, live progress) surface in E5; E2 only emits the events.

## Success metrics

- **Primary (epic success metric):** on a representative real app, the engine produces a **connected state graph**
  covering the major screens and **reaches ≥1 control not on the primary navigation surface**, within a bounded
  step/cost budget. (Proven structurally in CI against the FakeMobileDriver fixture; validated against a real app
  in the architect's eval scenarios / E1 macOS E2E plane.)
- **Cost control:** on the fixture crawl, LLM-call count is far below step count (cache-first working) and the run
  respects every configured cap.
- **Identity accuracy:** the StateIdentity strategy passes its eval scenarios (≥3 per ADR-0001 §7) — same screen ⇒
  same id across paths; materially different screens ⇒ different ids.
- **Duplicate-path detection:** the fixture's convergent path is recorded in `duplicatePathNodeIds`.
- **Engine-readiness for E3/E4:** a complete, well-ordered `CrawlEvent` stream + persisted-via-port graph that E3
  can consume with no E2 code changes.

## Edge cases & error states

- **Empty / oversized accessibility snapshot** → handled, not swallowed; state still gets an identity (degraded)
  or the step is skipped with telemetry, never a crash.
- **No actionable controls on a screen** (dead end) → backtrack; if no backtrack target, contributes to
  termination.
- **Action has no observable effect** (tap changes nothing) → not infinite-retried; recorded and the action is
  marked tried so the frontier advances.
- **Loop between two states** (A→B→A→B…) → revisit cap + plateau detection break it.
- **State that is genuinely dynamic** (changes every observation) → must not explode the graph into unbounded
  near-duplicate nodes; the identity strategy tolerates volatile content by design (FR3) and the revisit cap bounds it.
- **Budget exhausted mid-step** → finish the in-flight step's recording, then finalize `partial` with reason; no
  torn state.
- **Login / 2FA wall reached** → `CredentialPromptEvent` + `blocked-on-2fa`, redacted (FR9, NFR5).
- **LLM call fails / times out / returns unparseable output** → counts toward budget, falls back safely (skip
  state or backtrack), never crashes the run; surfaced as telemetry.
- **Driver action throws** (stale element, off-screen coordinate, timeout from E1) → caught, recorded as a failed
  action, frontier advances; repeated driver failures contribute to termination, not a hang.
- **Typed text into a credential field** → redacted before it can land in the a11y snapshot record / events
  (NFR5).
- **Re-crawl of a previously-seen app version** → cached LLM decisions keyed by state identity are reused (FR5);
  not required to persist across process restarts until E7, but the cache port must not preclude it.

## Open questions (for the architect's E2 ADR — do not pre-decide here)

- **OQ1 — StateIdentity composition & thresholds (ADR-0001 R1).** The signature is
  accessibility-tree-signature + screen-embedding + semantic-label, behind a swappable `StateIdentity` strategy.
  Which embedding/model, how the three inputs are weighted/combined, and the sameness threshold are
  **research-grade and deferred to the architect's ADR**. This PRD fixes only the observable contract (same screen
  across paths ⇒ same id; tolerate volatile content) and that the strategy is pluggable with eval scenarios.
  Tickets specify the contract, not the algorithm.
- **OQ2 — LLM provider, prompt design & budget defaults (ADR-0001 R3).** The `LlmPort` + the chain
  (CachedKnowledgePolicy → LLMPolicy) + the engine-owned caps are fixed. The concrete provider/model, prompt
  structure, the cache key/representation of "state knowledge", and the **default `CrawlBudget` numbers** (steps,
  LLM calls, tokens, revisits, plateau window) are **deferred to the architect's ADR**. Tickets enforce the caps;
  they do not hardcode the numbers.
- **OQ3 — Coverage-plateau & termination tuning.** How "coverage plateau" is measured (states-discovered delta
  over a window) and its default window is a tuning decision for the ADR; E2 implements a configurable plateau
  stop, not a fixed heuristic.
- **OQ4 — State-graph store for E2.** E2 binds to the `StateGraphRepository` **port** and ships an **in-memory**
  implementation so the engine is exercisable without a DB; the durable PostgreSQL/Prisma implementation is E7
  (persistence stubs already present, ADR-0001 §2.7). Confirm the in-memory adapter's home (test-support vs. a
  small `adapters/persistence` in-memory class) in the ADR. No conflicting persistence decision is made here.
- **OQ5 — Hidden-affordance coverage vs. E1 driver gestures (ADR-0001 R2).** Some hidden-option probes
  (long-press, multi-touch gestures) depend on what the E1 mobile-mcp adapter can actually drive (E1 OQ2 / ADR-0002).
  If a probe type has no driver support, that probe is a no-op with telemetry, not a failure. The architect
  confirms gesture coverage against the pilot fixture; E2 degrades gracefully where coverage is missing.

## Ticket breakdown (links to issues)

Vertical slices, each independently shippable. The **walking-skeleton loop (E2.1)** and the **StateIdentity
strategy (E2.2)** are dependency-free and start immediately and concurrently (E2.1 touches the application
use-case + in-memory graph; E2.2 touches a new domain strategy module — disjoint). Sophistication (budgets,
frontier, hidden-path, policy chain) layers on after. The architect refines `Touches:` and fixes OQ1–OQ5 in the
E2 ADR.

| Issue | Ticket | Title                                              | Effort | Depends-on         |
| ----- | ------ | -------------------------------------------------- | ------ | ------------------ |
| #31   | E2.1   | Walking-skeleton crawl loop use-case               | ~2d    | none               |
| #32   | E2.2   | StateIdentity strategy (a11y signature, pluggable) | ~1.5d  | none               |
| #33   | E2.3   | Budget & termination enforcement (engine-owned)    | ~1.5d  | #31                |
| #34   | E2.4   | Frontier / visited + loop & dead-end handling      | ~2d    | #31, #32           |
| #35   | E2.5   | Hidden-option discovery probes                     | ~2d    | #34                |
| #36   | E2.6   | DecisionPolicy chain (CachedKnowledge → LLM)       | ~2d    | #32, #33           |
| #37   | E2.7   | Duplicate-path detection + composition-root + E2E  | ~2d    | #33, #34, #35, #36 |

**Dependency-free, start immediately & concurrently:** #31 (E2.1) and #32 (E2.2). #31 builds the loop + in-memory
graph in `packages/application`; #32 adds the `StateIdentity` strategy in `packages/domain` — disjoint modules.
**Concurrency after #31 lands:** #33 (budgets). After #31 + #32: #34 (frontier). #36 (policy chain) unblocks once
#32 + #33 land and shares no engine-loop files with #35 (which extends the driving/probe path). #37 integrates and
must come last.
