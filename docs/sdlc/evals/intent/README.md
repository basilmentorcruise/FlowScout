# Evaluation Scenarios — Per-screen & per-control intent inference (E3.2 / #55)

Per ADR-0001 §7 and ADR-0006 §4. These scenarios are encoded as runnable unit tests in
`packages/application/src/semantic/intent/__tests__/eval-scenarios.test.ts` (the
`"intent eval scenarios"` describe block) and run in CI on every PR. They define the
correctness invariants of the two-tier (a11y-first, budgeted-LLM) inference: tier-1 always
runs deterministically (no LLM); tier-2 refines only weak screens, through the injected
`LlmPort`, budgeted/cached; and every a11y/label string is redacted before any sink.

All scenarios are deterministic — driven by `FakeLlmPort` (a scripted `LlmPort` test double).
No network, no SDK, no real model.

---

## EVAL-1: Labelled login screen → correct screen purpose + per-control intents via tier-1 (no LLM)

**Scenario:** A fully-labelled sign-in screen (`SIGN_IN_SNAPSHOT`): a `staticText` "Sign In",
an Email `textField`, a Password `secureTextField`, a "Log In" `button`, and a
"Forgot password" `link`. Outgoing edges: two `typeText` edges (Email, Password) and one `tap`
edge (Log In).

**Expected behavior:**

- **Zero LLM calls** (`refineOnlyWeak: true` and tier-1 has full a11y signal ⇒ not weak).
- Screen `purpose` is `"Sign In screen"`, `source: "a11y"`, `confidence: null`.
- The submit control is classified `affordance: "submit"`.
- The two `typeText` controls are classified `affordance: "input"`.
- Every control carries `confidence === null` (non-null confidence is reserved for `source: "llm"`).

**Test:** `"EVAL-1: labelled login screen → correct screen purpose + per-control intents via tier-1 (no LLM)"`

---

## EVAL-2: Unlabelled/icon-only screen → degraded tier-1, then LLM-sourced refinement when enabled

**Scenario:** An icon-only screen (`UNLABELLED_SNAPSHOT`): two `button` nodes with no labels,
and a `tap` edge whose payload is coordinates (`{"x":1,"y":2}`, not a human label).

**Expected behavior:**

- **(a) Refinement disabled** ⇒ degraded-but-present tier-1 stands: `source: "degraded"`,
  `purpose` non-empty (role + element count), `confidence: null`, **zero LLM calls**. Never
  crashes, never emits an empty intent.
- **(b) Refinement enabled + scripted LLM** ⇒ exactly one LLM call; the screen becomes
  `source: "llm"` with non-null confidence; `purpose` is the LLM value
  (`"Onboarding carousel"`); the control intent is the LLM value
  (`"Advance to the next slide"`).

This exercises R-1 (a11y-label quality): weak screens always have a present degraded fallback,
and tier-2 refines them only when enabled and in budget.

**Test:** `"EVAL-2: unlabelled/icon-only screen → degraded tier-1, then LLM-sourced refinement when enabled"`

---

## EVAL-3: Secret-bearing snapshot → redacted everywhere (key, prompt, stored intent)

**Scenario:** A verification screen (`SECRET_SNAPSHOT`) carrying a secure-entry field value
(`hunter2-SECRET`) and an OTP-shaped token in observed static text (`"Your code is 482913"`),
plus a `typeText` edge whose payload is the OTP (`482913`). Refinement enabled, a scripted LLM
returns a clean purpose.

**Expected behavior:**

- The prompt sent to the LLM contains **no** `hunter2-SECRET` and **no** `482913` — both are
  masked to `[REDACTED]` by the reused E2 `CredentialRedactor` (structural `redact()` masks the
  secure-field value; `redactText()` masks the OTP that appears in an observed label).
- The serialized `IntentModel` contains **no** secret/OTP text.

This is the primary **secret-hygiene invariant** (NFR5; T1/T2 in the E3 threat model): no raw
credential/OTP/PII reaches a prompt, the cache key, or the stored intent.

**Test:** `"EVAL-3: secret-bearing snapshot → redacted everywhere (key, prompt, stored intent)"`

---

## Two-tier design (what the scenarios protect)

| Tier            | When                                              | Source     | LLM? | Confidence |
| --------------- | ------------------------------------------------- | ---------- | ---- | ---------- |
| Tier 1 (a11y)   | Always — deterministic derivation from labels     | `a11y`     | No   | `null`     |
| Tier 1 degraded | Missing/empty labels — role + position fallback   | `degraded` | No   | `null`     |
| Tier 2 (LLM)    | Enabled + weak tier-1 + under budget + cache-miss | `llm`      | Yes  | non-null   |

**Budget / cache / redaction invariants** (asserted in the sibling unit + integration suites):

- **Budget:** every tier-2 call is gated by `IntentBudgetGuard.canCall()` (under both
  `maxLlmCalls` and `maxTokens`) and counted by `recordUsage(...)` after every attempt —
  including failures (one call, 0 tokens). Over budget ⇒ tier-1 stands.
- **Cache:** keyed by a SHA-256 content hash of the **redacted** skeleton (`IntentCacheKey`);
  re-running the same input makes **zero** new LLM calls; two distinct screens with identical
  redacted skeletons share one inference.
- **Redaction:** every a11y snapshot + edge payload passes through the E2 `CredentialRedactor`
  before any sink (cache key, prompt, stored intent). Label-only — no screenshot/vision is sent.
- **Resilience:** LLM unavailable / over budget / timeout / unparseable ⇒ degrade to the tier-1
  result with `null` confidence; exactly one well-formed `IntentModel` is always produced.
