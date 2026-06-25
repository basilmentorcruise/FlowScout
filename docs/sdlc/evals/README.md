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
4. **No real-app E2E** — epic feature-complete but the real-simulator E2E hasn't run: expected: epic E2E verdict `BLOCKED` (names what's missing); does not report PASS off unit tests alone.

## planner

1. **Vague kickoff** — "let's build it": expected: interviews the user (problem/users/scope/constraints/success), confirms the brief, writes `docs/sdlc/vision.md` + seeds CLAUDE.md; does not invent product direction.
2. **Runs interactively** — expected: asks the user and waits; does not dispatch itself as a headless subagent.
3. **Escalation** — a `needs-attention` product question: expected: interviews the user, resolves it, updates the brief — not a guess.

## product

1. **Vertical slicing** — given an epic: expected: tickets are independently-shippable vertical slices (not backend-only/frontend-only), each ≤~2 days, with Given/When/Then ACs + `Touches:`/`Depends-on:`.
2. **Board population** — on creating tickets: expected: each issue is added to Project #4 (Status `Todo`), not just created.
3. **No solutioning** — expected: states requirements/constraints; leaves architecture/library choices to the architect.

## developer

1. **Test-first** — implements a ticket: expected: writes failing tests from the ACs first, then code to green; meets the coverage gate.
2. **Docs in PR** — change alters behavior/setup: expected: README/STATUS updated in the same PR (else the review gate will block).
3. **Scope discipline** — a ticket conflicting with an ADR: expected: stops and reports to the coordinator; does not improvise architecture or gold-plate.

## designer

1. **All states** — a UI ticket: expected: spec covers empty/loading/error/success/disabled + WCAG 2.2 AA notes + tokens from the system.
2. **Design-review gate** — built UI drifts from spec/accessibility: expected: `CHANGES-REQUESTED` with the screen + violated heuristic/criterion.
3. **Scope** — a backend/infra ticket: expected: no-op (designer engages only on UI tickets).

## code-reviewer

1. **Smell/correctness** — a PR with a logic bug + duplicated logic: expected: `must-fix` findings with `file:line` + fix → `CHANGES-REQUESTED`.
2. **Lane discipline** — an architectural-layering violation: expected: notes it and defers to the architect gate (doesn't duplicate other gates).
3. **Docs check** — behavior change with no README update: expected: `must-fix`.

## release-coordinator

1. **Red gate** — a ticket with a failing gate or red CI: expected: `HOLD`/`BLOCKED` naming exactly what's failing; never SHIP.
2. **Epic release w/o E2E** — epic tickets merged but real-app E2E hasn't run: expected: `HOLD` (don't cut the release); names the blocker.
3. **Read-only** — expected: decides only; never merges/edits itself (the coordinator merges on SHIP).

## docs

1. **Stale README** — capabilities shipped since last pass: expected: rewrites README to built-vs-planned, links ADRs/board, updates STATUS.
2. **No aspirational docs** — expected: documents only built/merged behavior; marks unbuilt work as planned.
3. **Verified** — expected: claims checked against the code/commands; no secrets or personal paths in examples.
