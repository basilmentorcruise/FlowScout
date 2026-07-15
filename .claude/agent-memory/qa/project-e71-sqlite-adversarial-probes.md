---
name: project-e71-sqlite-adversarial-probes
description: E7.1 (#83/PR #91) QA PASSed — adversarial probe technique for the SQLite persistence adapter and footguns for #84/#85
metadata:
  type: project
---

#83 (durable SQLite run store, PR #91, head `0f2cd175a6ac51c78aa82d55c3c47e08f272b73f`) PASSed the QA gate.
82/82 tests, 98.99% line / 95.14% branch coverage, full monorepo (43 turbo tasks) green, depcruise clean.

**Why:** E7.1 is the storage foundation for #84 (write-path wiring) and #85 (read-path/history) — both
depend on this adapter's crash/concurrency/pagination behavior actually holding up, not just unit-tested in
isolation.

**How to apply (reusable for #84/#85 and any future SQLite-adapter ticket in this repo):**

- To probe crash-safety adversarially, don't rely on the unit suite's mocked "close+reopen" — fork a **real
  child process**, have it write in a loop, `SIGKILL` it from the parent mid-loop, then reopen the same file
  from the parent and assert `pragma("integrity_check")` plus row discoverability. Gotcha: pass the db path
  to the child via env/arg explicitly — a child script that computes its own temp path (instead of using the
  parent's) will silently probe against the wrong file and produce a false "not found" failure that looks like
  a product bug but is a test-script bug. Verify the child actually wrote to the SAME file before trusting a
  failing assertion.
- Concurrent-writer probes: fork 2+ real processes writing DIFFERENT run ids to the same file simultaneously.
  With `PRAGMA journal_mode=WAL` and fast small writes, better-sqlite3 did not surface `SQLITE_BUSY` even at 8
  concurrent processes in this repo's probe — that's not a bug, just means contention was too brief to collide;
  the assertion should accept either a clean landing or a typed busy-shaped error, not require one or the other.
- Pagination probes should include rows with a **tied sort key** (e.g. identical `startedAt`) to verify the
  tie-break (`id DESC` here) is deterministic, and a **stale-cursor-after-insert** case: insert a new row
  _newer_ than the cursor position, then fetch with the old cursor — correct keyset semantics means the new
  row must NOT leak into that page.
- The shared `@flowscout/testing-persistence` conformance suite (packages/testing/persistence) runs the same
  behavioral sections against both the SQLite adapter and in-memory reference repos; `reopen`-gated sections
  are durability-only and skip for in-memory. Reading these contract files directly (not just running them) is
  the fastest way to audit AC coverage for vacuous assertions — they were substantive as of #83 (deep-equal,
  not `toBeTruthy`).
- `FLOWSCOUT_DB_PATH` env var configures the store path; default `./.flowscout/flowscout.db`; `:memory:` is
  supported and skips filesystem prep entirely.

See also [[feedback-worktree-setup]] for how the scratchpad worktree was set up to run this gate.

**Update (#84/PR#98, E7.2 write-path orchestrator — PASSed):** extended these probes to the
`RunAndPersist` orchestrator that composes `StartCrawlRun` + `BuildWorkflowMap` + the three
Sqlite\* repos via the api package's composition-root wiring functions (`wireRunPersistence`,
`wireBuildWorkflowMap` in `packages/api/src/composition-root/`).

- To drive the REAL composition root from a standalone probe script (not vitest), don't
  `import "@flowscout/api"` — its `src/index.ts` has a side effect (`void start()` boots a real
  Fastify server on import). Instead import the composition-root file directly by absolute file
  path (`${repoRoot}/packages/api/dist/composition-root/wire.js`) — Node's ESM resolver allows
  direct file-path imports even when the package's `exports` map only exposes `"."`; only bare
  `@flowscout/api` specifiers are restricted.
- Probe scripts placed outside the workspace (e.g. under a scratchpad dir) won't resolve bare
  `@flowscout/*` specifiers — Node walks `node_modules` up from the _importing file's own path_,
  not cwd. Fix: drop the scratch `.mjs` probe files into a throwaway subdirectory INSIDE a
  package that already has the pnpm-symlinked `node_modules/@flowscout/*` (e.g.
  `packages/api/qa-probe-scratch/`), run from there, then delete the directory before tearing
  down the worktree — never commit it.
- For "kill -9 mid-crawl" timing, don't guess a sleep duration — have the slow driver method
  (e.g. `tap()`) IPC-signal the parent (`process.send`) the instant it starts its first call
  (which only happens after `RunAndPersist`'s pre-crawl `Run` save has already landed), then have
  the parent `SIGKILL` ~100ms after receiving that signal. This makes "mid-crawl" deterministic
  instead of a race against an arbitrary timeout.
- On reopen after the kill, `better-sqlite3`'s `db.pragma("integrity_check")` returns
  `[{integrity_check: "ok"}]` when the WAL-mode journal protected the file — assert on that array
  shape, not just "no throw".
- Re-execute-same-runId (upsert/no-dupe) probes are cheap: just call the orchestrator twice
  against the same file-backed db, then raw-SQL `COUNT(*) WHERE id/run_id = ?` on `runs`,
  `graphs`, `reports` — all three tables in this schema key on `run_id`/`id` with
  `ON CONFLICT ... DO UPDATE` (runs, graphs) or delete-then-insert (reports), so the count must
  stay 1 regardless of re-execution count.
