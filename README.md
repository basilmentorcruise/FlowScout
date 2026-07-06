# FlowScout

An agent-driven platform that, given only an app name and a simulator `.app` build, autonomously explores a mobile iOS app, maps every end-to-end workflow (including hidden and duplicate paths), and renders the results as a grouped, browsable HTML report — all driven from a web dashboard. No manual scripting required.

Users are internal **developers and testers** on teams short on test coverage, product knowledge, or QA resources. See [`docs/sdlc/vision.md`](docs/sdlc/vision.md) for the full product brief.

---

## Status

MVP in progress. The simulator adapter (E1) and the autonomous crawl engine foundation (E2, tickets #31–#37) are built and merged. E3 (semantic understanding & workflow mapping) has started: E3.1 (#54) adds the pure, deterministic rule-based `WorkflowExtractor` that turns a finalized state graph into ordered entry→outcome `Workflow[]`. Epics E4–E10 are not yet started.

See [`STATUS.md`](STATUS.md) for the per-epic table, and the [GitHub Project board #4](https://github.com/orgs/basilmentorcruise/projects/4) for live ticket tracking.

---

## What is built

**E1 — Mobile MCP adapter** (`packages/adapters/mobile-mcp`): full `MobileDriverPort` + `SimulatorLifecycle` implementation over `mobile-next/mobile-mcp`. Covers MCP connection and transport bootstrap, simulator lifecycle (boot / install `.app` / launch / shutdown via `simctl`), device driving (accessibility-tree snapshot, screenshot, tap, typeText, swipe with gesture-fallback), disposable-state snapshot and reset (`simctl clone` primary / erase fast-path), health and readiness checks, per-capability conformance contract tests, and `FakeMobileDriver` for deterministic engine testing. Composed via a thin facade (`MobileMcpDriver`) wired at the composition root in `packages/api`.

**E2 — Autonomous crawl engine** (`packages/application`): a `StartCrawlRun` use-case that runs an observe → identify → decide → act → record loop. Includes: `A11ySignatureStrategy` for screen state identity (deterministic hash of the normalized accessibility tree, volatile-content tolerant); `Frontier` with visited tracking, backtrack, and dead-end handling; `BudgetEnforcer` and `PlateauDetector` enforcing per-run step caps, LLM-call caps, token budget, revisit caps, and plateau termination; hidden-affordance probes (scroll-reveal, swipe-reveal, overflow menu — long-press is wired as a degraded no-op pending port extension); a `CachedKnowledgePolicy` → `LLMPolicy` chain (Chain of Responsibility) where the cache selects untried actions LLM-lessly and falls through to the LLM only when no known action remains; `LlmAdapter` over `@anthropic-ai/sdk` (Anthropic Claude, model id is config — default `claude-opus-4-8`, overridable via `LLM_MODEL_ID` env); `InMemoryDecisionCache` (process-lifetime, replaced by E7's persistent store); `CredentialRedactor` stripping secrets from prompts and events; and `CredentialBoundaryDetector` for 2FA/OTP surface detection with blocked-on-2fa state transition.

**E7 — Run persistence** (`packages/adapters/persistence`, `packages/application`, `packages/api`): a durable, zero-setup embedded-SQLite run store (`better-sqlite3`, ADR-0008 — Postgres deferred behind the same repository ports) with deterministic proto-safe JSON payload codecs, WAL + one-transaction saves, a save-time redaction guard, and a shared `@flowscout/testing-persistence` port-conformance suite passed by both the SQLite adapter and the in-memory reference repos. The `RunAndPersist` orchestrator auto-persists every crawl through the composition root: a `Run` row is created `running`/`finishedAt:null` **before** the crawl (crash-discoverable), the graph persists incrementally through the durable repo, and on the terminal crawl event the finalized `WorkflowMap` is assembled into a `Report` (`artifactUri: ""` until E4 renders) and the run is finalized with status + `finishedAt`; store failures are recorded as `status:"error"`, never silently lost. Remaining: run-history queries (#85).

**Foundation**: hexagonal monorepo scaffold, full CI pipeline, pre-commit hooks, and all domain ports and models.

## What is planned (not yet built)

| Tier | Epics                                                                                                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MVP  | E2.7 duplicate-path detector + composition-root wiring (open, #37); E3 semantic understanding + workflow mapping; E4 grouped HTML report; E5 web dashboard; E6 credential vault + 2FA resume; E7 run-history queries (#85 — the durable SQLite store #83 and the auto-persist write path #84 are built) |
| V1   | E8 test-plan generation                                                                                                                                                                                                                                                                                 |
| V2   | E9 human-like test authoring + execution; E10 release gates + CI integration                                                                                                                                                                                                                            |

---

## Architecture

FlowScout uses a **hexagonal (ports-and-adapters)** architecture across a TypeScript monorepo. The dependency rule is strictly enforced: `domain` depends on nothing; `application` depends only on `domain` ports; `adapters/*` implement those ports; `api` wires everything at the composition root; `web` imports domain types and the API contract only. See [ADR-0001](docs/sdlc/architecture/ADR-0001-stack-and-reference-architecture.md) for the full stack decision and layering diagram.

```
packages/
  domain/           # Pure domain: state-graph, workflow, report models, all port interfaces. No I/O.
  application/      # Use-cases and crawl engine. Depends only on domain ports.
  adapters/
    mobile-mcp/     # MobileDriverPort + SimulatorLifecycle over mobile-next/mobile-mcp
    llm/            # DecisionPolicy chain + LlmAdapter over @anthropic-ai/sdk
    persistence/    # Durable embedded-SQLite run store (better-sqlite3, ADR-0008)
    vault/          # CredentialVaultPort (stub; AES-256-GCM implementation in E6)
    report-html/    # ReportRendererPort (stub; HTML renderer in E4)
  api/              # Fastify HTTP + SSE backend; composition root; thin transport layer
  web/              # React + Vite dashboard SPA (MVVM); stub UI
  config/           # Shared ESLint, tsconfig, and Vitest presets (DRY tooling)
```

Additional architecture decision records: [ADR-0002](docs/sdlc/architecture/ADR-0002-mobile-mcp-adapter-decomposition.md) (Mobile MCP adapter decomposition), [ADR-0003](docs/sdlc/architecture/ADR-0003-per-capability-conformance-harness.md) (per-capability conformance harness), [ADR-0004](docs/sdlc/architecture/ADR-0004-crawl-engine-state-identity-policy-budgets.md) (crawl engine state identity, policy chain, budgets).

---

## Prerequisites

- **Node.js** >= 22 (matches `mobile-next/mobile-mcp` floor)
- **pnpm** 11.8.0 (pinned; enforced by `packageManager` field)
- macOS with Xcode and iOS Simulator — required only for the real-simulator E2E lane (see below); unit and integration tests run on any OS

---

## Setup

```sh
pnpm install
```

Copy `.env.example` to `.env` and fill in the required values (see the file for descriptions). Never commit `.env` or any secret.

---

## Commands

All commands run across the monorepo via Turborepo's cached task graph.

| Command                   | What it does                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm lint`               | ESLint (strict TypeScript-ESLint + security SAST)                                                       |
| `pnpm typecheck`          | `tsc --noEmit` across all packages                                                                      |
| `pnpm test`               | Vitest unit + integration tests; enforces >= 80% line and branch coverage on `domain` and `application` |
| `pnpm build`              | Compile all packages                                                                                    |
| `pnpm run depcruise`      | Architecture boundary and circular-dependency check (dependency-cruiser)                                |
| `pnpm run jscpd`          | Duplication check                                                                                       |
| `pnpm run format`         | Prettier format (all TS, JSON, YAML, Markdown)                                                          |
| `pnpm run e2e:round-trip` | Real-simulator round-trip E2E (macOS + Xcode + iOS Simulator required; see below)                       |

Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` locally before opening a PR — this is the same sequence the CI pipeline executes.

---

## CI

The per-PR CI pipeline (`.github/workflows/ci.yml`, Ubuntu, required for merge) runs:

```
install → SCA (pnpm audit, prod deps) → lint+SAST → typecheck
  → architecture/cycle check (dependency-cruiser) → duplication (jscpd)
  → test + coverage gate (>= 80% line+branch on domain+application) → build → secret scan (gitleaks)
```

A pre-commit hook (husky + lint-staged) runs the fast subset — lint, typecheck, affected tests, gitleaks — before every local commit so problems surface before CI.

### macOS real-simulator E2E

A separate, non-required CI job (`.github/workflows/e2e-macos.yml`) runs the full round-trip against a real iOS Simulator. It triggers on manual `workflow_dispatch` or when a PR is labelled `e2e-macos`. It requires:

- A macOS runner with Xcode and iOS Simulator
- A simulator-compatible `.app` fixture (tracked in issue #29 — not yet available as a committed artifact)
- `FLOWSCOUT_FIXTURE_APP`, `FLOWSCOUT_FIXTURE_BUNDLE_ID`, and `FLOWSCOUT_APP_BUNDLE_DIR` set as repository secrets or workflow inputs

If `FLOWSCOUT_FIXTURE_APP` is unset the job exits cleanly with a skip message. The `.app` fixture itself is in progress (issue #29).

---

## Environment variables

See `.env.example` for the full, annotated list with placeholder values. Key variables:

| Variable                           | Used by                    | Description                                                                                         |
| ---------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| `FLOWSCOUT_VAULT_KEY`              | `adapters/vault`           | Master key for AES-256-GCM credential encryption (32-byte hex; required when vault is active)       |
| `FLOWSCOUT_DB_PATH`                | `adapters/persistence`     | Path to the embedded SQLite run store (ADR-0008); default `./.flowscout/flowscout.db`, zero-setup   |
| `LLM_API_KEY`                      | `adapters/llm`             | Anthropic API key (required; never logged or committed)                                             |
| `FLOWSCOUT_MCP_SERVER_COMMAND`     | `adapters/mobile-mcp`      | Comma-separated argv to launch the MCP server (default: `npx,mobile-mcp`)                           |
| `FLOWSCOUT_MCP_CONNECT_TIMEOUT_MS` | `adapters/mobile-mcp`      | MCP connection timeout in ms (default: 10000)                                                       |
| `FLOWSCOUT_MCP_CALL_TIMEOUT_MS`    | `adapters/mobile-mcp`      | Per-tool-call timeout in ms (default: 30000)                                                        |
| `FLOWSCOUT_APP_BUNDLE_DIR`         | `adapters/mobile-mcp`, E2E | Allowlisted base directory for `.app` bundles; required for the real-simulator E2E lane             |
| `FLOWSCOUT_FIXTURE_APP`            | E2E lane                   | Path to the fixture `.app` (must be inside `FLOWSCOUT_APP_BUNDLE_DIR`); leave unset to skip the E2E |
| `FLOWSCOUT_FIXTURE_BUNDLE_ID`      | E2E lane                   | Bundle identifier of the fixture `.app`; required when `FLOWSCOUT_FIXTURE_APP` is set               |
| `FLOWSCOUT_E2E_SIM_UDID`           | E2E lane                   | iOS Simulator UDID; if unset the harness picks the first booted simulator                           |

---

## Key documents

| Document                                                                        | Description                                           |
| ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| [`docs/sdlc/vision.md`](docs/sdlc/vision.md)                                    | Product brief — problem, users, scope, success metric |
| [`docs/sdlc/roadmap.md`](docs/sdlc/roadmap.md)                                  | RICE-ranked epic roadmap (MVP / V1 / V2)              |
| [`docs/sdlc/architecture/`](docs/sdlc/architecture/)                            | ADR-0001 through ADR-0004                             |
| [`STATUS.md`](STATUS.md)                                                        | Per-epic progress snapshot                            |
| [GitHub Project board #4](https://github.com/orgs/basilmentorcruise/projects/4) | Live ticket tracking                                  |
| [`CLAUDE.md`](CLAUDE.md)                                                        | Project context for the autonomous SDLC agent system  |
