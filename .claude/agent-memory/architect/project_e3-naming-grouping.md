---
name: e3-naming-grouping
description: ADR-0007 / #56 — workflow naming + feature grouping + app-purpose via budgeted LLM; additive fields on workflow.ts
metadata:
  type: project
---

ADR-0007 (`docs/sdlc/architecture/ADR-0007-e3-naming-grouping-app-purpose-budgeted-llm.md`) is the design for
ticket #56 (E3.3): from the frozen `Workflow[]` (#54) + consumed `IntentModel` (#55), name each workflow, assign a
feature group, and infer the app purpose — all via the reused E2/E3 budgeted-LLM pattern.

**Why:** E3 OQ3 needed the app-purpose + feature-group consumer contract fixed for E4 (HTML report) before #56
builds; the architect chose **additive optional fields ON the existing `Workflow`/`WorkflowMap` types** (not a
separate overlay like [[e3-intent-inference]]'s `intent.ts`), because `Workflow`/`WorkflowMap` are E3-owned and
report-bound, so the producer and schema owner are the same epic.

**How to apply (gate #56 here):**

- Additive fields: optional `Workflow.featureGroup?`, `WorkflowMap.appPurpose?`, `WorkflowMap.appPurposeConfidence?`
  on `packages/domain/src/models/workflow.ts`. Optional ⇒ no break to existing literals; domain barrel UNCHANGED
  (those types already re-exported). New `GroupingCachePort` DOES need a barrel export line. These are the
  sanctioned additive changes — confirm no existing field changed/required, no `description` overloading.
- New subtree `packages/application/src/semantic/grouping/**` (mirrors `semantic/intent/**`). Reuses
  `IntentBudgetGuard` directly (it is generic over `CrawlBudget`, not intent-specific), `CredentialRedactor`,
  `LlmPort`, `ConfidenceScore`. No second guard/redactor.
- HARD invariant to verify at review: **LLM only labels/groups — never invents/drops/merges/splits/reorders a
  workflow** (id-allowlist merge, same discipline as `LlmIntentRefiner.merge()` for edgeIds). Output workflow set
  must have identical ids/cardinality/steps to input.
- Budget/cache/redaction/abort identical to ADR-0006; deterministic fallback = rule names + `featureGroup="Ungrouped"`,
  `appPurpose="Unknown"`, null confidence. App-purpose is ONE LLM call per map (not per-workflow) — bounds fan-out.
- Security MUST controls M56.1–M56.5 (threat model `e3-semantic-workflow-mapping-threat-model.md`): redaction
  in+out (T1/T2), budgeted/abortable/cached (T3), port-only no-SDK (T4/T8), schema-validated no-eval (T6), and
  flag all 4 string fields (name/description/featureGroup/appPurpose) as inert untrusted-origin → E4 must
  output-encode (T7 handoff).
- `Touches:` only shared file with #57 is `packages/application/src/index.ts` (additive export lines) — expect a
  trivial rebase, no logical conflict. Wiring + final WorkflowMap assembly that stamps the fields = #59 capstone,
  NOT #56 (#56 does not edit `packages/api`). Eval scenarios under `docs/sdlc/evals/grouping/` (≥3).
