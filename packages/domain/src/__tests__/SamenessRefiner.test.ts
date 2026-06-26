/**
 * Tests for the pure SamenessRefiner (#57, ADR-0005 §2/§3/§7) — the gated-cascade core.
 *
 * Covers the ADR acceptance bar + the eval scenarios:
 *  - True merge: cross-bucket cosine ≥ threshold + compatible labels ⇒ one class.
 *  - True distinct: cosine below threshold ⇒ stays distinct (precision floor).
 *  - Dead-band: cosine in [threshold−margin, threshold) ⇒ distinct + telemetry note.
 *  - Label veto: borderline-passing cosine but conflicting confident labels ⇒ distinct.
 *  - Degraded embedding: missing / low-dim ⇒ a11y-only (no merge).
 *  - Refinement OFF ⇒ singleton classes (byte-for-byte E2 behaviour).
 *  - NEVER-SPLIT property: class count ≤ bucket count on every input.
 *  - Canonical id = lexicographically-smallest signature; order-independent (determinism).
 */
import { describe, it, expect } from "vitest";
import { SamenessRefiner } from "../models/state-identity/SamenessRefiner.js";
import type { BucketInput } from "../models/state-identity/SamenessRefiner.js";
import { defaultSamenessConfig } from "../models/state-identity/SamenessConfig.js";
import type { SamenessConfig } from "../models/state-identity/SamenessConfig.js";
import { makeStateIdentity } from "../models/state-graph.js";
import type { StateIdentity } from "../models/state-graph.js";

const DIM = 256;

function sig(raw: string): StateIdentity {
  return makeStateIdentity(raw);
}

/** A `DIM`-length unit-ish vector pointing mostly along `axis`, with a small `tilt` on axis+1. */
function dirVec(axis: number, tilt = 0): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[axis] = 1;
  if (tilt !== 0) v[(axis + 1) % DIM] = tilt;
  return v;
}

/** Two vectors whose cosine ≈ `target` (target in [0,1]); both length DIM. */
function pairWithCosine(target: number): { a: number[]; b: number[] } {
  // a = e0 ; b = target*e0 + sqrt(1-target^2)*e1  ⇒ cosine(a,b) = target.
  const a = new Array<number>(DIM).fill(0);
  a[0] = 1;
  const b = new Array<number>(DIM).fill(0);
  b[0] = target;
  b[1] = Math.sqrt(Math.max(0, 1 - target * target));
  return { a, b };
}

function refiner(overrides: Partial<SamenessConfig> = {}): SamenessRefiner {
  return new SamenessRefiner({ ...defaultSamenessConfig(), ...overrides });
}

describe("SamenessRefiner — true merge (recall floor)", () => {
  it("merges two distinct buckets when cosine ≥ threshold and labels agree", () => {
    const { a, b } = pairWithCosine(0.97); // ≥ 0.94
    const result = refiner().refine([
      { signature: sig("bucket-tab"), embedding: a, semanticLabel: "Settings" },
      { signature: sig("bucket-overflow"), embedding: b, semanticLabel: "Settings" },
    ]);

    expect(result.classes.size).toBe(1);
    const canonical = result.canonicalBySignature.get(sig("bucket-overflow"));
    // canonical = lexicographically-smallest of the two signatures.
    expect(canonical).toBe(sig("bucket-overflow")); // "bucket-overflow" < "bucket-tab"
    expect(result.canonicalBySignature.get(sig("bucket-tab"))).toBe(canonical);
  });

  it("merges when one label is absent (absent never vetoes)", () => {
    const { a, b } = pairWithCosine(0.96);
    const result = refiner().refine([
      { signature: sig("a"), embedding: a, semanticLabel: "Profile" },
      { signature: sig("b"), embedding: b },
    ]);
    expect(result.classes.size).toBe(1);
  });
});

describe("SamenessRefiner — true distinct (precision floor)", () => {
  it("keeps buckets distinct when cosine is below the dead-band floor", () => {
    const { a, b } = pairWithCosine(0.5);
    const result = refiner().refine([
      { signature: sig("order-confirmed"), embedding: a },
      { signature: sig("order-cancelled"), embedding: b },
    ]);
    expect(result.classes.size).toBe(2);
    expect(result.deadBandNotes).toHaveLength(0);
  });
});

describe("SamenessRefiner — dead-band (uncertain → distinct + telemetry)", () => {
  it("does NOT merge a cosine inside [0.92, 0.94) but records a tuning note", () => {
    const { a, b } = pairWithCosine(0.93);
    const result = refiner().refine([
      { signature: sig("a"), embedding: a },
      { signature: sig("b"), embedding: b },
    ]);
    expect(result.classes.size).toBe(2);
    expect(result.deadBandNotes).toHaveLength(1);
    expect(result.deadBandNotes[0]?.cosine).toBeCloseTo(0.93, 6);
  });
});

