---
name: project-e35-semantic-duplicate-detection
description: E3.5 semantic duplicate/hidden-path detection (#58) — QA gate outcome and gotchas
metadata:
  type: project
---

Ticket #58 QA gate PASSED at PR #71 (head fa862ced22f207358af285696494f0115a3b6540, branch fs-58-duplicate-detection).

**Key implementation facts:**

- Two components: `RefineIdentities` (post-hoc embedding-pass orchestrator) + `SemanticDuplicateDetector` (pure/sync).
- Cross-identity scoping is the precision gate: only flags when ≥2 workflows have DISTINCT raw outcome IDs that the refiner merged to the same canonical ID. Pure same-raw-id convergence is left to E2's `duplicatePathNodeIds`.
- Second precision gate at flag time: `outcomePurposesConflict()` suppresses a group when confident (llm) outcome purposes disagree (the transitive A–C–B veto bypass guard).
- `projectA11ySkeleton` is an additive extract of the private `buildSkeleton` in `A11ySignatureStrategy`; `identify()` delegates to it — identity hashing is byte-for-byte unchanged (verified by 79/79 domain tests).
- `EmbeddingCachePort` and `DuplicatePathGroup` are new additive domain contracts, barelled in domain `src/index.ts`.
- Budget folds into `maxLlmCalls`/`maxTokens` — no separate `maxEmbeddingCalls` knob.

**Coverage at gate:** `semantic/sameness` = 100% line / 100% func / 95.34% branch (≥85% gate). `SemanticDuplicateDetector` branch gaps: defensive `??`-fallback (line 70), sort comparator paths (82, 124), empty-purpose guard (172) — none behavioral.

**Eval scenarios:** EVAL-1 (AC1 genuine flag), EVAL-2 (AC2 precision floor), EVAL-3 (AC3 transitive-veto suppress + clean-merge flag) all run in CI via `eval-scenarios.test.ts`.

**Live-crawl wiring + WorkflowMap assembly are deferred to #59.** Do not fail #58 for their absence.

**Why:** The transitive label-veto bypass (A–C–B co-classing) is a real risk: A and B can transitively clear 0.94 via bridge C even when A–B cosine is below threshold. The flag-time intent gate handles this without touching the #57 refiner.

**How to apply:** When reviewing or re-running this gate, the key adversarial checks are (1) EVAL-2 precision floor with orthogonal vectors, (2) EVAL-3 transitive merge with conflicting intent labels, and (3) AC7 redaction (seeded `secureTextField` value + 6-digit OTP absent from skeleton and embedding cache key).
