# E7 — Run persistence: per-ticket implementation plan (#83 / #84 / #85)

Companion to **ADR-0008** (`ADR-0008-e7-run-store.md`). Store = embedded SQLite (`better-sqlite3`), hybrid
schema (indexed columns + deterministic JSON payload). Hexagonal: adapters implement domain ports; application
depends on ports only; DI at the composition root. Coverage gate: **≥85% line + branch** on codec / repos /
orchestrator / query use-cases.

Ordering: **#83 first** (durable store + additive domain + shared contract), then **#84** (write path),
then **#85** (read path). #84 and #85 are **not safely parallel** — both mutate `buildAppContext` (see
Parallelization). Recommend coordinator batch: #83 → #84 → #85.

---

## #83 — E7.1: Durable run store (Run + StateGraph + Report), roundtrip by run id

Branch: `fs-83-durable-run-store`

### Approach & patterns

- **Adapter (hexagonal):** replace the throwing `Prisma*` stubs with `Sqlite{Run,StateGraph,Report}Repository`
  in `packages/adapters/persistence`, each implementing its domain port.
- **Repository pattern** over a shared `better-sqlite3` `Database` handle (injected — DI, one connection per
  process, opened once at construction). **Codec** (SRP/DRY, Decision 5) isolates serialization.
- **Shared conformance suite** (Decision 7) — the new `@flowscout/testing-persistence` package.

### Modules / files

- `packages/adapters/persistence/src/sqlite/Database.ts` — opens `better-sqlite3` at `FLOWSCOUT_DB_PATH`
  (default `./.flowscout/flowscout.db`), sets `PRAGMA journal_mode=WAL`, runs `CREATE TABLE IF NOT EXISTS`
  (schema in ADR §1.3). Factory `openDatabase(path)`; injectable for tests (`:memory:` + a temp-file variant
  for the `reopen` durability test).
- `packages/adapters/persistence/src/sqlite/codec/{GraphCodec,ReportCodec,RunCodec}.ts` — pure encode/decode
  (Map/Set ↔ sorted arrays, fixed key order, deterministic). No I/O.
- `packages/adapters/persistence/src/sqlite/Sqlite{Run,StateGraph,Report}Repository.ts` — port impls; every
  `save*` in ONE transaction; upserts via `ON CONFLICT`.
- `packages/adapters/persistence/src/index.ts` — export the new classes (keep `Prisma*` exports removed or
  re-pointed; update `package.json` description away from "PostgreSQL + Prisma", add `better-sqlite3` dep +
  `@types/better-sqlite3`).
- **Domain (additive):**
  - `packages/domain/src/models/report.ts` — add `"running"` to `RunStatus` (ADR §2).
  - `packages/domain/src/ports/RepositoryPorts.ts` — add `listRuns` + `ListRunsOptions` + `RunPage` (ADR §4);
    fix the file header comment ("PostgreSQL + Prisma for MVP" → "durable store per ADR-0008").
  - export new types from `packages/domain/src/index.ts`.
- **New package `@flowscout/testing-persistence`** at `packages/testing/persistence/`:
  `package.json` (dep: `@flowscout/domain` only; devDep vitest/ts), `src/index.ts` exporting the three section
  runners + `runPersistenceContractSuite` + fixtures (small + a "hundreds of nodes" large-graph fixture, NFR5).
- **In-memory reference impls** (application, so both sides run the suite): `InMemoryRunRepository`,
  `InMemoryReportRepository` in `packages/application/src/crawl/persistence/` (mirror the existing
  `InMemoryStateGraphRepository`); export from the application barrel. Add `listRuns` to
  `InMemoryStateGraphRepository`? No — `listRuns` is on `RunRepository`; the graph repo only gains nothing.
  Each in-memory repo also gets its section-runner test (without `reopen`).

### Interfaces / contracts (additive only)

```ts
type RunStatus = "running" | "completed" | "partial" | "blocked-on-2fa" | "error";
interface ListRunsOptions {
  readonly limit: number;
  readonly cursor?: string | null;
}
interface RunPage {
  readonly runs: readonly Run[];
  readonly nextCursor: string | null;
  readonly total: number;
}
interface RunRepository {
  /* …existing… */ listRuns(o: ListRunsOptions): Promise<RunPage>;
}
```

### Test plan (coverage ≥85% line+branch)

- **Shared section runners** drive BOTH SQLite (with `reopen` → real temp file, reopened = NFR1 durability) and
  each in-memory impl (no `reopen`). Assertions: deep-equal roundtrip; large-graph (hundreds of nodes + a11y
  blobs) intact (NFR5); idempotent `saveGraph` upsert (one graph, latest wins, FR2); null on unknown id (FR7);
  `findByAppId` returns an app's runs; `listRuns` newest-first + cursor paging + `total`; empty store / beyond-
  last page ⇒ empty page, null cursor.
