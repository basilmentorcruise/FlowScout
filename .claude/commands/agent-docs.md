---
description: Update user-facing docs (README, guides, docs site) to match the code (docs)
---

Invoke the `docs` agent via the Agent tool to bring documentation in sync with the shipped code. For a single
change → update exactly the affected docs. For a completed epic → a comprehensive pass (README capabilities/setup,
usage guides) verified against the actual built behavior. Document only merged behavior, never planned features.

Ticket/epic or doc scope (if empty, infer from the recent git diff / the just-completed epic): $ARGUMENTS
