# ADR-0001 — Stack & Reference Architecture (Foundational)

- **Status:** Accepted
- **Date:** 2026-06-20
- **Mode:** plan (foundational stack / reference-architecture ADR)
- **Scope:** Epics E1–E10; MVP = E1–E7. This ADR sets the stack, layering, and mandated tooling for FlowScout itself.
- **Supersedes:** none. Per-epic ADRs (ADR-0002+) refine within these constraints; deviations require a new ADR.

---

## 1. Context

FlowScout is a greenfield, agent-driven platform that, given only an app name + a simulator `.app` build,
autonomously crawls an iOS app in a simulator **via Mobile MCP**, semantically maps every end-to-end workflow
(incl. hidden/duplicate paths), and renders a grouped, browsable **HTML report**, all driven and observed from a
**web dashboard**. MVP is Understand-&-Document (iOS). Later: test-plan generation (V1), authored/run tests as
release gates (V2). Android is explicitly post-MVP, behind a platform abstraction.

Hard forces shaping this ADR (from `vision.md`, `roadmap.md`):

- **F1 — Mobile MCP is a Node/TypeScript ecosystem.** `mobile-next/mobile-mcp` is an npm-distributed MCP server
  (Node ≥ 22). It controls iOS Simulators via WebDriverAgent, exposing accessibility snapshots + screenshot &
  coordinate taps. It is the validated, best-maintained driver (roadmap "Method & evidence"). This is the single
  biggest stack-pull and also the **top dependency risk** — it must sit behind a clean port (vision Risk).
- **F2 — LLM cost is the dominant crawl risk** (LLM-Explorer / arXiv 2505.10593): viable only with accumulated
  state "knowledge" driving most actions LLM-lessly, plus step/budget caps. Cost control is a first-class concern,
  not an afterthought.
- **F3 — FlowScout's own UI is a web dashboard** with live crawl observation (streaming) + the HTML report as a
  first-class view, run management, and credential management.
- **F4 — Persistence must be schema-aware and version-diff-ready:** per-run crawl state-graph + reports must later
  support cross-app-version diffing (vision Open Questions, roadmap E7).
- **F5 — Encrypted credential vault at rest**, reused per app across runs; secrets via env/secret store, never
  committed (`.gitignore` already hardens `.env*`, `secrets/`, `*.pem`, `*.key`).
- **F6 — No in-flow safety guardrails** (owner decision); rely on dedicated test accounts + disposable/snapshotted
  simulator state. Snapshot/reset is a foundation (E1) capability.
- **F7 — Coverage is a gate:** ≥80% line + branch on business/domain logic, wired into CI **and** local hooks.

---

## 2. Decision

### 2.1 Language / runtime — TypeScript on Node.js (LTS ≥ 22), single language end-to-end

**Decision:** One TypeScript/Node codebase for agent orchestration, the MCP client, the backend/API, and the web
dashboard.

**Why:**
- **F1 dominates.** Mobile MCP is Node/TS-native; an in-process Node MCP client (`@modelcontextprotocol/sdk`)
  avoids a cross-language bridge and version-skew on the riskiest dependency.
- **One language, one toolchain** (DRY at the tooling layer): a single linter, type system, test runner, and
  coverage gate across crawl engine, API, and UI. **Domain types are shared** between backend and dashboard
  (the state-graph and report contracts are defined once and imported by both) — no DTO drift.
- TypeScript's structural types and discriminated unions model the **crawl state-graph and report schema**
  precisely (node identity, action results, workflow grouping) with compile-time guarantees.
- Async I/O (MCP calls, LLM calls, simulator waits, SSE/WebSocket streaming) is Node's core strength.

