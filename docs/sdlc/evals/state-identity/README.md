# Evaluation Scenarios — StateIdentity Strategy (E2.2 / #32)

Per ADR-0001 §7 and ADR-0004 §2.3. These scenarios are encoded as runnable unit tests in
`packages/domain/src/__tests__/state-identity.test.ts` (the "eval scenarios" describe block)
and run in CI on every PR. They define the correctness invariants of the
`A11ySignatureStrategy` default implementation.

---

## EVAL-1: Same screen via two paths — volatile content must not fork identity

**Scenario:** The same app screen is reached via two distinct navigation paths. The two
observations differ only in volatile content (an injected `StaticText` with a timestamp
`2024-01-15T10:30:00Z` and a counter `42 items`). The structural skeleton (navigation bar,
scroll view with two buttons) is identical.

**Input A — path 1 (no volatile leaf):**

```json
{
  "type": "Application",
  "children": [
    { "type": "NavigationBar", "label": "Home" },
    {
      "type": "ScrollView",
      "children": [
        { "type": "Button", "label": "Settings" },
        { "type": "Button", "label": "Profile" }
      ]
    }
  ]
}
```

**Input B — path 2 (volatile StaticText added):**

```json
{
  "type": "Application",
  "children": [
    { "type": "NavigationBar", "label": "Home" },
    {
      "type": "ScrollView",
      "children": [
        { "type": "Button", "label": "Settings" },
        { "type": "Button", "label": "Profile" },
        { "type": "StaticText", "label": "Last sync: 2024-01-15T10:30:00Z — 42 items" }
      ]
    }
  ]
}
```

**Expected behavior:** `strategy.identify(A) === strategy.identify(B)`.
The `StaticText` node has no `accessibilityIdentifier` or `testId` — it is a content-only
leaf and is dropped from the structural skeleton. The timestamp/counter in its label would
also be normalized away. Both inputs produce the same SHA-256 hash.

**Test:** `"EVAL-1: same screen via two paths with differing volatile content → same identity"`

---

## EVAL-2: Two materially different screens → different identities

**Scenario:** A Home screen (NavigationBar + ScrollView with Button children) vs. a Settings
screen (NavigationBar + Table with Cell children). These have different roles and different
structural organisation.

**Expected behavior:** `strategy.identify(HOME) !== strategy.identify(SETTINGS)`.
The structural skeletons serialize to different strings and therefore produce different
SHA-256 hashes.

**Test:** `"EVAL-2: two materially different screens → different identities"`

---

## EVAL-3: Same list screen with 3 vs 200 rows → same identity (sibling collapse)

**Scenario:** An Inbox screen with a `Table` node containing chat message `Cell` rows. One
observation has 3 rows; a later observation (same session, different scroll state) has 200
rows. Each row has a volatile timestamp in its label.

**Expected behavior:** `strategy.identify(3 rows) === strategy.identify(200 rows)`.
Sibling collapse (configured `MAX_SIBLING_ROWS = 3`) caps repeated same-role siblings to 3
occurrences before hashing. Combined with timestamp normalization (`<ts>`) and digit-run
normalization (`#`), both observations produce the same skeleton and hash.

This is the primary **cost-control invariant** (ADR-0004 §2.2, T6 in the threat model):
a genuinely dynamic list screen does not explode the state graph into unbounded
near-duplicate nodes, which would multiply LLM calls proportionally.

**Test:** `"EVAL-3: same list screen with 3 vs 200 rows → same identity (sibling collapse)"`

---

## EVAL-4: Empty/malformed snapshot → degraded identity, never throws

**Scenario:** The accessibility tree snapshot is empty (e.g. the driver returned an empty
string before the app fully rendered). This is the edge case "empty/oversized snapshot →
handled, not swallowed" from PRD-e2 edge cases and T11 in the threat model.

**Expected behavior:**

- `strategy.identify({ a11ySnapshot: "" })` returns an identity matching `/^degraded:/`.
- The call does NOT throw.
- The degraded identity is a valid `StateIdentity` (non-empty branded string).
- Two distinct malformed inputs produce different degraded ids (so distinct bad screens are
  not collapsed into one node).

**Test:** `"EVAL-4: empty/malformed snapshot → degraded identity (never throws)"`

---

## Normalization rules implemented

| Volatile pattern       | Normalization                 | Example                                     |
| ---------------------- | ----------------------------- | ------------------------------------------- |
| ISO-8601 timestamps    | `<ts>`                        | `2024-01-15T10:30:00Z` → `<ts>`             |
| Clock times (12/24h)   | `<ts>`                        | `10:30 AM` → `<ts>`                         |
| Currency amounts       | `<num>`                       | `$12.99`, `€9.99` → `<num>`                 |
| Percentages            | `<num>`                       | `45%`, `78.5%` → `<num>`                    |
| Digit runs (2+ digits) | `#`                           | `42`, `100`, `2024` → `#`                   |
| Repeated sibling rows  | cap at `MAX_SIBLING_ROWS = 3` | 200 `Cell` rows → 3                         |
| Content-only leaves    | dropped                       | `StaticText`/`Text`/`Label` with no a11y id |

---

## Degraded identity behavior

When an input cannot be processed (empty, oversized, unparseable, or yields an empty
structural skeleton), the strategy returns:

```
makeStateIdentity("degraded:" + sha256hex(truncatedRawSnapshot))
```

This means:

- The run never crashes on a bad snapshot.
- Distinct bad snapshots still get distinct ids (different hashes of different raw inputs).
- The loop can record a telemetry note and continue.
- The degraded id is stable: the same bad input always produces the same degraded id.

---

## Interface signature (for #34 injection)

```ts
// packages/domain/src/ports/StateIdentityPort.ts
export interface StateIdentityInput {
  readonly a11ySnapshot: A11ySnapshot; // mandatory (E2)
  readonly screenEmbedding?: readonly number[]; // additive, E3-supplied (optional, ignored by default impl)
  readonly semanticLabel?: string; // additive, E3-supplied (optional)
  readonly platform: Platform;
}

export interface StateIdentityStrategy {
  /** Stable identity for a screen. Never throws on empty/malformed input. */
  identify(input: StateIdentityInput): StateIdentity;
}
```

**Injected via:** `CompositeStateIdentityStrategy(primary: StateIdentityStrategy)` — #34
injects `new CompositeStateIdentityStrategy(new A11ySignatureStrategy())` at the
composition seam, replacing the `PlaceholderIdentity` stub that #31 ships.
