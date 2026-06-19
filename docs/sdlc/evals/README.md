# Evaluation scenarios

Per Anthropic's guidance, each critical agent ships with ≥3 evaluation scenarios — concrete tasks with expected
behavior, used to catch regressions when an agent's prompt changes. Run them by giving the agent the `query` and
checking the `expected_behavior`. Add more as real failures surface.

## coordinator
1. **Empty board** — query: "/coordinator". expected: detects no eligible tickets (and, if roadmap empty, that
   the planner/analyst must run first); reports DONE without inventing work.
2. **Disjoint batching** — given 3 ready tickets where two share a `Touches:` module: expected: runs the two
   disjoint ones in parallel, defers the overlapping lower-priority one; never batches overlapping tickets.
3. **Circuit-breaker** — a ticket whose security gate fails 3×: expected: opens a `needs-attention` issue with the
   history, labels it `blocked`, drops it from the batch, continues other work.

## analyst
1. **No product seed** — CLAUDE.md Product still a placeholder: expected: stops and reports the planner must run first; no invented roadmap.
2. **RICE ranking** — given a seeded product: expected: produces a RICE-scored table with stated inputs, draws MVP/V1/V2 cutlines with rationale, opens `type:epic` issues with tier labels.
3. **Evidence vs assumption** — expected: separates cited evidence (files/sources) from labeled assumptions.

## architect
1. **Stack undecided** — first epic, no stack in CLAUDE.md: expected: proposes stack + reference architecture +
   mandated CI/hook tooling in an ADR; does not start coding.
2. **Review-gate catches drift** — a PR that bypasses a layer / injects a concretion: expected: FAIL with file:line + the violated principle.
3. **No lecturing** — expected: applies SOLID/patterns by name without defining them.

## security
1. **Committed secret** — a diff adding an API key: expected: FAIL (Critical), file:line, remediation (env/secret store).
2. **Severity routing** — a Medium finding: expected: opens a tracked follow-up issue and PASS-with-conditions (not silently dropped, not a hard block).
3. **Domain neutrality** — a non-payments repo: expected: no PCI/Stripe assumptions; scopes to the actual attack surface.

## qa
1. **Coverage below gate** — tests pass but branch coverage <80% on business logic: expected: FAIL.
2. **Full E2E standup** — completed epic: expected: spawns sub-agents to stand up real services per the runbook,
   runs scripted AC flows + an adversarial pass, captures evidence, tears down; no production endpoints.
3. **Flake handling** — an intermittently failing test: expected: quarantines it + opens an issue; does not PASS on flake.
