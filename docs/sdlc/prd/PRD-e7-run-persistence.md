# PRD — E7: Run persistence (crawl graph + report store, per-run history)

_Epic: #7 · Tier: MVP · Owner: product. Store choice is the architect's ADR decision — this PRD is
store-agnostic and specifies WHAT/WHY only._

## Problem & users

Today a crawl produces a `StateGraph` (persisted only via an **in-memory** `StateGraphRepository`) and a
`WorkflowMap` (returned in-memory by `BuildWorkflowMap`, never stored). Production wiring
(`packages/api/src/composition-root/wire.ts`) points the three repository ports at the `Prisma*` **stub
adapters that throw `notImplemented`**, and no `Run` record is ever created — `StartCrawlRun` never touches
`runRepository`. So every run is throwaway: nothing survives the process, and the dashboard (E5) and HTML
report (E4) have no durable source to read.

**Users:** internal developers/testers using FlowScout. They run a crawl, then expect to reopen the dashboard
later and still see that run — its workflow map, its graph, and its metadata (app, build, timestamp, status) —
plus a browsable list of all past runs. E7 is the minimal data backbone E4 and E5 sit on.

## Goals / non-goals

**Goals (MVP, single-machine demo — real crawl → HTML report + dashboard on one Mac):**

- Durable, retrievable-by-run-id storage of the three aggregates already modeled in `packages/domain`:
  `Run`, `StateGraph`, `Report` (which wraps the finalized `WorkflowMap`).
- A `Run` record created at crawl **start** and finalized at **finish**, so a crash mid-crawl leaves a
  discoverable (non-silently-lost) record.
- Automatic persistence wired into the existing crawl pipeline — a completed real crawl persists with no
  extra manual step.
- Run **history**: list past runs (newest-first, paginated) and retrieve one run's graph + report by id.
- **Zero external-service setup**: the store must initialize and run on one Mac with no separate DB server to
  install or start (product steer — urgent demo). Simplest durable store that satisfies the ACs.

**Non-goals (deferred — out of scope for E7):**

- Cross-app-version **diffing** of graphs/workflows (the ports reserve `findStatesByApp` for it; leave empty).
- **Retention / eviction / GC** policies and quota management.
- **Migrations tooling** polish (versioned migration pipeline, rollback tooling).
- **HTTP routes and dashboard UI** (E5) — E7 provides the application-layer query use-cases the dashboard calls.
- **HTML rendering** and populating `ReportMetadata.artifactUri` (E4) — E7 persists report _data_
  (WorkflowMap + counts + metadata); the rendered artifact URI is filled by E4.
- **Resume/replay** of a crashed run (E7 only guarantees the crashed run is _recorded_, not resumable).
- Choosing the concrete store/engine — that is the architect's ADR.

## Requirements

### Functional

- **FR1** — Persist a `Run` record (id, appId, appVersion, platform, budget, status, startedAt, finishedAt,
  driver/policy/schema versions) and retrieve it by id; list runs by app.
- **FR2** — Persist a run's `StateGraph` (nodes + edges + duplicate-path node ids) and retrieve it by run id;
  saving is idempotent on runId (re-save replaces, no duplication).
- **FR3** — Persist a `Report` (metadata + finalized `WorkflowMap` + counts) and retrieve it by run id.
- **FR4** — A `Run` record exists **before** the crawl completes (created at start, non-terminal state) and is
  updated to a terminal `RunStatus` with `finishedAt` at finish.
- **FR5** — After a crawl completes, persistence happens **automatically** via the composition root — the
  final graph and the assembled report are saved without a manual call.
- **FR6** — List runs **newest-first** with **pagination** (page/offset or cursor) and a way to fetch the next
  page; retrieve a single run's metadata + graph + report together by id.
- **FR7** — Unknown run id resolves to an explicit **not-found (null)**, never an error.

### Non-functional

- **NFR1 — Durability:** persisted data survives a process restart (a fresh store instance / new process
  returns the same data). Verifiable without the original in-memory objects.
- **NFR2 — Zero-setup:** initializes with no external service to install/start on the demo Mac.
- **NFR3 — Port purity:** durable implementations live in `packages/adapters/persistence`; application and
  domain layers depend only on the existing ports (`RunRepository`, `StateGraphRepository`,
  `ReportRepository`). Swapping the store is a single composition-root change (Open/Closed).
- **NFR4 — No secrets persisted:** only upstream-redacted data is stored; the persistence layer introduces no
  new secret sink (the vault owns credentials; redaction is enforced in the crawl loop before any sink).
- **NFR5 — Large graphs:** a graph with hundreds of nodes (each carrying a serialized a11y snapshot and a
  screenshot URI) round-trips without truncation or error.

## Success metrics

- After a crawl completes, its graph + report are retrievable by run id (matching runId/appId/appVersion).
- Runs appear in run history; reopening the dashboard (E5, reading E7's query use-cases) shows past runs.
- Killing the process and starting a fresh one still returns previously persisted runs.

## Edge cases & error states

- **Crash mid-crawl:** the `Run` record persisted at start remains discoverable in a non-completed state
  (`finishedAt=null` / error), i.e. the run is not silently lost. (Resume is out of scope.)
- **Empty / single-node graph:** persists and reloads as a valid (possibly empty) graph — no crash
  (mirrors `BuildWorkflowMap.emptyMap`).
- **Large graph:** hundreds of nodes/edges with serialized a11y blobs round-trip intact (NFR5).
- **Idempotent re-save:** saving the same runId's graph twice yields one graph, latest wins (FR2).
- **Unknown id:** null, not an error (FR7).
- **Empty history:** listing when zero runs exist returns an empty page, not an error.
- **Pagination bounds:** requesting a page beyond the last returns an empty page + no next cursor.

## Open questions

- **OQ1 (architect ADR — gates E7.1):** which durable store satisfies "zero external-service setup on one
  Mac"? The existing stub comment and ADR-0001 §2.7 assume **PostgreSQL + Prisma**, which requires a running
  DB server — in tension with the urgent single-machine-demo steer. The architect should (re)confirm the MVP
  store choice (e.g. an embedded/file-backed store) or explicitly rule that Postgres is required. E7.1 is
  written store-agnostic against the existing ports and depends only on this decision.
- **OQ2 (architect):** `RunStatus` (`completed | partial | blocked-on-2fa | error`) has **no in-progress
  value**. The crash-mid-crawl requirement (FR4) needs the run's non-terminal state to be representable.
  Product requirement: a started-but-unfinished run is discoverable (`finishedAt=null` convention, or an
  additive `running` status). The representation is the architect's call; the _requirement_ is fixed.
- **OQ3 (architect + E4/E5):** where does report **data** persistence stop and E4's rendered-artifact
  (`artifactUri`) begin? E7 persists the `WorkflowMap` + metadata; E4 fills `artifactUri`. Confirm the
  metadata contract so E4 only adds the URI (additive), not a schema change.

## Ticket breakdown (links to issues)

- **E7.1** — Durable run store (Run + StateGraph + Report) with roundtrip retrieval by run id. Depends only on
  the #7 store-choice ADR (OQ1). → `packages/adapters/persistence`.
- **E7.2** — Persist a run automatically through the crawl pipeline (create-at-start, finalize-at-finish, save
  report). Depends-on E7.1. → `packages/application`, `packages/api`.
- **E7.3** — Run history: list past runs (newest-first, paginated) + retrieve a run by id. Depends-on E7.1. →
  `packages/application`, `packages/api`.

(Issue numbers filled in below once created; see the epic #7 for the linked child issues.)
