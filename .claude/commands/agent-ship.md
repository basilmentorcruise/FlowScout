---
description: Ship gate / release cut (release-coordinator)
---

Invoke the `release-coordinator` agent via the Agent tool to issue a SHIP/HOLD/BLOCKED decision (all gates PASS +
CI green + branch current + ACs met). For a completed epic → cut the tagged release + changelog (deploy deferred).

Ticket/epic (if empty, infer from the active work): $ARGUMENTS