- **Codec unit tests:** round-trip Map/Set fidelity + **byte-determinism** (same input → identical string twice;
  key-order independence) + redaction-marker passthrough (defense-in-depth, NFR4).
- `zero-setup` proof: constructing the SQLite store with no env/service pre-run initializes tables (AC).

### DO

- Keep all writes inside a single transaction; set WAL at init. Encode/decode ONLY through the codec.
- Make `openDatabase` injectable so tests use a temp file for the reopen/durability case.
- Run monorepo `typecheck` after adding `"running"` (verify no `never` switch breaks — none in src today).

### DON'T

- Don't implement `findStatesByApp` beyond returning empty (diffing deferred).
- Don't normalize states/edges into tables (payload is the store for MVP).
- Don't put the conformance suite under `packages/adapters/**` (layering — must be `packages/testing/`).
- Don't touch `StartCrawlRun`, `wire.ts`, or any read/write orchestration (those are #84/#85).

**Touches:** `packages/adapters/persistence`, `packages/domain` (additive: `RunStatus`, `RunRepository.listRuns`

- DTOs), **new** `packages/testing/persistence`, `packages/application/src/crawl/persistence` (in-memory
  Run/Report reference repos + their tests). **Depends-on:** none (gated on this ADR).

---

## #84 — E7.2: Persist a run automatically through the crawl pipeline

Branch: `fs-84-persist-run-pipeline` · **Depends-on #83**

### Approach & patterns

- **Orchestrator / Facade** (ADR §6): new application use-case `RunAndPersist` composes `runRepository`,
  `StartCrawlRun`, `crawlEventStream`, `BuildWorkflowMap`, `reportRepository`. **`StartCrawlRun`'s constructor
  stays frozen** — no new collaborator on it.
- **Pure factory** `assembleReport(run, graph, workflowMap)` builds the `Report` (counts from graph/map,
  `artifactUri: ""` sentinel, ADR §3). No I/O.

### Modules / files

- `packages/application/src/run/RunAndPersist.ts` — the orchestrator (ports-only deps; DI via constructor).
- `packages/application/src/run/assembleReport.ts` — pure Report factory + a `REPORT_UNRENDERED_URI = ""`
  documented constant (no magic literal).
- `packages/application/src/run/versions.ts` (or reuse config) — `driverVersion`/`policyVersion`/`schemaVersion`
  constants supplied to the `Run` at creation (no magic strings inline).
- barrel exports in `packages/application/src/index.ts`.
- `packages/api/src/composition-root/wireRunPersistence.ts` — **new file**: builds `RunAndPersist` from the
  already-constructed repos + `startCrawlRun` + `buildWorkflowMap`; exposes it via a new
  `AppContextWithRunPersistence` interface (mirrors the existing `AppContextWith*` additive pattern).
- `packages/api/src/composition-root/wire.ts` — **one** added call in `buildAppContext` to attach the
  orchestrator (the sole shared edit; see Parallelization).

### Lifecycle (ADR §2, §6)

1. create `Run { status:"running", finishedAt:null, startedAt:now, …versions }` → `runRepository.save`.
2. subscribe `crawlEventStream` for `runId`; run `startCrawlRun.execute(input)` (graph persists incrementally
   through the durable repo).
3. terminal `crawl:finished` → derive `status` from its `status` field; `buildWorkflowMap.execute(runId)` →
   `assembleReport` → `reportRepository.save`; `runRepository.update(id,{status, finishedAt:now})`.
4. `crawl:error` or thrown → `update(id,{status:"error", finishedAt:now})`; process kill ⇒ stays `running/null`.

### Test plan (coverage ≥85%)

