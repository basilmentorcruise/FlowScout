---
name: e2-progress
description: E2 crawl-engine delivery progress — tickets merged, remaining waves, key seams & gotchas.
metadata:
  type: project
---

# E2 — Autonomous crawl & state-graph engine: ✅ DELIVERED & CLOSED (2026-06-23)

All 7 tickets (#31–#37) merged. Epic #2 closed. Crawl engine end-to-end: state-graph loop, a11y-signature identity, budget/plateau, frontier/backtrack, hidden probes, CachedKnowledge→LLM (claude-opus-4-8) chain, duplicate-path + redaction + 2FA boundary + no-production guard, E2E-proven.

## Next eligible work (tier/priority)

E1 ✓ E2 ✓. Remaining MVP epics (all still `type:epic`, need breakdown): **E3 semantic workflow mapping = next core** (depends E2 ✓; E4 depends on it). Then E7 persistence (depends E2✓/E3 model), E6 vault+2FA (largely independent; E2 already detects+emits the 2FA boundary, E6 owns vault+resume), E4 HTML report (depends E3+E7), E5 dashboard (depends E2/E4/E6/E7). Pattern per epic: product breakdown → architect ADR + security threat model → waves of disjoint tickets → gate chain → merge.
Open hardening tasks (filed, not done): #26 simctl child-kill, #27 screenshot size-gate, #28 facade dispose, #29 sample .app fixture, #44 abort timed-out LLM request. ADR-0002 OQ1 doc amendment (low).

---

# (history) E2 delivery detail

Specs: PRD `docs/sdlc/prd/PRD-e2-crawl-engine.md`, **ADR-0004** (state-identity/policy/budgets), threat model `docs/sdlc/security/e2-crawl-engine-threat-model.md`. Tickets #31–#37.

## Merged (all gates passed)

- **#31** (PR #39) — walking-skeleton crawl loop. **FROZEN SHELL**: `application/src/crawl/StartCrawlRun.ts` + `collaborators.ts` (`CrawlCollaborators` interface + `defaultCollaborators()` factory). Wave-1+ replace only their collaborator BODY, never the interface/signature/shell. First-class `InMemoryStateGraphRepository` (durable Prisma = E7). Engine is port-only (depcruise enforces; no MCP/LLM SDK in application/domain).
- **#32** (PR #38) — `StateIdentityStrategy` port + default `A11ySignatureStrategy` (normalized a11y → SHA-256; volatile-normalize, sibling-collapse@3, depth-bound@10; exact-match for E2) + `CompositeStateIdentityStrategy` (E3 embedding/label additive, ignored now). Degraded-never-throws; 500KB DoS guard.
- **#33** (PR #41) — `BudgetEnforcer`: step/llm-call/token/revisit caps + plateau termination (ENGINE-owned, not policy); failed LLM calls still count. Additive domain edits: `CrawlBudget.plateauWindow`/`plateauWarnRatio`/`defaultCrawlBudget()` (400/40/120k/3/40/0.75); `BudgetWarningEvent.budgetType` += revisits/plateau.
- **#34** (PR #40) — Frontier: visited (via real StateIdentity, wired into `defaultCollaborators` body), untried-action frontier, backtrack, dead-end, config-bounded revisit cap (no livelock). **`ProbeSource` extension point** for #35: `registerProbeSource()` + `getEnumeratedCandidates()` (Promise.allSettled degrade-on-failure).

- **#35** ✓ MERGED (PR #42) — 4 ProbeSources via #34 seam (scroll/swipe/overflow; long-press no-op+telemetry). NOTE: `getEnumeratedCandidates` not yet consumed by the loop — #37 wires it.
- **#36** ✓ MERGED (PR #43) — CachedKnowledgePolicy + InMemoryDecisionCache (application) + DecisionCachePort (domain) + LLMPolicy/PolicyChain/LlmAdapter over @anthropic-ai/sdk@0.105.0 (adapters/llm, claude-opus-4-8). All LLM security MUSTs (P/O/D, env-key, truthful usage, SDK isolated) gate-verified. Follow-up #44 = abort timed-out request (Medium).

## Remaining

- **#37** capstone (LAST E2 ticket) — `packages/api` wire.ts + duplicate-path detection + integration. Depends #33,#34,#35,#36 (all ✓). MUSTs:
  - **wire.ts**: make `CachedKnowledgePolicy` the chain HEAD (currently `createPolicyChain(llmPolicy, llmPolicy)` — release gate MUST FAIL if head != CachedKnowledge); **populate `context.candidateActions`** (frontier candidates incl. probe `getEnumeratedCandidates`) so the policy chain + probes actually run at runtime; no-production guard + E1 reset-safety-net before destructive exploration.
  - **redaction**: single redaction fn strips creds/OTP/PII before graph/events/cache (NFR5).
  - **2FA boundary**: emit `CredentialPromptEvent` with NO values, enter blocked-on-2fa (vault/resume is E6).
  - **duplicate-path detection**: record `duplicatePathNodeIds` (structural; semantic grouping is E3).
  - **E2E** asserting security invariants (injection label → no off-allowlist action; PII token absent from events/graph/cache/LLM payload; no orphaned sims).
  - cleanup deferred: full loop-side backtrack wiring; remove dead `PlaceholderIdentity`; align #33 "#36 wires real LLM counting" comment.

## Recurring gotcha (see [[delivery-loop-gotchas]])

Parallel Wave worktrees under `.claude/worktrees/` cross-contaminate (one branch's untracked files leak into another's checkout → phantom test failures). Gate agents MUST use isolated `/tmp` checkouts of the real PR head; CI at the pushed head + clean-checkout QA are authoritative.
