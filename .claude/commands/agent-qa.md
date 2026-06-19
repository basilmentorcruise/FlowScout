---
description: QA gate (per ticket) or full epic E2E human-simulation (qa)
---

Invoke the `qa` agent via the Agent tool. For a ticket → run the QA gate (ACs, coverage ≥80% line+branch, suite,
smoke). For a completed epic → run the full E2E: spawn sub-agents to stand up the real system per the runbook and
drive it (scripted AC flows + adversarial human pass).

Ticket or epic (if empty, infer from the active work): $ARGUMENTS
