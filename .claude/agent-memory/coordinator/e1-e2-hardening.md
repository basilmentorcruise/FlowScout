---
name: e1-e2-hardening
description: E1/E2 hardening cycle — #26/#27/#28 merged; #29 (fixture) + #44 (LLM abort) in flight.
metadata:
  type: project
---

# E1/E2 hardening delivery cycle (2026-06-23)

Post-capstone hardening tickets derived from prior arch/security gate findings.

## Merged to main (all gates PASS, CI green incl. SCA/SAST/depcruise/gitleaks/jscpd)

- **#28** (PR #49, `e9baa28`) — `MobileMcpDriver.dispose()` for MCP transport teardown. Wired via `CapabilityBundle.dispose` → `defaultCapabilities()` → `connection.dispose()`. Closes the facade-teardown gap (T8). Arch adjudicated the `// FROZEN BY #12` header drift as **sanctioned additive evolution** by the coordinator-designated owner — non-blocking follow-up: update freeze headers to record post-Wave-1 additive owners.
- **#27** (PR #48, `5d6c3d6`) — pre-decode base64 size-gate in `normalizeScreenshot` (`driving/normalization.ts`). Closes #15 CWE-400 partial-OOM. Estimate `floor(len*3/4)` is conservative (over-counts ≤2B, never under). Non-blocking follow-ups: add an at-limit test case; optionally subtract padding for an exact cap.
- **#26** (PR #50, `2584c1d`) — kill simctl child on timeout via optional `signal?: AbortSignal` threaded through the `Exec` seam to `execFile`; `controller.abort()` before reject; `clearTimeout` on all paths. Closes #14 T8 orphan-child. `lifecycle.contract.test.ts` argv assertions updated to `expect.any(AbortSignal)` (strengthened, not weakened, T1).

## In flight

- **#44** — abort timed-out LLM request + clear timer in `adapters/llm/src/LlmAdapter.ts` (from #36 security, CWE-400/770). Dev dispatched on `fs-44-llm-abort-timeout`.
- **#29** — minimal buildable iOS `.app` fixture for the gated Layer B macOS round-trip (OQ3 follow-up from `E1.7-composition-e2e-plan.md` §6.4). Architect plan dispatched first (multi-file: new sample app + xcodebuild script + `e2e-macos.yml` + docs). Local toolchain confirmed: Xcode 26.5 + simctl available, so the fixture is buildable/verifiable locally.

## Reinforced gotchas this cycle

- **Stale ambient working tree caused FALSE gate failures.** The main checkout carried a stale `simctl.ts` (old no-signal code from the `fs-37` branch); gate agents that tested the ambient tree saw phantom 5/516 failures, and one even claimed a new `simctl.test.ts` "fails on origin/main" (impossible — it's a new file). FIX that worked: instruct every gate agent to confirm `gh pr view <n> --json headRefOid`, check out the PR head into a clean scratch worktree, and IGNORE the ambient tree + `.claude/worktrees/`. See [[delivery-loop-gotchas]].
- **Disjoint-file batches merge clean with no rebase.** #26/#27/#28 touched non-overlapping files (simctl / normalization / MobileMcpDriver+capabilities), no shared lockfile/vitest-config edits → sequential squash-merges, each needing only a poll for GitHub to recompute `mergeable` (UNKNOWN→MERGEABLE) before the next.
- **CI runs on draft PRs here** (full pipeline green on drafts); release gate returns HOLD purely on draft status. Coordinator just `gh pr ready <n>` then `gh pr merge --squash --delete-branch`.
- `--delete-branch` fails to delete the LOCAL branch if a leftover dev worktree still references it; harmless (remote deleted, merge landed). Clean up with `git worktree remove --force` + `git branch -D`.