- Unit with **in-memory repos + fakes** (from #83): run started ⇒ `running/null` row exists _before_ finish (FR4);
  completed ⇒ terminal status + `finishedAt` set + graph + report retrievable + matching runId/appId/appVersion;
  crash (throw) ⇒ row discoverable non-completed; secret/redaction assertion — persisted graph/report contain no
  credential value (feed a snapshot with a known secret marker, assert absent — NFR4).
- Report counts correct (`totalStates`/`totalWorkflows`/`duplicatePathCount`); `artifactUri === ""`.
- **api wiring test:** `buildAppContext()` exposes a working `RunAndPersist` driven with fakes (port purity —
  the orchestrator imports no adapter).

### DO / DON'T

- DO derive terminal status from the `crawl:finished` event, not by re-guessing. DO unsubscribe in a `finally`.
- DON'T modify `StartCrawlRun` / `collaborators.ts` / `BuildWorkflowMap`. DON'T set a non-empty `artifactUri`
  (that's E4). DON'T read/list history here (that's #85).

**Touches:** `packages/application/src/run` (new), `packages/application/src/index.ts`,
`packages/api/src/composition-root/wireRunPersistence.ts` (new) + one line in `wire.ts`. **Depends-on #83.**

---

## #85 — E7.3: Run history — list (paginated, newest-first) + retrieve by id

Branch: `fs-85-run-history-query` · **Depends-on #83**

### Approach & patterns

- **CQRS-lite read use-cases** over the ports (no domain edit — #83 already added `listRuns`):
  - `ListRunHistory` → `runRepository.listRuns(options)` mapped to a `RunHistoryPage` DTO.
  - `GetRunDetail(runId)` → composes `runRepository.findById` + `stateGraphRepository.findByRunId` +
    `reportRepository.findByRunId` into a `RunDetail` DTO; unknown id ⇒ `null` (FR7), not a throw.
- **Shared DTOs** live in application (the E5 dashboard consumes them); no adapter/domain change.

### Modules / files

- `packages/application/src/run/queries/ListRunHistory.ts`, `GetRunDetail.ts`, `dto.ts`
  (`RunHistoryPage`, `RunDetail`). barrel exports.
- `packages/api/src/composition-root/wireRunQueries.ts` — **new file**: builds both query use-cases from the
  repos; exposes via a new `AppContextWithRunQueries` interface.
- `packages/api/src/composition-root/wire.ts` — **one** added call in `buildAppContext` (shared edit).

### Test plan (coverage ≥85%)

- In-memory repos seeded: newest-first ordering by `startedAt`; pagination (page size + `nextCursor` + `total`)
  including next-page fetch; zero runs ⇒ empty page, no error; beyond-last page ⇒ empty page + null cursor;
  `GetRunDetail` returns `{run, graph, report}` together for a known id; unknown id ⇒ `null`.
- api wiring test: `buildAppContext()` exposes working query use-cases driven with fakes.

### DO / DON'T

- DO keep these read-only (no writes). DO surface `total`/`nextCursor` for the dashboard.
- DON'T add HTTP routes or UI (E5). DON'T edit domain (port already has `listRuns` from #83). DON'T duplicate
  ordering logic the SQLite `listRuns` already owns — the use-case maps, the repo orders/paginates.

**Touches:** `packages/application/src/run/queries` (new), `packages/application/src/index.ts`,
`packages/api/src/composition-root/wireRunQueries.ts` (new) + one line in `wire.ts`. **Depends-on #83.**

---

## Parallelization verdict — #84 vs #85

**Not safely parallel; serialize #85 after #84.** The new-file wiring seam (`wireRunPersistence.ts` /
`wireRunQueries.ts` + separate `AppContextWith*` interfaces) makes ~95% of each ticket disjoint, but **both must
append one construction line to `buildAppContext()` in `wire.ts`** — a guaranteed conflict in the repo's
highest-traffic file. #85 consumes nothing #84 produces except the shared repos (already from #83), so the
cheapest safe path is: land #84, then #85 rebases (trivial one-line move). If the coordinator must run them
concurrently, it owns the `wire.ts` merge; the rest is conflict-free by construction.

## Shared port-conformance suite — exact shape (all three impls)

```ts
// @flowscout/testing-persistence
export function runRunRepositoryContract(o: {
  createRepository: () => RunRepository;
  reopen?: (r: RunRepository) => RunRepository; // durable-only: NFR1 restart assertions
  fixtures: RunFixtures;
}): void;
export function runStateGraphRepositoryContract(o: {
  createRepository: () => StateGraphRepository;
  reopen?: (r: StateGraphRepository) => StateGraphRepository;
  fixtures: GraphFixtures; // incl. large-graph (hundreds of nodes) — NFR5
}): void;
export function runReportRepositoryContract(o: {
  createRepository: () => ReportRepository;
  reopen?: (r: ReportRepository) => ReportRepository;
  fixtures: ReportFixtures;
}): void;
export function runPersistenceContractSuite(/* aggregates the three */): void;
```

Behavioral sections (roundtrip, idempotent upsert, null-on-unknown, findByAppId, listRuns paging, empty bounds)
run for **every** impl; the `reopen`-gated durability section runs only for SQLite. Mirrors ADR-0003's
per-capability + injected-capability pattern.
