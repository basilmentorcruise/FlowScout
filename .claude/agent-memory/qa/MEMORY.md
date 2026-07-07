# QA Agent Memory Index

- [Project: E1 adapter structure and deferred scope](project-e1-adapter-deferred-scope.md) — Real simulator behavior deferred to #18; stubs excluded from coverage gate; depcruise enforces SDK isolation
- [Feedback: worktree setup for gate runs](feedback-worktree-setup.md) — Always use `git worktree add /tmp/... origin/<branch>`, never `.claude/worktrees/` (stale)
- [Project: E3.5 semantic duplicate/hidden-path detection](project-e35-semantic-duplicate-detection.md) — #58 PASSED; cross-identity scoping + flag-time intent gate; projectA11ySkeleton additive extract; #59 owns wiring
- [Project: E7.1 SQLite adversarial probe technique](project-e71-sqlite-adversarial-probes.md) — #83/PR#91 PASSED; fork-real-child crash/concurrency probes, pagination tie-break/stale-cursor gotchas, reusable for #84/#85
