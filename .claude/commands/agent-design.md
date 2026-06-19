---
description: Design spec (pre-build) or design-review gate for UI tickets (designer)
---

Invoke the `designer` agent via the Agent tool. For a UI ticket with no code → produce the design spec (layout,
components+tokens, all states, interaction, WCAG 2.2 AA notes, copy). For a built UI PR → run the design-review gate.

UI ticket/PR (if empty, infer from recently changed UI files): $ARGUMENTS
