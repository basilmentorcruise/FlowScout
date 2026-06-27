/**
 * cosine — pure cosine-similarity + embedding-validation helpers for E3 sameness (#57).
 *
 * Per ADR-0005 §4.3: the dimensionality check (`MIN_EMBEDDING_DIM`) and the cosine math live in
 * `domain` (pure, deterministic, no SDK). Only the PRODUCTION of the vector is in the adapter.
 *
 * Precision/robustness (ADR-0005 §3, item 5): an empty / mismatched-length / low-dim / non-finite
 * vector is treated as DEGRADED — `cosineSimilarity` returns `null` so the caller falls back to
 * a11y-only identity (never a guessed merge, never a crash, NFR6).
 */

/**
 * True iff the vector is usable for a merge decision: non-empty, all-finite, and at least
 * `minDim` dimensions. A degenerate vector (empty, NaN, or below `MIN_EMBEDDING_DIM`) is rejected
 * so it cannot silently merge unrelated buckets (ADR-0005 §3).
 */
export function isUsableEmbedding(
  vector: readonly number[] | undefined,
  minDim: number,
): vector is readonly number[] {
  if (vector === undefined || vector.length === 0) return false;
  if (vector.length < minDim) return false;
  for (const component of vector) {
    if (!Number.isFinite(component)) return false;
  }
  return true;
}

/**
 * Cosine similarity of two vectors, in `[-1, 1]`.
 *
 * Returns `null` (DEGRADED — caller falls back to a11y-only) when either vector is unusable,
 * the lengths differ, or either has zero magnitude. Never throws.
 *
 * @param a       first embedding vector.
 * @param b       second embedding vector.
 * @param minDim  minimum dimensionality both vectors must meet (`MIN_EMBEDDING_DIM`).
 */
export function cosineSimilarity(
  a: readonly number[] | undefined,
  b: readonly number[] | undefined,
  minDim: number,
): number | null {
  if (!isUsableEmbedding(a, minDim) || !isUsableEmbedding(b, minDim)) return null;
  if (a.length !== b.length) return null;

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }

  if (magA === 0 || magB === 0) return null; // zero-magnitude ⇒ undefined cosine ⇒ degraded

  const similarity = dot / (Math.sqrt(magA) * Math.sqrt(magB));
  // Clamp tiny floating-point overshoot so the value stays a valid cosine in [-1, 1].
  if (similarity > 1) return 1;
  if (similarity < -1) return -1;
  return similarity;
}
