/**
 * SamenessRefiner — the pure, deterministic E3 identity-refinement core (#57, ADR-0005 §2/§7).
 *
 * Given the set of DISTINCT a11y buckets for a run — each carrying its a11y signature, its
 * (optional, post-hoc, redacted) screen-embedding vector, and its (optional) semantic label —
 * the refiner produces the cross-screen IDENTITY EQUIVALENCE CLASSES per the gated cascade:
 *
 *   1. A11y signature = the AUTHORITATIVE COARSE BUCKET. It DEFINES the buckets; the refiner can
 *      only ever UNION buckets, never split one (the HARD INVARIANT — ADR-0005 §2.2).
 *   2. Screen-embedding cosine = the CROSS-BUCKET MERGE GATE. Two DIFFERENT buckets merge only if
 *      `cosine ≥ mergeThreshold`. Cosines in the dead-band `[threshold − margin, threshold)` are
 *      DISTINCT (precision). A degraded/low-dim vector ⇒ no merge (a11y-only).
 *   3. Semantic label = the VETO / annotation gate. Confident, normalized, CONFLICTING labels veto
 *      an otherwise-passing merge. The label can never CREATE a merge — only kill one.
 *
 * HARD INVARIANT (ADR-0005 §2.2, M57.4): a refinement MERGES buckets but NEVER SPLITS one — so the
 * number of classes is always ≤ the number of input buckets (node count can only DECREASE vs E2,
 * never increase). With `refinementEnabled = false`, every bucket is its own singleton class
 * (byte-for-byte E2 behaviour).
 *
 * Determinism (ADR-0005 §2.3): the canonical identity of a class is the LEXICOGRAPHICALLY-SMALLEST
 * a11y signature in the class — independent of input/visit order. Pure: no I/O, no SDK, no
 * randomness.
 */
import type { StateIdentity } from "../state-graph.js";
import { makeStateIdentity } from "../state-graph.js";
import type { SamenessConfig } from "./SamenessConfig.js";
import { cosineSimilarity } from "./cosine.js";

/** One distinct a11y bucket plus its (optional, post-hoc) refinement signals. */
export interface BucketInput {
  /** The authoritative a11y-signature identity for this bucket (the coarse-bucket key). */
  readonly signature: StateIdentity;
  /**
   * The redacted screen-embedding vector for this bucket (optional). Absent / empty / low-dim ⇒
   * this bucket cannot participate in a cross-bucket merge (a11y-only).
   */
  readonly embedding?: readonly number[];
  /** The (optional) confident semantic label for this bucket (veto gate input). */
  readonly semanticLabel?: string;
}

/** Why a candidate pair did not merge (telemetry for eval tuning — never acted on). */
export type DeadBandNote = {
  readonly a: StateIdentity;
  readonly b: StateIdentity;
  readonly cosine: number;
};

/** The result of refinement: equivalence classes + a canonical-id lookup + telemetry. */
export interface RefinementResult {
  /**
   * Maps every input a11y signature to its class's CANONICAL identity (the
   * lexicographically-smallest signature in the class). With refinement off, this is the identity
   * map (each signature → itself).
   */
  readonly canonicalBySignature: ReadonlyMap<StateIdentity, StateIdentity>;
  /** The equivalence classes: canonical id → all member signatures (sorted, deterministic). */
  readonly classes: ReadonlyMap<StateIdentity, readonly StateIdentity[]>;
  /**
   * Dead-band pairs: candidates that scored in `[threshold − margin, threshold)` and were kept
   * DISTINCT. Surfaced for threshold tuning only — NOT acted on (ADR-0005 §3).
   */
  readonly deadBandNotes: readonly DeadBandNote[];
}

// ── Label normalization (veto gate) ───────────────────────────────────────────

/** Normalize a label for the veto comparison: trim + lowercase + collapse whitespace. */
function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * True iff the label gate VETOES a merge between two buckets.
 * Veto only when BOTH labels are present, confident (non-empty after normalization), and DISAGREE.
 * Absent or equal labels never veto (ADR-0005 §2.1).
 */
function labelVetoes(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const na = normalizeLabel(a);
  const nb = normalizeLabel(b);
  if (na.length === 0 || nb.length === 0) return false;
  return na !== nb;
}

// ── Union-Find (deterministic, canonical = lexicographically-smallest signature) ──

class UnionFind {
  private readonly parent = new Map<string, string>();

  add(key: string): void {
    if (!this.parent.has(key)) this.parent.set(key, key);
  }

