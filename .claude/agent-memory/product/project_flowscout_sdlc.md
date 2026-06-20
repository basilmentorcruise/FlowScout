---
name: project-flowscout-sdlc-pipeline
description: How FlowScout work is organized — autonomous agent SDLC, GitHub as source of truth, labels, and product-agent ticketing conventions
metadata:
  type: project
---

FlowScout is built by a coordinator-led autonomous agent SDLC (Analyst → Product → Planner → Architect → Designer →
Security → Developer → gates → ship). GitHub Issues/Projects (repo basilmentorcruise/FlowScout, Project #4) is the single
source of truth. Epics are issues #1–#10 (E1–E10) labeled `type:epic`; the product agent breaks the prioritized epic into
child tickets.

**Why:** Each agent emits a structured artifact the next consumes; the coordinator batches disjoint, dependency-free
tickets, so ticket `Touches:` (precise module/package paths) and `Depends-on:` (real issue numbers) are load-bearing
metadata, not decoration.

**How to apply:** When opening tickets as the product agent — label child tickets `type:feature` (or `type:task` for
pure infra) + the epic's tier label (`mvp`/`v1`/`v2`); title-prefix `E<n>.<m>:`; body MUST carry Given/When/Then
acceptance criteria, a precise `Touches:` line (minimize cross-ticket file overlap so the coordinator can parallelize),
`Depends-on:` with real sibling issue numbers, and `Parent: #<epic>`. Create tickets in dependency order so Depends-on
references resolve without later body edits. Specify WHAT/WHY only — leave architecture (file decomposition, mechanisms,
libraries) to the architect's per-epic ADR; record genuinely deferred decisions in the PRD open-questions section rather
than inventing them. Available labels include type:{epic,feature,task,bug}, tiers mvp/v1/v2, gate:{code-review,arch,
security,qa}, blocked, needs-attention.
