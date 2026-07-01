# ADR-0008 — E7 Run Store: embedded SQLite, run lifecycle, and report-data boundary

- **Status:** Accepted
- **Date:** 2026-07-02
- **Mode:** plan (E7 epic #7 — run persistence)
- **Scope:** `packages/adapters/persistence/**` (durable impls), `packages/domain/src/models/{report,run}.ts` +
  `packages/domain/src/ports/RepositoryPorts.ts` (additive), `packages/application/**` (write-path orchestrator +
  read-side query use-cases + in-memory reference repos), `packages/api/src/composition-root/**` (wiring), and a
  new `packages/testing/persistence` test-support package (shared port-conformance suite).
- **Amends:** **ADR-0001 §2.7** (PostgreSQL + Prisma). See §1.4 — Postgres is deferred behind the same ports;
  MVP ships embedded SQLite. §2.7's relational modeling rationale is preserved, not discarded.
- **Driven by:** PRD `PRD-e7-run-persistence.md` open questions OQ1/OQ2/OQ3 + owner steer: **urgent
  single-machine demo (one Mac, real crawl → HTML report + dashboard), zero external-service setup.**

---

## 1. Decision 1 (OQ1) — the durable store: embedded SQLite via `better-sqlite3`

**Ship an embedded, file-backed SQLite store (`better-sqlite3`) as the MVP system of record**, implementing the
three existing repository ports in `packages/adapters/persistence`. One file on disk
(`FLOWSCOUT_DB_PATH`, default `./.flowscout/flowscout.db`); **no server, no daemon, no docker** — the store
initializes itself (`CREATE TABLE IF NOT EXISTS`) on first construction. This satisfies NFR2 (zero-setup) and
NFR1 (durability across process restart) directly.

### 1.1 Options weighed

| Option                                       | Zero external setup       | Durable / ACID                                                | Query (paginate, by-app)                | Postgres-swap path                    | Verdict                                                                                                                                                        |
| -------------------------------------------- | ------------------------- | ------------------------------------------------------------- | --------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SQLite + `better-sqlite3`**                | ✅ single file, no server | ✅ WAL + synchronous txns                                     | ✅ SQL indexes                          | ✅ same relational shape behind ports | **Chosen**                                                                                                                                                     |
| SQLite + Prisma                              | ✅ (no server)            | ✅                                                            | ✅                                      | ✅ trivial datasource swap            | Rejected for MVP: adds `prisma generate` + migration CLI ceremony — friction against "urgent, no tooling polish". Kept as the natural Postgres on-ramp (§1.4). |
| Structured on-disk file store (JSON per run) | ✅                        | ⚠️ multi-file atomicity hand-rolled; no txn across aggregates | ⚠️ dir-scan for list/paginate; no index | ⚠️ bespoke, throwaway                 | **Rejected** — see §1.2                                                                                                                                        |

### 1.2 Why not the file store

A JSON-file-per-run store meets zero-setup but fails the harder requirements cheaply: (a) **crash-safety** —
writing Run + StateGraph + Report as separate files has no cross-file transaction, so a crash mid-write can
leave a torn run; SQLite gives a single ACID transaction per save. (b) **history/pagination** (FR6) — newest-
first paginated listing across all apps becomes a full directory scan + in-memory sort; SQLite gives an indexed
`ORDER BY started_at DESC` with a cursor. (c) **diffing on-ramp** (kept-open goal) — `findStatesByApp` is a
cross-run query; a relational store answers it with an index, a file tree cannot. SQLite is the _simplest thing
that is still correct_ here — YAGNI is satisfied by not standing up Postgres, not by hand-rolling a database.

### 1.3 Storage shape — hybrid (indexed columns + JSON payload)

Each aggregate is one row: **indexed scalar columns for the queries E7 actually runs**, plus a **single
`payload` TEXT column holding the deterministically-serialized aggregate** (§3). This keeps roundtrip fidelity
(NFR5: hundreds of nodes with a11y blobs round-trip intact) without prematurely normalizing states/edges.

```
runs(   id PK, app_id, app_version, platform, status, started_at, finished_at,
        driver_version, policy_version, schema_version, payload TEXT )
        INDEX(app_id), INDEX(started_at DESC, id DESC)            -- history + by-app
graphs( run_id PK, app_id, app_version, payload TEXT )            -- upsert on run_id (FR2 idempotent)
reports(report_id PK, run_id UNIQUE, app_id, run_status, generated_at, payload TEXT )
        INDEX(run_id), INDEX(app_id)
```

`payload` is the source of truth for reload; scalar columns are derived duplicates used only for filtering /
ordering / provenance. Idempotent upserts (FR2) are `INSERT … ON CONFLICT(run_id) DO UPDATE`.

### 1.4 Amendment to ADR-0001 §2.7 (explicit)

ADR-0001 §2.7 mandated **PostgreSQL + Prisma** as the system of record. **For the MVP this ADR supersedes that
choice with embedded SQLite.** What stands from §2.7: the **repository-port abstraction** (the only seam the app
knows), the **relational modeling intent** (runs → graphs → reports, keyed by run and app), and **schema/driver/
policy versioning per run** (already fields on `Run`). What changes: the concrete engine is SQLite, not Postgres,
and states/edges are stored as a JSON payload rather than normalized tables **for now**. **Postgres remains the
documented scale-out target**: because all access is through `RunRepository` / `StateGraphRepository` /
`ReportRepository`, swapping to Postgres (or Prisma) is a single composition-root change (NFR3, Open/Closed) plus
a new adapter — no application/domain edit. The diffing on-ramp (`findStatesByApp`, normalized `states` table)
is additive when it lands; §2.7's normalized-graph design is deferred, not deleted.

---

## 2. Decision 2 (OQ2) — in-progress / crashed run representation

**Add an additive `"running"` member to `RunStatus`, AND keep the `finishedAt === null` convention. Both.**

```ts
export type RunStatus =
  | "running" // NEW — created at crawl start, not yet finalized
  | "completed"
  | "partial"
  | "blocked-on-2fa"
  | "error";
```

- **Lifecycle:** the write-path orchestrator (#84) persists the `Run` at **start** with `status:"running"`,
  `finishedAt:null` — discoverable _before_ the crawl completes (FR4). At **finish** it updates to the terminal
  status + sets `finishedAt` via `RunRepository.update`.
- **The discoverability predicate is `finishedAt === null`** (robust even if a crash left a stale status);
  `status:"running"` _labels_ the state for the dashboard. A process kill mid-crawl leaves the row
  `running / finishedAt:null` — present and non-corrupt (a single-row write already committed), never silently
  lost. A caught in-process error updates to `status:"error"` + `finishedAt:now` (still non-completed).
- **Why not `finishedAt=null` alone (no new status):** a null-only convention forces a _running_ run to borrow a
  terminal label (e.g. `partial`), which is indistinguishable from a legitimately-finished partial run except by
  a second field — a code smell (primitive/temporal coupling). An explicit member is self-documenting and
  additive.
- **Safety of the additive union:** verified there is **no exhaustive `switch(status)` with a `never` guard in
  any `src`** today (only `packages/domain` type decls + a report-html _test_), so the new member does not break
  compilation. The dev that lands it (#83) runs `typecheck` across the monorepo to confirm.

**Ownership:** the `RunStatus` edit lands in **#83** (it also owns the port-shape edit in §4), so #84/#85 consume
`"running"` without a domain edit.

---

## 3. Decision 3 (OQ3) — report-data vs rendered-artifact boundary (E7 ↔ E4)

**Confirmed additive. E7 persists report _data_; E4 later populates `artifactUri` via the same `save` upsert —
no schema change.**

- `ReportMetadata.artifactUri` is **already a field** (typed `string`). E7 writes it as the documented sentinel
  **`""` (empty ⇒ not yet rendered)**. E4 renders the HTML and re-saves the `Report` through the existing
  `ReportRepository.save` (idempotent upsert on `run_id`), setting the real URI. E4 adds **no** column and **no**
  new port method — it flips one already-present field.
- E7 fills everything else: `reportId`, `runId`, `appId`, `appVersion`, `generatedAt`, `runStatus`,
  `schemaVersion`, the finalized `WorkflowMap`, and the three counts (`totalStates` = `graph.nodes.size`,
  `totalWorkflows` = `workflowMap.workflows.length`, `duplicatePathCount` = `graph.duplicatePathNodeIds.size`).
- **Boundary rule (record for E4/E5):** E7 owns Report _rows_; E4 owns `artifactUri` _value_ + the HTML file it
  points to. `save` is upsert-by-runId so E4's write is a partial update, not a create — the contract is stable.

---

## 4. Decision 4 — additive port surface for paginated cross-app history (FR6)

`RunRepository.findByAppId(appId, limit?)` cannot express **newest-first, cross-app, cursor-paginated** history
(the dashboard lists _all_ runs, not per-app). **Add one method + two DTOs to the port** (additive, domain):

```ts
export interface ListRunsOptions { readonly limit: number; readonly cursor?: string | null; }
export interface RunPage { readonly runs: readonly Run[]; readonly nextCursor: string | null; readonly total: number; }
// on RunRepository:
listRuns(options: ListRunsOptions): Promise<RunPage>;
```

- **Ordering/cursor:** newest-first by `(started_at, id)` descending; the opaque `cursor` encodes the last row's
  `(started_at, id)` → SQL `WHERE (started_at,id) < (?,?) ORDER BY started_at DESC, id DESC LIMIT ?`. `total` =
  `COUNT(*)`. Beyond-last page ⇒ `{ runs:[], nextCursor:null }` (edge case), empty store ⇒ same.
- **Ownership:** this port edit lands in **#83** so the durable + in-memory impls implement it and **#85 is a
  pure application/api read layer** with no domain edit. `findStatesByApp` stays returning empty (diffing
  deferred).

---

## 5. Decision 5 — deterministic serialization codec (crash-safety + future diffing)

`StateGraph.nodes` (Map) and `duplicatePathNodeIds` (Set) are not JSON-native, and future graph diffing needs
**byte-stable** output. A **pure codec** (`GraphCodec` / `ReportCodec` / `RunCodec`) in the persistence package:

- Maps → arrays sorted by key (`StateIdentity` string); Sets → sorted arrays; object keys emitted in a fixed
  order. Same aggregate ⇒ identical bytes across runs/processes (determinism; enables `diff` later).
- Decode rebuilds `Map`/`Set` so a reloaded `StateGraph` is **deep-equal** to the saved one (E7.1 AC).
- Codec is I/O-free and unit-tested for round-trip + determinism; it is the single serialization concern (DRY,
  SRP). No secret/PII handling here — redaction is upstream (NFR4); the codec only asserts (defense-in-depth) it
  introduces no new sink (a comment + a test that a known-redacted marker survives unchanged, nothing more).

**Crash-safety:** each `save*` runs in one `better-sqlite3` transaction (synchronous, all-or-nothing); WAL mode
(`PRAGMA journal_mode=WAL`) is set at init so a crash cannot leave a half-written row.

---

## 6. Decision 6 — write-path mechanism (E7.2): an outer orchestrator, not a StartCrawlRun collaborator

`StartCrawlRun`'s public constructor is **frozen** (E2 memory / ADR-0004). **Do not** add `runRepository` to its
collaborators. Instead introduce an application-layer **orchestrator use-case** (`RunAndPersist`) that composes
the existing pieces (Facade / Orchestrator pattern):

1. `runRepository.save(run)` with `status:"running"`, `finishedAt:null` (FR4 — before crawl).
2. subscribe to `crawlEventStream` for this `runId` to capture the terminal `crawl:finished` (carries `status`)
   / `crawl:error` event (StartCrawlRun already emits these; `execute()` returns `void`, so the event stream —
   not a return value — is the status channel; no frozen signature is touched).
3. `await startCrawlRun.execute(input)` — the graph is persisted incrementally by the crawl through the _durable_
   `stateGraphRepository` (once #83 is wired), so the graph write-path already works.
4. on the terminal event: `buildWorkflowMap.execute(runId)` → `assembleReport(run, graph, map)` (pure factory) →
   `reportRepository.save(report)`; then `runRepository.update(id, { status: terminal, finishedAt: now })`.
5. on a thrown/aborted crawl: `update(id,{ status:"error", finishedAt: now })` in a `finally`/catch; an
   uncatchable process kill leaves `running/null` — both remain discoverable (FR4 edge case).

`assembleReport` is a pure domain-shaped factory (no I/O) in application. This keeps SRP: the crawl crawls, the
map-builder builds, the orchestrator owns run lifecycle + report persistence.

---

## 7. Decision 7 — shared port-conformance suite (E1 per-capability pattern) in a neutral test package

Mirroring ADR-0003, the contract is a set of **per-port section runners** that **every** implementation (durable
SQLite + in-memory reference) must pass:

```
runRunRepositoryContract({ createRepository, reopen?, fixtures })
runStateGraphRepositoryContract({ createRepository, reopen?, fixtures })
runReportRepositoryContract({ createRepository, reopen?, fixtures })
runPersistenceContractSuite(...)          // thin aggregator (all three)
```

- `createRepository()` returns a fresh empty repo. **`reopen?`** is the durability seam: when supplied (durable
  impl), the suite runs the **"save → reopen fresh instance → still deep-equal"** assertions (NFR1); when omitted
  (in-memory), those are skipped — everything else (roundtrip, idempotent upsert, null-on-unknown, `findByAppId`,
  `listRuns` ordering/pagination, empty-page bounds) runs for both. This is the exact ISP-clean split from
  ADR-0003 (§1.3): shared behavior is impl-agnostic; durability is an injected capability.
- **Home (layering-critical):** a new package **`@flowscout/testing-persistence`** at `packages/testing/persistence/`,
  **depending on `@flowscout/domain` only**. dependency-cruiser forbids `application`/`adapters` → `adapters`
  but **not** → `packages/testing/`, so both `@flowscout/adapter-persistence` (SQLite) and `@flowscout/application`
  (in-memory) consume it as a **devDependency** without a layering violation. It must NOT live under
  `packages/adapters/**` (would trip `no-cross-adapter-dep` and `application-depends-only-on-domain`).

---

## 8. Consequences & risks

- **Positive:** zero-setup durable demo on one Mac; crash-safe single-row lifecycle; history/pagination on an
  index; report data persisted with a clean additive E4 seam; one shared contract proves in-memory ⇄ SQLite
  parity; Postgres stays a single-adapter swap.
- **R-A (native module):** `better-sqlite3` is a native addon — needs a prebuilt binary for the demo Mac's
  arch/Node. Mitigation: pin a version with darwin-arm64 prebuilds; CI builds on the same platform family. If
  prebuild friction appears, the fallback is Prisma+SQLite (same ports, §1.1) — a contained adapter swap.
- **R-B (additive `RunStatus`):** downstream exhaustive switches could break; none exist in `src` today (§2).
  #83 runs monorepo `typecheck`; any future `never`-guarded switch must add a `running` arm.
- **R-C (JSON payload vs normalized diffing):** storing graph as a payload defers the normalized `states` table
  §2.7 envisioned. Accepted: diffing is an explicit E7 non-goal; `findStatesByApp` stays empty and the table is
  an additive future change behind the unchanged port.
- **R-D (wire.ts contention #84/#85):** both append to `buildAppContext`; see e7-plan §Parallelization — resolved
  by a new-file wiring seam + **serialize #85 after #84**.
- **Coverage gate:** business logic (codec, orchestrator, query use-cases, SQLite repos) ≥ **85% line + branch**;
  the shared conformance suite is the primary evidence for the repos.