  find(key: string): string {
    let root = key;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root) as string;
    }
    // Path-compress toward the root.
    let cursor = key;
    while (this.parent.get(cursor) !== root) {
      const next = this.parent.get(cursor) as string;
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  /** Union two keys; the canonical root is the lexicographically-smaller of the two roots. */
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const canonical = ra < rb ? ra : rb;
    const other = ra < rb ? rb : ra;
    this.parent.set(other, canonical);
  }
}

/**
 * SamenessRefiner — pure cross-bucket equivalence-class computation (the gated cascade).
 *
 * Injected with the run's `SamenessConfig`. Stateless across calls; `refine` is a pure function
 * of its `buckets` argument and the config.
 */
export class SamenessRefiner {
  constructor(private readonly config: SamenessConfig) {}

  /**
   * Compute the identity equivalence classes for a run's distinct a11y buckets.
   *
   * @param buckets  one entry per DISTINCT a11y bucket (de-duplicated by signature upstream).
   * @returns        canonical-id mapping + classes + dead-band telemetry.
   */
  refine(buckets: readonly BucketInput[]): RefinementResult {
    const uf = new UnionFind();
    // Seed every bucket as its own singleton (a11y floor — never split below this).
    // De-duplicate by signature defensively: identical signatures are already the SAME bucket.
    const bySignature = new Map<string, BucketInput>();
    for (const bucket of buckets) {
      const sig = bucket.signature as string;
      uf.add(sig);
      // Keep the first occurrence's signals; identical-signature inputs are the same bucket.
      if (!bySignature.has(sig)) bySignature.set(sig, bucket);
    }

    const deadBandNotes: DeadBandNote[] = [];

    // The gated cascade runs ONLY when refinement is enabled. Off ⇒ singletons (E2 behaviour).
    if (this.config.refinementEnabled) {
      this.applyCascade(bySignature, uf, deadBandNotes);
    }

    return this.buildResult(bySignature, uf, deadBandNotes);
  }

  // ── The cross-bucket gated cascade (O(B²) over distinct buckets) ─────────────

  private applyCascade(
    bySignature: ReadonlyMap<string, BucketInput>,
    uf: UnionFind,
    deadBandNotes: DeadBandNote[],
  ): void {
    const { mergeThreshold, mergeMargin, labelVetoEnabled, minEmbeddingDim } = this.config;
    const deadBandFloor = mergeThreshold - mergeMargin;

    // Sorted, stable iteration order so telemetry + path-compression are deterministic.
    const entries = [...bySignature.values()].sort((x, y) =>
      (x.signature as string) < (y.signature as string) ? -1 : 1,
    );

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const left = entries[i] as BucketInput;
        const right = entries[j] as BucketInput;

        // GATE 2 — cross-bucket embedding cosine. Degraded/low-dim ⇒ null ⇒ no merge (a11y-only).
        const cosine = cosineSimilarity(left.embedding, right.embedding, minEmbeddingDim);
        if (cosine === null) continue;

        if (cosine < mergeThreshold) {
          // Dead-band: record a tuning note but DO NOT merge (precision — ADR-0005 §3).
          if (cosine >= deadBandFloor) {
            deadBandNotes.push({ a: left.signature, b: right.signature, cosine });
          }
          continue;
        }

        // GATE 3 — semantic-label veto. A confident conflict kills the borderline merge.
        if (labelVetoEnabled && labelVetoes(left.semanticLabel, right.semanticLabel)) {
          continue;
        }

        // Passed both gates ⇒ MERGE the two buckets into one equivalence class.
        uf.union(left.signature, right.signature);
      }
    }
  }

  // ── Result assembly (canonical = lexicographically-smallest member) ──────────

  private buildResult(
    bySignature: ReadonlyMap<string, BucketInput>,
    uf: UnionFind,
    deadBandNotes: readonly DeadBandNote[],
  ): RefinementResult {
    const canonicalBySignature = new Map<StateIdentity, StateIdentity>();
    const classMembers = new Map<string, string[]>();

    for (const sig of bySignature.keys()) {
      const root = uf.find(sig);
      canonicalBySignature.set(makeStateIdentity(sig), makeStateIdentity(root));
      const members = classMembers.get(root) ?? [];
      members.push(sig);
      classMembers.set(root, members);
    }

    const classes = new Map<StateIdentity, readonly StateIdentity[]>();
    for (const [root, members] of classMembers) {
      const sorted = [...members].sort().map((m) => makeStateIdentity(m));
      classes.set(makeStateIdentity(root), sorted);
    }

    return { canonicalBySignature, classes, deadBandNotes };
  }
}