describe("SamenessRefiner — label veto", () => {
  it("vetoes a merge when confident labels conflict (above threshold)", () => {
    const { a, b } = pairWithCosine(0.99);
    const result = refiner().refine([
      { signature: sig("login"), embedding: a, semanticLabel: "Login" },
      { signature: sig("create"), embedding: b, semanticLabel: "Create account" },
    ]);
    expect(result.classes.size).toBe(2);
  });

  it("does NOT veto when labelVetoEnabled is false (merges despite conflict)", () => {
    const { a, b } = pairWithCosine(0.99);
    const result = refiner({ labelVetoEnabled: false }).refine([
      { signature: sig("login"), embedding: a, semanticLabel: "Login" },
      { signature: sig("create"), embedding: b, semanticLabel: "Create account" },
    ]);
    expect(result.classes.size).toBe(1);
  });

  it("merges when labels are equal after normalization (whitespace/case-insensitive)", () => {
    const { a, b } = pairWithCosine(0.99);
    const result = refiner().refine([
      { signature: sig("a"), embedding: a, semanticLabel: "  Settings " },
      { signature: sig("b"), embedding: b, semanticLabel: "settings" },
    ]);
    expect(result.classes.size).toBe(1);
  });
});

describe("SamenessRefiner — degraded embedding ⇒ a11y-only", () => {
  it("does not merge when a vector is missing", () => {
    const { a } = pairWithCosine(0.99);
    const result = refiner().refine([
      { signature: sig("a"), embedding: a },
      { signature: sig("b") }, // no vector
    ]);
    expect(result.classes.size).toBe(2);
  });

  it("does not merge when a vector is below MIN_EMBEDDING_DIM", () => {
    const result = refiner().refine([
      { signature: sig("a"), embedding: [1, 0, 0] },
      { signature: sig("b"), embedding: [1, 0, 0] },
    ]);
    expect(result.classes.size).toBe(2);
  });
});

describe("SamenessRefiner — refinement OFF ⇒ E2 singletons", () => {
  it("returns one singleton class per bucket regardless of cosine", () => {
    const { a, b } = pairWithCosine(0.999);
    const result = refiner({ refinementEnabled: false }).refine([
      { signature: sig("a"), embedding: a, semanticLabel: "X" },
      { signature: sig("b"), embedding: b, semanticLabel: "X" },
    ]);
    expect(result.classes.size).toBe(2);
    expect(result.canonicalBySignature.get(sig("a"))).toBe(sig("a"));
    expect(result.canonicalBySignature.get(sig("b"))).toBe(sig("b"));
  });
});

describe("SamenessRefiner — NEVER-SPLIT invariant (property)", () => {
  it("class count is always ≤ bucket count across varied fixtures", () => {
    const buckets: BucketInput[] = [];
    for (let i = 0; i < 12; i++) {
      // Some share a near-identical direction (mergeable), others are spread out.
      const embedding = i % 3 === 0 ? dirVec(0, 0.02) : dirVec(i + 1);
      buckets.push({ signature: sig(`s-${String(i).padStart(2, "0")}`), embedding });
    }
    const result = refiner().refine(buckets);
    const distinctSignatures = new Set(buckets.map((x) => x.signature)).size;
    expect(result.classes.size).toBeLessThanOrEqual(distinctSignatures);
    // Every original signature maps to a canonical that is itself a valid signature.
    for (const bucket of buckets) {
      expect(result.canonicalBySignature.has(bucket.signature)).toBe(true);
    }
  });

  it("merge is transitive within a cluster but never invents a finer partition", () => {
    // Three near-identical directions ⇒ one class; refinement only coarsens.
    const result = refiner().refine([
      { signature: sig("c"), embedding: dirVec(0) },
      { signature: sig("a"), embedding: dirVec(0, 0.01) },
      { signature: sig("b"), embedding: dirVec(0, 0.02) },
    ]);
    expect(result.classes.size).toBe(1);
    const members = [...result.classes.values()][0];
    expect(members).toEqual([sig("a"), sig("b"), sig("c")]); // sorted, canonical = "a"
  });
});

describe("SamenessRefiner — determinism (order-independent canonical id)", () => {
  it("produces the same canonical mapping regardless of input order", () => {
    const { a, b } = pairWithCosine(0.98);
    const order1 = refiner().refine([
      { signature: sig("zeta"), embedding: a },
      { signature: sig("alpha"), embedding: b },
    ]);
    const order2 = refiner().refine([
      { signature: sig("alpha"), embedding: b },
      { signature: sig("zeta"), embedding: a },
    ]);
    expect(order1.canonicalBySignature.get(sig("zeta"))).toBe(sig("alpha"));
    expect(order2.canonicalBySignature.get(sig("zeta"))).toBe(sig("alpha"));
  });

  it("de-duplicates identical-signature inputs (same bucket) without error", () => {
    const { a } = pairWithCosine(0.99);
    const result = refiner().refine([
      { signature: sig("dup"), embedding: a },
      { signature: sig("dup"), embedding: a },
    ]);
    expect(result.classes.size).toBe(1);
  });

  it("handles the empty input (no buckets) gracefully", () => {
    const result = refiner().refine([]);
    expect(result.classes.size).toBe(0);
    expect(result.canonicalBySignature.size).toBe(0);
  });
});
