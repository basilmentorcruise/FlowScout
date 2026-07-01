---
name: e2-decision-policy-chain
description: E2.6 (#36) DecisionPolicy chain landed — candidateActions via additive context extension, chain-head wiring deferred to #37
metadata:
  type: project
---

#36 (E2.6, PR #43, merged-candidate head 382cd85) landed the DecisionPolicy Chain of Responsibility per ADR-0004
§3.2–3.5. Placement is correct: `CachedKnowledgePolicy` + `InMemoryDecisionCache` in
`application/src/crawl/policy/**` (no SDK); `LLMPolicy`/`PolicyChain`/`LlmAdapter` + `@anthropic-ai/sdk` in
`packages/adapters/llm`; `DecisionCachePort` additive in domain. depcruise green, SDK import confined to
`LlmAdapter.ts` only.

**Two design choices I accepted at the arch gate (so #37 reviewers don't relitigate them):**

1. **`candidateActions` is NOT on the frozen `DecisionContext`** (DecisionPolicyPort.ts). Both policies read it via
   an additive `DecisionContextWithCandidates extends DecisionContext` (optional field, read-if-present). This is
   the correct Open/Closed seam — the frozen domain contract is untouched; candidate enumeration is the Frontier's
   job (#34/#35) and populating context.candidateActions is the loop's job (#37). Do NOT add candidateActions to
   the frozen domain contract.
   **Why:** preserves decomposition discipline (frozen StartCrawlRun shell, see [[e2-crawl-engine-decomposition]]).
   **How to apply:** when #37 wires the real loop, populate `candidateActions` on the context object passed to
   `decide()`; do not change DecisionPolicyPort.ts.
2. **Chain-head wiring deferred to #37.** wire.ts currently does `createPolicyChain(llmPolicy, llmPolicy)` — LLMPolicy
   is the head today, with an explicit `TODO(#37): wrap llmPolicy with CachedKnowledgePolicy as chain head`. So
   full runtime cache-first (LLM-less untried selection) is NOT exercised in prod yet — it is fully unit-tested with
   the real chain assembled in tests. #37 MUST make `CachedKnowledgePolicy` the chain head AND populate candidates.
   **Why:** #37 is the sanctioned composition-root/wire.ts owner (ADR-0004 §7.2); #36's barrel removed the old
   `LlmDecisionPolicy` stub, forcing a minimal compat edit to wire.ts to keep `packages/api` building.
   **How to apply:** at the #37 gate, FAIL if the chain head is still LLMPolicy or if candidateActions is never
   populated — that is where the deferred behavior becomes load-bearing and must be present.

**#37 plan decision (E2.7-integration-plan.md): the frozen shell IS unfrozen at #37.** ADR-0004 §7.2 literally said
StartCrawlRun.ts + collaborators.ts are "never edited by #37", but the frozen loop cannot produce #37 runtime
behavior (it never calls getEnumeratedCandidates, never populates candidateActions, hardcodes llmCallCount/tokenCount
to 0, has no redaction/2FA/no-production/reset call-site). These are loop call-sites, not collaborator bodies.
**Sanctioned addendum:** #37 unfreezes both files ADDITIVELY — constructor signature `new StartCrawlRun(driver,
policy, collaborators)` UNCHANGED; `defaultCollaborators({repo,stream})` keeps compiling; new collaborators
(CredentialRedactor, CredentialBoundaryDetector, DuplicatePathDetector, base-candidate enumerator, usageReporter,
optional simulatorLifecycle) arrive as OPTIONAL CrawlCollaborators/CollaboratorOptions fields. **Why:** the freeze's
sole purpose (concurrent Wave-1/2) is done; #37 is the serial capstone. **How to apply:** at the #37 gate, verify the
edit is additive/backward-compatible (all AC1–AC3 tests still construct it the old way) and engine stays port-only
(no PolicyChain/SDK import in application — usage feed goes through the injected usageReporter, not a PolicyChain
import). No new DOMAIN contract is needed: CredentialPromptEvent, blocked-on-2fa status, duplicatePathNodeIds all
already exist; duplicate-path detection is STRUCTURAL only (semantic grouping is E3).