**Alternatives weighed:** Python for orchestration. Rejected for the MVP spine: it would split the stack
(Python orchestrator + Node MCP subprocess + JS dashboard = three toolchains, two coverage configs, an IPC
seam on the riskiest dependency). The LLM-orchestration ergonomics gap vs Python is small (the LLM provider SDKs
are first-class in TS) and does not outweigh the single-language wins. **Not foreclosed:** the LLM "reasoning"
work sits behind a `DecisionPolicy` port (§3.4), so a Python sidecar could be introduced later for a specific
policy without disturbing the engine — an extensibility point, not an MVP cost.

**Runtime baseline:** Node LTS ≥ 22 (matches mobile-mcp's floor). Package manager **pnpm** (workspaces, strict,
fast). **Monorepo via pnpm workspaces + Turborepo** for cached, dependency-aware task graphs.

### 2.2 Module topology (monorepo packages)

```
flowscout/
  packages/
    domain/        # pure domain: state-graph, workflow model, report model, ports (interfaces). NO I/O.
    application/   # use-cases / orchestration: crawl engine, agent loop, services. Depends on domain ports only.
    adapters/
      mobile-mcp/  # Mobile MCP driver adapter  (implements MobileDriverPort)   <-- F1 isolation
      llm/         # LLM provider adapter        (implements DecisionPolicy/LLMPort) <-- F2 cost control
      persistence/ # store adapter              (implements graph/report/run repos) <-- F4
      vault/       # encrypted credential vault  (implements CredentialVaultPort)  <-- F5
      report-html/ # HTML report renderer        (implements ReportRendererPort)
    api/           # backend: HTTP + streaming; thin transport over application use-cases
    web/           # dashboard SPA (MVVM); consumes api; imports domain types only
    config/        # shared lint/tsconfig/test presets (DRY tooling)
```

**Dependency rule (enforced, §6):** `domain` depends on nothing; `application` depends only on `domain` (ports);
`adapters/*` depend on `domain` + their SDK; `api` wires `application` + adapters via DI; `web` imports only
`domain` types + the `api` HTTP contract. **No inward dependency on adapters** — the Dependency Inversion
Principle is the structural invariant of the whole system.

### 2.3 Backend / API — layered hexagonal Node service

- **Framework:** Fastify (TypeScript-first, schema-driven validation, low overhead, native streaming). The HTTP
  layer is a **thin adapter** (presentation) that translates requests into `application` use-case calls — no
  business logic in route handlers (separation of concerns).
- **Live crawl streaming:** **Server-Sent Events (SSE)** for the live crawl feed (one-directional server→client
  event stream — simplest fit; avoids WebSocket complexity for the MVP). Crawl events are published by the engine
  to an event bus port; the API adapter relays them to SSE subscribers. (WebSocket remains an alternative behind
  the same `CrawlEventStream` port if bidirectional control is needed later.)
- **DI:** constructor injection wired in a single **composition root** in `api` (and a parallel root for any CLI
  entry). No service-locator, no global singletons. Adapters are selected at the composition root, so swapping
  Mobile MCP or the store is a one-line change there.

### 2.4 Web dashboard — MVVM SPA

- **Stack:** React + TypeScript + Vite. **State/VM layer:** view-models own state and orchestration; **views are
  passive** (render VM state, emit intents). Server-state via TanStack Query (caching, invalidation); the live
  crawl view subscribes to the SSE stream through a VM. This is MVVM applied by name: components = passive views,
  hooks/stores = view-models, the typed API client = the model boundary.
- **Report view:** the grouped HTML report is rendered server-side by `adapters/report-html` (a first-class,
  shareable artifact per the success metric) and surfaced in the dashboard as a first-class view (embedded +
  downloadable). The dashboard does **not** re-implement report layout — DRY across the two surfaces.
- **Minimal public surface:** the dashboard talks only to the documented API contract; no direct store/vault access.

### 2.5 Autonomous crawl engine + agent orchestration (E2/E3, the differentiating core)

Lives in `application`, orchestrating domain + ports. Structured as an explicit **agent loop** rather than an
opaque framework:

- **State-graph (domain):** nodes = app screens/states; edges = actions (tap/scroll/input/gesture). **Node
  identity** is computed from a composable signature — accessibility-tree signature + screen embedding +
  semantic label (the roadmap's open question) — behind a `StateIdentity` strategy (Strategy pattern) so the
  identity function is tunable without touching the loop. **Duplicate/hidden-path detection** = multiple distinct
  edge-paths resolving to the same identity node; recorded on the graph, surfaced in the report.
- **Crawl loop (application):** a frontier/worklist explorer. Each step: observe (via `MobileDriverPort`) →
  identify state → consult **`DecisionPolicy`** for the next action → act → record. Patterns: **State** (crawl
  phases: bootstrapping / exploring / blocked-on-2FA / exhausting), **Command** (each action is a reified,
  loggable, replayable command), **Observer** (engine publishes crawl events to the stream port).
- **F2 cost control (first-class, in the loop):**
  - `DecisionPolicy` is a port with a **layered/chained policy** (Chain of Responsibility): (1) a **cached
    knowledge policy** that picks actions LLM-lessly from accumulated state knowledge (per LLM-Explorer), falling
    through to (2) an **LLM policy** only when the cache cannot decide.
  - **Hard caps enforced by the engine, not the policy:** per-run **step cap**, **LLM-call/token budget cap**,
    and per-state revisit cap. Budgets are config (no magic numbers, §6) and emitted as crawl telemetry. When a
    cap is hit the run finalizes gracefully (partial map + reason), never silently spins.
  - LLM responses keyed by state identity are **cached/persisted** so re-crawls and version-diffs reuse prior
    reasoning (cost amortization across runs — ties to F4).
- **Snapshot/reset (E1, F6):** a `SimulatorLifecycle` capability on the driver port (boot / install `.app` /
  snapshot / reset) so a destructive real-data run can be reset between runs. No in-flow guardrails.

### 2.6 Mobile MCP integration behind a port (F1 — the headline risk mitigation)

- **Server choice:** **`mobile-next/mobile-mcp`** — the best-maintained Mobile MCP server, confirmed to control
  **iOS Simulators via WebDriverAgent**, exposing **accessibility snapshots + screenshot + coordinate taps** and
  gestures. This matches the brief's required driver layer (roadmap "Method & evidence"). Pinned by exact version.
- **Port:** `domain` defines `MobileDriverPort` (+ `SimulatorLifecycle`) — the only abstraction the engine knows:
  `listDevices`, `bootSimulator`, `installApp(.app)`, `launchApp`, `snapshotAccessibilityTree`, `screenshot`,
  `tap(coord|element)`, `typeText`, `swipe/gesture`, `snapshot/reset`. **The engine never imports the MCP SDK.**
- **Adapter:** `adapters/mobile-mcp` is the **only** package depending on `@modelcontextprotocol/sdk` +
  mobile-mcp. It launches/connects to the MCP server (stdio), maps port calls ↔ MCP tools, and normalizes the
  accessibility/screenshot payloads into domain types. **Anti-corruption layer** — MCP's vocabulary never leaks
  inward.
- **Swappability / Android-later:** because the engine binds to `MobileDriverPort`, an alternate driver (a
  different MCP server, a direct WebDriverAgent client, or an Android adapter) is added by writing a new adapter
  and selecting it at the composition root — Open/Closed. **Contract tests** (§7) run against every adapter so
  conformance is guaranteed, and a `FakeMobileDriver` enables deterministic engine tests with no simulator.

### 2.7 Persistence — schema-aware store for state-graph + reports (F4, E7)

- **Decision:** **PostgreSQL** (relational, schema-migrated, queryable) as the system of record, accessed through
  repository ports (`RunRepository`, `StateGraphRepository`, `ReportRepository`) defined in `domain` and
  implemented in `adapters/persistence`. **Prisma** for typed access + versioned migrations.
- **Why relational + schema-aware:** cross-app-version **diffing** (vision Open Q, E7) needs stable, queryable
  entities (app → version → run → states/edges/workflows) with explicit, migration-tracked schema evolution —
  not opaque blobs. Per-run history and provenance are normalized; large artifacts (screenshots, rendered HTML)
  go to object/file storage referenced by URI (keeps the relational store lean).
- **Graph in a relational store:** the state-graph is modeled as `states` + `edges` tables keyed by run and by
  `state_identity`; diffing across versions = set/graph comparison over `state_identity`. (A dedicated graph DB
  is an alternative — rejected for MVP: operational weight without a proven query need; the repository port keeps
  it swappable if graph queries dominate later.)
- **Schema versioning:** every run records the FlowScout schema version + driver version + policy/budget config,
  so historical runs remain interpretable and diffs compare like-for-like.

### 2.8 Encrypted credential vault (F5, E6)

- **At rest:** credentials stored **encrypted** via authenticated symmetric encryption (**AES-256-GCM**, Node
  `crypto`), scoped per app, behind `CredentialVaultPort` in `domain`, implemented in `adapters/vault` over the
  persistence store. Plaintext exists only transiently in memory at use time.
- **Key management:** the master key comes from **env / secret store only** (`FLOWSCOUT_VAULT_KEY`), never
  committed, never persisted with the ciphertext. `.gitignore` already blocks `.env*`, `secrets/`, keys. A
  `.env.example` documents required vars with placeholders.
- **2FA pause-and-ask:** when the crawl hits an OTP/2FA surface, the engine transitions to a `blocked-on-2FA`
  state, emits a `CredentialPrompt` event over the crawl stream, and **awaits** an operator-supplied code via the
  dashboard, then resumes. Modeled as a first-class crawl state, not an exception. (Automated OTP retrieval is
  explicitly out of scope.)
- **Hygiene:** secrets/credentials are redacted from logs, crawl events, and the report renderer (a cross-cutting
  redaction concern in the application layer). The security gate (OWASP) owns deeper review.

---

## 3. Reference architecture / layering (hexagonal)

```
              ┌───────────────────────── presentation ─────────────────────────┐
              │  web (React MVVM SPA)        api (Fastify HTTP + SSE adapter)    │
              └───────────────▲───────────────────────────▲────────────────────┘
                              │ typed API contract         │ use-case calls
              ┌───────────────┴───────────────────────────┴────────────────────┐
              │                       application                                │
              │   crawl engine · agent loop · use-cases · cross-cutting          │
              │   (depends ONLY on domain ports)                                 │
              └───────────────▲───────────────────────────▲────────────────────┘
                              │ ports (interfaces)         │
              ┌───────────────┴────────────┐  ┌────────────┴───────────────────┐
              │           domain            │  │            adapters            │
              │ state-graph · workflow ·    │  │ mobile-mcp · llm · persistence │
              │ report model · PORTS · pure │  │ vault · report-html            │
              └─────────────────────────────┘  └────────────────────────────────┘
                         (no I/O)              (implement domain ports; outermost)
```

- **Ports (domain interfaces):** `MobileDriverPort` (+`SimulatorLifecycle`), `DecisionPolicy`/`LLMPort`,
  `RunRepository`/`StateGraphRepository`/`ReportRepository`, `CredentialVaultPort`, `ReportRendererPort`,
  `CrawlEventStream`.
- **Composition root** (in `api`, mirrored for CLI): the only place that names concrete adapters and wires DI.
- **Extensibility points (Open/Closed, by extension not modification):** new mobile driver / Android adapter;
  new `DecisionPolicy` link (e.g. heuristic, cheaper model, Python sidecar); pluggable `StateIdentity` strategy;
  alternate report renderers; alternate stores — all added as new implementations selected at the root.
- **Smell guards:** no god objects (engine delegates to ports + strategies); no anemic domain (state-graph and
  workflow model own behavior + identity, not just data); no primitive obsession (value objects for identity,
  budgets, credentials); no circular deps (the dependency rule forbids them, enforced in CI §6).

---

## 4. Alternatives considered (summary)

| Area | Chosen | Rejected alternative | Why |
|------|--------|----------------------|-----|
| Language | TS/Node end-to-end | Python orchestrator + Node MCP | Avoids 3 toolchains + an IPC seam on the riskiest dep; shared domain types; LLM SDKs are first-class in TS. Python kept as a future policy sidecar behind `DecisionPolicy`. |
| API framework | Fastify | Express / Nest | Fastify: TS-first, schema validation, low overhead, native streaming; Nest's DI/structure we get via the hexagonal layout without the framework lock-in. |
| Live updates | SSE | WebSocket | One-way server→client stream is the actual need; SSE is simpler/robust. WS stays available behind `CrawlEventStream`. |
| Persistence | PostgreSQL + Prisma | Graph DB / document store | Version-diffing needs stable, queryable, migration-tracked schema; relational models the graph adequately; repo port keeps it swappable. |
| Crawl orchestration | Explicit in-house agent loop | Heavyweight agent framework | Cost-control caps + state-identity + replayability must be first-class and inspectable; a generic framework would hide exactly what carries the risk (F2). |
| Mobile driver | mobile-next/mobile-mcp behind port | Direct Appium/WDA, or no abstraction | Confirmed iOS-sim capability + best maintained; the port (not the server) is the real commitment, satisfying the swappability/Android-later mandate. |

---

## 5. Consequences & risks

**Positive:** single toolchain + shared types; the top dependency risk (Mobile MCP) and the top cost risk (LLM)
are each isolated behind a port with caps; schema-aware store makes version-diffing a query, not a rewrite;
hexagonal layout makes Android and alternate policies additive.

**Risks / open questions for the coordinator:**
- **R1 — State-identity accuracy (E2/E3, Confidence 0.5).** The signature (a11y + embedding + semantic label) is
  research-grade; mis-identification breaks duplicate-path detection. Mitigation: `StateIdentity` is a swappable
  strategy with its own eval scenarios; tune on a representative real app. *Open: which embedding/model.*
- **R2 — mobile-mcp gesture/deep-state coverage.** If a target app needs gestures the server can't drive, the
  adapter is the blast radius, not the engine. *Open: confirm gesture coverage against the chosen pilot app.*
- **R3 — LLM provider choice + budget defaults** are deferred to the per-epic ADR/PRD; the port + caps are fixed
  here, the concrete model/budget numbers are not. *Open: default model + per-run token budget.*
- **R4 — Object-storage target for screenshots/HTML** (local FS for dev; S3-compatible later). Deployment target
  is out of scope (vision), so MVP uses local file storage behind the repository's artifact URI. *Open: prod target.*
- **R5 — Real-data exploration has no in-flow guardrails (owner decision).** Relies on dedicated test accounts +
  snapshot/reset (E1). Architecturally honored; operationally a standing risk the owner accepted.

**Touches (foundational — establishes all modules):** `packages/domain`, `packages/application`,
`packages/adapters/{mobile-mcp,llm,persistence,vault,report-html}`, `packages/api`, `packages/web`,
`packages/config`, repo root tooling (`.github/workflows/ci.yml`, hooks, `pnpm-workspace.yaml`, `turbo.json`).
Per-epic plans carve disjoint slices from these for concurrent tickets.

---

## 6. Mandated quality tooling + CI / local hooks

All wired into **both** CI and **local pre-commit / Claude Code PreToolUse-on-commit** hooks so problems are
caught before CI. Configs live in `packages/config` (DRY) and are referenced by every package.

| Concern | Tool | Gate |
|---------|------|------|
| Lint + style | **ESLint** (typescript-eslint, strict) + **Prettier** | zero errors |
| Types | **tsc --noEmit**, `strict: true` | zero errors |
| Architecture boundaries | **eslint-plugin-boundaries** / `import/no-restricted-paths` | enforces the §2.2 dependency rule (no inward adapter deps, no cross-layer leaks) |
| Circular deps | **dependency-cruiser** | zero cycles (smell guard) |
| Complexity | ESLint `complexity` + `max-depth`/`max-lines-per-function` | bounded; no magic numbers (`no-magic-numbers`) |
| Duplication | **jscpd** | under threshold |
| Tests + coverage | **Vitest** (+ coverage v8) | **≥80% line AND branch** on `domain` + `application` (business/domain logic) |
| Secrets | **gitleaks** | zero findings (defense alongside `.gitignore`) |

**Per-layer coverage targets (recorded per the standard):** `domain` ≥ 90% line/branch (pure logic, cheap to
cover); `application` (crawl engine, policies, use-cases) ≥ 85%; `adapters/*` covered via contract tests + a
realistic harness (no hard global %, but each port's contract suite is mandatory); `api` covered by integration
tests over use-cases; `web` view-models unit-tested (views thin). The **80% line+branch gate is enforced on
`domain`+`application`** in CI.

**CI (`.github/workflows/ci.yml`, replacing the placeholder):** on PRs to `main`, a Turborepo-cached pipeline:
`install → lint → typecheck → boundaries/cycles → duplication → test+coverage(gate) → build`, plus `gitleaks`.
This is the required green check for the coordinator's auto-merge policy.

**Local hooks:** a pre-commit hook (e.g. lefthook/husky) runs `lint-staged` + typecheck + affected tests +
gitleaks on staged files; the Claude Code **PreToolUse-on-commit** hook runs the same fast subset so an agent
cannot commit code that would fail CI. Hooks run the *affected* subset (fast); CI runs the full graph.

---

## 7. Testing strategy + E2E

- **Unit (domain/application):** Vitest, fast, no I/O. The crawl engine is tested against a **`FakeMobileDriver`**
  and a **fake `DecisionPolicy`** — deterministic, no simulator, no LLM. Covers state-identity, duplicate-path
  detection, cap/budget enforcement (F2), and 2FA-pause flow. This is where the 80% gate bites.
- **Adapter contract tests:** every implementation of `MobileDriverPort`, the repositories, and the vault runs a
  **shared contract suite** so any swapped driver/store/Android adapter is provably conformant (the F1 mitigation
  is verifiable, not aspirational).
- **Integration:** `api` use-cases over a real Postgres (ephemeral container) + the persistence/vault adapters;
  no mocked DB for migration-sensitive paths.
- **E2E — two distinct planes (note for QA / the coordinator):**
  1. **FlowScout's own services:** QA stands up `api` + `web` + Postgres (compose) and drives the dashboard
     end-to-end (start a run, observe the live stream, browse the report, supply a 2FA code) against a
     **fake/replayed Mobile driver** for determinism.
  2. **FlowScout driving a target app's simulator:** a separate, slower suite where the **real**
     `adapters/mobile-mcp` boots an iOS Simulator and installs a small known fixture `.app`, asserting the
     produced state-graph/report. This is the true end-to-end and is run on a macOS runner (Simulators are
     macOS-only) — kept out of the per-PR fast path, gated separately by QA.
- **Eval scenarios:** state-identity and the crawl policy each ship ≥3 eval scenarios (per AGENT_SYSTEM authoring
  rules) under `docs/sdlc/evals/`, exercised against a representative real app for the success metric.

---

## 8. Notes for downstream agents

- **Per-epic ADRs** (ADR-0002+) refine *within* this ADR: E1 details the mobile-mcp adapter + snapshot/reset; E2/E3
  detail the state-identity strategy + policy chain + budgets; E4 the report renderer; E5 the dashboard VMs + SSE;
  E6 the vault crypto + 2FA flow; E7 the schema + diffing model.
- **Do not** introduce business logic in `api` route handlers or in React views, depend inward on any adapter,
  hardcode budgets/keys, or call the MCP SDK outside `adapters/mobile-mcp`. The arch-review gate checks these.
