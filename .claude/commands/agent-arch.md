---
description: Architecture plan (design-time) or post-implementation review (architect)
---

Invoke the `architect` agent via the Agent tool. For a ticket/epic with no code yet → produce the design plan/ADR
(patterns, layering, interfaces, test strategy, refined `Touches:`; propose the stack if undecided). For a PR/branch
→ run the post-implementation architecture review gate (PASS/FAIL/BLOCKED).

Ticket/PR (if empty, infer from the current diff or the active ticket): $ARGUMENTS
