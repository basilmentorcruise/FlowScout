---
name: scope-boundaries
description: FlowScout security scope facts — credential vault is E6 not E1; safety posture is test accounts + disposable sim state; no PCI/payments domain.
metadata:
  type: project
---

Key scope boundaries when threat-modeling or gating FlowScout:

- **Encrypted credential vault + 2FA pause-and-ask = E6** (`adapters/vault`, AES-256-GCM via
  `FLOWSCOUT_VAULT_KEY` from env). Do **not** design or expect vault crypto in earlier epics. Earlier
  epics' job re credentials is only to leave clean sinks (no secret leaks via logs/screenshots/argv)
  so E6 can carry secrets through (e.g. `typeText`) safely.
- **Safety posture (owner decision, ADR-0001 F6):** NO in-flow guardrails. Real-data autonomous
  exploration relies on dedicated test accounts + sandbox envs + disposable/snapshotted simulator
  state. Snapshot/reset (E1) is the safety net — so reset failing closed is security-relevant.
- **Never production endpoints/data.** Exploration runs against test accounts only.
- **No PCI/payments or other regulated domain** is in play — do not assume one. Domain is internal
  developer/tester tooling that drives iOS simulators.

**How to apply:** scope findings to the epic actually under review; flag a vault concern as an
E6 boundary note rather than an E1 defect. See [[recurring-risks-mobile-mcp]].
