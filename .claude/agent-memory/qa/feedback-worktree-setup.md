---
name: feedback-worktree-setup
description: Always use a fresh /tmp worktree for gate runs — never trust .claude/worktrees/ (stale pre-fix copies)
metadata:
  type: feedback
---

For per-ticket QA gate runs, always set up a clean worktree at `/tmp/<ticket-id>` using `git worktree add /tmp/<id> origin/<branch>`, then `pnpm install` there.

**Why:** `.claude/worktrees/` may contain stale pre-fix copies of branches that do not reflect the current PR head. Using these would produce false results (either passing stale code or failing fixed code).

**How to apply:** Gate prompt explicitly calls this out. Always confirm head OID with `gh pr view <n> --json headRefOid` and verify it matches the expected commit before running checks. Clean up with `git worktree remove /tmp/<id> --force` after gating.
