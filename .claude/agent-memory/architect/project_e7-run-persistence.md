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

**Why:** urgent single-machine macOS demo (real crawl → HTML report + dashboard), owner steer = zero external
service setup. **How to apply:** in the review-gate, PASS SQLite-not-Postgres for MVP; FAIL any application/
domain import of an adapter, any StartCrawlRun constructor change, a non-empty artifactUri in E7, or a
conformance suite placed under packages/adapters. Related: [[e1-conformance-harness]], [[e2-crawl-engine-decomposition]].
