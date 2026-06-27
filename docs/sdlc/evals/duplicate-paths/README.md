# Evaluation Scenarios — Semantic duplicate / hidden-path detection (E3.5 / #58)

Per ADR-0001 §7 and ADR-0005 §4.4. These scenarios are encoded as runnable unit tests in
`packages/application/src/semantic/sameness/__tests__/eval-scenarios.test.ts` and run in CI on
every PR. They exercise the FULL pipeline end-to-end — the post-hoc embedding-pass orchestrator
`RefineIdentities` (driven by a scripted `FakeEmbeddingPort`) THEN the pure
`SemanticDuplicateDetector` — with **no real LLM and no simulator**.

This is the **semantic complement** to E2's structural `DuplicatePathDetector` (same-raw-id
convergence). #58 detects the **cross-identity** case E2 misses: ≥2 workflows reach the **same
canonical outcome** via **distinct raw state identities** (identities the refiner merged), flags the
less-prominent route `isHiddenPath = true`, and emits a `DuplicatePathGroup` association for E4.

The governing bias is **PRECISION OVER RECALL**: a false positive (flagging a similar-but-distinct
pair) is worse than a miss. The detector introduces **no new merging** — it only reads the refiner's
(already precision-biased) canonical map, then adds a **second** precision gate at flag time (the
cross-identity scoping + the outcome-intent confirmation).

All scenarios are deterministic — fixed scripted vectors pin the exact cosines; a fixture
`IntentModel` (no live provider) drives the confirmation gate.

---

## EVAL-1: Genuine cross-identity hidden path → FLAGGED (the differentiator, AC1)

**Scenario:** Two a11y-distinct outcome buckets (`out-x`, `out-y`) describe the same outcome reached
two ways. Their redacted-skeleton embeddings are near-identical (scripted cosine ≥ 0.94) so the
refiner merges them into one canonical class. Two workflows reach them — a 2-step route and a 3-step
route.

**Expected behavior:**

- The two outcomes collapse to **one canonical identity**; the two workflows group into **one**
  `DuplicatePathGroup`.
- The **most direct** route (fewest steps) is the `canonicalWorkflowId`; the longer route is marked
  `isHiddenPath = true`.

**Tests:** `"merges two distinct outcome buckets and flags the longer route hidden"`.

---

## EVAL-2: Similar-but-distinct outcomes → NOT FLAGGED (the precision floor, AC2)

**Scenario:** Two outcomes (`out-confirmed`, `out-cancelled`) whose embeddings are far apart
(scripted cosine 0). The refiner keeps them **distinct** → different canonical ids.

**Expected behavior:**

- **No** `DuplicatePathGroup` is emitted and **no** workflow is flagged hidden. A similar-but-distinct
  pair the refiner kept distinct is **never** even grouped (cross-identity scoping requires a shared
  canonical outcome).

This is the precision floor: a near-collision must not silently fuse two different outcomes.

**Tests:** `"keeps below-threshold outcomes distinct ⇒ no group, no hidden flag"`.

---

## EVAL-3: Transitive merge → label-conflict SUPPRESSED, clean merge FLAGGED (AC3)

**Scenario:** Three outcome buckets where `out-a` and `out-b` clear the 0.94 gate **only through** a
middle bridge bucket `out-c` (cosine A–C and C–B clear; A–B does **not**). The refiner co-classes all
three transitively — the **transitive label-veto bypass** the refiner's pairwise veto can miss.

**Expected behavior:**

- **Conflicting** confident (`source === "llm"`) outcome purposes (`"Order confirmed"` vs
  `"Order cancelled"`) ⇒ the flag-time **outcome-intent confirmation gate** SUPPRESSES the group
  (precision wins). No group, no hidden flag. This is handled at flag time, **without editing the
  #57 refiner**.
- **Agreeing** purposes ⇒ the group **is** flagged and the longer route marked hidden.
- A conflicting purpose that is **not** LLM-confident never suppresses (absence/degraded ≠ conflict).

**Tests:** `"co-classes A and B transitively via C (the bypass exists)"`,
`"SUPPRESSES the false duplicate when outcome labels confidently conflict"`,
`"FLAGS the clean transitive merge and marks the hidden route"`.

---

## Budget / cache / redaction invariants (the inherited HIGH controls)

These are asserted by the **orchestrator** suite
(`packages/application/src/semantic/sameness/__tests__/RefineIdentities.test.ts`) — the FIRST real
consumer of `FakeEmbeddingPort`:

| Invariant                 | Assertion (test)                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| One embedding per bucket  | `FakeEmbeddingPort.callCount === N`; cache keys = the N distinct identities (AC4).              |
| Cache reuse               | a pre-populated bucket is **not** re-embedded (AC5).                                            |
| Budget bound              | with a ceiling K < N, `callCount ≤ K`; the rest are a11y-only; one result still produced (AC6). |
| Every attempt counts      | a degraded embedding still consumes a budgeted call (T3).                                       |
| Redaction before egress   | the projector / port only ever see REDACTED text; no seeded secret reaches the skeleton (AC7).  |
| Degradation / determinism | empty graph + degraded embedding never crash; repeated runs are deep-equal (AC9/AC10).          |
| No-SDK boundary           | no `@anthropic-ai/sdk` / `@ai-sdk` / `ai` import in `application`/`domain` (AC8 — depcruiser).  |
