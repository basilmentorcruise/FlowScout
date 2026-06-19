# FlowScout — Roadmap (living)

_Owner: analyst. Source of truth for tiering & prioritization. Derived from `docs/sdlc/vision.md`.
RICE = (Reach × Impact × Confidence) / Effort. Reach is normalized as "supported runs / quarter" the
capability unlocks; Impact 3/2/1/0.5/0.25; Confidence 1.0/0.8/0.5; Effort in person-weeks. Last updated 2026-06-20._

## North star
Given **only an app name + a simulator `.app` build**, FlowScout autonomously explores an unknown iOS app and
produces an **accurate, grouped HTML map** of its features and end-to-end workflows — surfacing **at least one
hidden/duplicate path a human missed** — with **no manual scripting**, viewable and driveable from a web dashboard.

## Method & evidence
- **Mobile MCP foundation is real and maintained** (mobile-next/mobile-mcp): controls iOS Simulators via
  WebDriverAgent, exposes accessibility snapshots + screenshot/coordinate taps — matches the brief's driver layer.
  This de-risks the adapter and raises confidence on the foundation epic.
- **Crawl approach is validated by research** (LLM-Explorer, arXiv 2505.10593): LLM-guided app exploration is
  feasible and achieves high coverage, but **LLM cost is the dominant risk** — the paper uses accumulated
  "knowledge" to drive most actions LLM-lessly. Design input for the crawl engine (budget/step caps, cache state).
- **Competitive gap confirmed:** Panto AI, Virtuoso, Mobot, Maestro, AppTest.ai cluster on test
  generation/execution and managed/real-device QA. None lead with **zero-context semantic documentation of an
  unknown app** + **hidden/duplicate-path surfacing**. That is FlowScout's defensible wedge and the reason
  Understand-&-Document is the MVP (not test gen).

## Tier cutlines
- **MVP — Understand & Document (iOS):** the smallest coherent set that takes an unknown `.app` → live crawl →
  accurate grouped HTML workflow map (with a hidden/duplicate path) in a web dashboard, with a credential vault +
  2FA pause-and-ask. Everything below the MVP cutline is required for the success metric to be demonstrable.
- **V1 — Propose the tests:** derive the test plans that *should* exist from the map. Needs an accurate map first.
- **V2 — Author, run, gate:** author + run human-like automation tests and wire them as release gates + CI.

---

## MVP

| # | Epic | Reach | Impact | Conf | Effort | RICE |
|---|------|-------|--------|------|--------|------|
| E1 | Mobile MCP + simulator build/install foundation (adapter) | 100 | 3 | 0.8 | 5 | 48.0 |
| E2 | Autonomous crawl & state-graph engine (option discovery incl. hidden) | 100 | 3 | 0.5 | 12 | 12.5 |
| E3 | Semantic understanding & workflow mapping (purpose + duplicate-path detection) | 100 | 3 | 0.5 | 10 | 15.0 |
| E4 | Grouped HTML workflow documentation report | 100 | 2 | 0.8 | 5 | 32.0 |
| E5 | Web dashboard — run a crawl, watch live, browse map/reports, manage runs | 100 | 2 | 0.8 | 8 | 20.0 |
| E6 | Encrypted credential vault + 2FA pause-and-ask | 80 | 2 | 0.8 | 5 | 25.6 |
| E7 | Run persistence: crawl graph + report store (per-run history) | 100 | 1 | 0.8 | 4 | 20.0 |

**MVP rationale:** E1–E7 are the minimal end-to-end spine. E1 is the hard dependency for everything (drives the
sim). E2+E3 are the differentiating core (discovery + semantic/duplicate mapping) and carry the most risk
(Confidence 0.5). E4 is the deliverable artifact named in the success metric. E5 is FlowScout's own surface
(also named in scope). E6 is required to reach logged-in surfaces on real apps. E7 is the minimal persistence the
dashboard, report, and version-diffing all sit on. Drop any one and the success metric cannot be demonstrated.

## V1 — Propose the tests

| # | Epic | Reach | Impact | Conf | Effort | RICE |
|---|------|-------|--------|------|--------|------|
| E8 | Test-plan generation from the workflow map | 100 | 2 | 0.8 | 8 | 20.0 |

**V1 rationale:** Converts the map into the proposed test plans that *should* exist. Hard-depends on an accurate
map (E2/E3/E4). Highest-value next step toward the regression-gate vision once documentation is trusted.

## V2 — Author, run, gate

| # | Epic | Reach | Impact | Conf | Effort | RICE |
|---|------|-------|--------|------|--------|------|
| E9 | Human-like automation test authoring + execution | 100 | 3 | 0.5 | 16 | 9.4 |
| E10 | Release gates + CI integration | 80 | 2 | 0.5 | 8 | 10.0 |

**V2 rationale:** Turns proposed plans into running, maintained tests and wires them as release gates / CI —
the end-state product promise. Highest effort and lowest confidence; correctly last. Depends on V1.

---

## Cross-cutting notes & open questions
- **Duplicate/hidden "sameness":** how we decide two paths reach the *same* outcome (state-graph node identity:
  accessibility-tree signature + screen embedding + semantic label) is an open design question → architect ADR.
- **LLM cost control** in the crawl loop (per research): step/budget caps + cached state knowledge. Flag to architect.
- **Mobile MCP gesture/deep-state coverage** is a dependency risk (brief) → isolate behind E1's adapter; architect ADR.
- **Safety:** no in-flow guardrails (owner decision); rely on dedicated test accounts + disposable/snapshotted sim
  state. Snapshot/reset belongs in E1 (foundation) so a destructive run can be reset.
