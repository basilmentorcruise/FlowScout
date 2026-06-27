# Evaluation Scenarios — App-purpose + workflow naming & feature grouping (E3.3 / #56)

Per ADR-0001 §7 and ADR-0007 §4. These scenarios are encoded as runnable unit tests in
`packages/application/src/semantic/grouping/__tests__/eval-scenarios.test.ts` (the
`"grouping eval scenarios"` describe block) and run in CI on every PR. They define the
correctness invariants of the two-tier (rule-first, budgeted-LLM) naming/grouping: tier-1
always runs deterministically (no LLM); tier-2 refines only weak workflows, through the
injected `LlmPort`, budgeted/cached; the LLM may only label/group (never invent, drop, or
reorder a workflow); and every consumed string is redacted before any sink.

All scenarios are deterministic — driven by `FakeLlmPort` (a scripted `LlmPort` test double).
No network, no SDK, no real model.

---

## EVAL-1: Login + checkout workflows → correct names + groups + coherent purpose via tier-1 (no LLM)

**Scenario:** A login workflow (`Sign in screen → Home dashboard`) and a checkout workflow
(`Shopping cart → Checkout and payment → Order confirmed`), with a rich `IntentModel` overlay.

**Expected behavior:**

- **Zero LLM calls** (`refineOnlyWeak: true` and both workflows have strong intent signal ⇒ not
  weak; `inferPurposeWithLlm: false`).
- The login workflow → `featureGroup: "Authentication"`, name `"Sign in screen → Home dashboard"`.
- The checkout workflow → `featureGroup: "Cart & Checkout"`.
- The map → `appPurpose: "An app for Authentication, Cart & Checkout"`, `appPurposeConfidence:
null` (rule-derived).

This exercises the rule-first design: the bulk of naming/grouping is deterministic and LLM-free.

---

## EVAL-2: Weak/low-signal workflow → degraded tier-1, then LLM-sourced refinement when enabled

**Scenario:** An opaque, icon-only workflow with no matching intent (`Path A → B`, a single
`tap region` step).

**Expected behavior:**

- **(a) Refinement disabled** ⇒ the degraded-but-present tier-1 stands: `featureGroup:
"Ungrouped"`, the provisional name `"Path A → B"`, `inferenceConfidence: null`, **zero LLM
  calls**. Never crashes, never emits an empty label.
- **(b) Refinement enabled + scripted LLM** ⇒ exactly one LLM call; the workflow becomes
  `name: "Open hidden filters"`, `featureGroup: "Search & Browse"`, with non-null confidence
  (`source: llm`).

This exercises R-1 (intent-signal quality): weak workflows always have a present degraded
fallback, and tier-2 refines them only when enabled and in budget.

---

## EVAL-3: Secret-bearing intent → redacted everywhere; authoritative-set invariant intact

**Scenario:** An OTP screen whose intent strings carry a seeded OTP (`482913`). The scripted
LLM even echoes the OTP back in its proposed name and the app purpose.

**Expected behavior:**

- The OTP (`482913`) appears in **none** of #56's output fields (`name`, `description`,
  `featureGroup`, `appPurpose`) and **never** in the LLM prompt — it is redacted by
  `CredentialRedactor` before the cache key, the prompt, and the stored/returned labels, and the
  LLM's own echoed output is re-redacted (defense-in-depth, T2).
- The authoritative-set invariant holds: the output workflow keeps the same `id` and `steps` as
  the input (the LLM relabels only; it never invents, drops, or reorders a workflow).

This exercises M56.1/M56.3 (redaction before any sink + label-only LLM).

---

## Running

```bash
pnpm --filter @flowscout/application exec vitest run src/semantic/grouping/__tests__/eval-scenarios.test.ts
```
