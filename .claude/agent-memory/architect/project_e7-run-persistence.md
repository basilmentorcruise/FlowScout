---
name: e7-run-persistence
description: E7 run-store design (ADR-0008) — SQLite store, RunStatus running, report-data boundary, shared conformance suite, #84/#85 serialization
metadata:
  type: project
---

E7 (#7 run persistence) design — **ADR-0008** (`docs/sdlc/architecture/ADR-0008-e7-run-store.md`) + plan
(`docs/sdlc/architecture/e7-plan.md`). Tickets #83/#84/#85.

Decisions (gate against these in review):

- **OQ1 store:** embedded **SQLite via better-sqlite3** (zero-setup, WAL+txn crash-safe, hybrid schema =
  indexed columns + deterministic JSON `payload`). **Amends ADR-0001 §2.7** (Postgres deferred behind the same
  ports; swap = one composition-root line). `findStatesByApp` stays empty (diffing is a non-goal).
- **OQ2 in-progress run:** additive `"running"` on `RunStatus` **AND** `finishedAt===null` convention (predicate
  = finishedAt null). Verified no `never`-guarded switch on RunStatus in src, so additive is safe.
- **OQ3 report boundary:** E7 persists Report data with `artifactUri:""` sentinel; **E4 flips that one field via
  the same `save` upsert — no schema change.** Additive confirmed.

Ownership / seams:

- **All domain edits land in #83**: `RunStatus += "running"` + `RunRepository.listRuns(ListRunsOptions):RunPage`
  (cross-app newest-first cursor pagination). So #84/#85 are domain-free.
- **Shared per-port conformance suite** (E1/ADR-0003 pattern) lives in a NEW neutral package
  `@flowscout/testing-persistence` at `packages/testing/persistence/` (domain-only dep — must NOT be under
  `packages/adapters/**` or dependency-cruiser trips). Durability (NFR1) is an injected `reopen?` capability;
  behavioral sections run for both SQLite and in-memory reference impls.
- **#84 write path:** outer **`RunAndPersist` orchestrator** (Facade) — StartCrawlRun stays frozen; status comes
  from the `crawl:finished`/`crawl:error` event (execute() returns void). Pure `assembleReport` factory.
- **#84 vs #85 NOT safely parallel** — both append one line to `buildAppContext()` in `wire.ts` (new-file seam
  `wireRunPersistence.ts`/`wireRunQueries.ts` keeps the rest disjoint). Verdict: **land #84 first, #85 rebases.**

**#83 gate outcome (PR #91, head 0f2cd17): PASS** — coverage independently re-run 98.99/95.14 (claim exact).
Rulings that bind later gates: Prisma-stub retention OK (wire.ts freeze wins over plan's "remove exports" line —
**#84 review MUST verify stubs deleted**); T6 size-cap accepted-risk OK but **#84 must carry it with M84.2**;
route to **#85**: wrap read-path decode in the promise bridge (sync-throw LSP asymmetry vs in-memory) + specify
and contract-assert `findByAppId` ordering (in-memory insertion-order vs SQLite `generated_at DESC` — Hyrum risk).
#84 should pass the DB path explicitly at the composition root (env read lives in `resolveDatabasePath`, plan-sanctioned).

**#84 gate outcome (PR #98, head 75adecb): PASS** — coverage independently re-run 98.63/94.18; depcruise clean.
All three #83-bound conditions verified (stubs deleted; explicit `resolveDatabasePath(process.env)` at root; T6
carried via M84.2 tests). Rulings that bind later gates: **coherence window** (report runStatus "completed" vs
run row "error" if the post-report-save run-update fails) = accepted-risk for MVP, NO UnitOfWork port (YAGNI) —
**#85 review MUST verify GetRunDetail treats the RUN row as authoritative status**; **#89/E4** should render
status from the run row when both exist. #85 seam confirmed: repos are destructured locals in wire.ts, #85
appends its own appContext line (trivial rebase). #85 also still owes the two #83-routed items below.

**Why:** urgent single-machine macOS demo (real crawl → HTML report + dashboard), owner steer = zero external
service setup. **How to apply:** in the review-gate, PASS SQLite-not-Postgres for MVP; FAIL any application/
domain import of an adapter, any StartCrawlRun constructor change, a non-empty artifactUri in E7, or a
conformance suite placed under packages/adapters. Related: [[e1-conformance-harness]], [[e2-crawl-engine-decomposition]].
