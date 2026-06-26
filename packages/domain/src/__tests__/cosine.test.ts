/**
 * Tests for the pure cosine-similarity + embedding-validation helpers (#57, ADR-0005 §4.3).
 *
 * Covers: identical vectors → 1; orthogonal → 0; opposite → -1; length-mismatch / empty / low-dim /
 * non-finite / zero-magnitude → null (degraded, never throws); floating-point clamp to [-1, 1].
 */
import { describe, it, expect } from "vitest";
import { cosineSimilarity, isUsableEmbedding } from "../models/state-identity/cosine.js";

const MIN_DIM = 4;

/** Build a length-`n` vector by repeating `fill`, with `head` overriding the first slots. */
function vec(n: number, fill: number, head: readonly number[] = []): number[] {
  const out = new Array<number>(n).fill(fill);
  head.forEach((value, i) => (out[i] = value));
  return out;
}

describe("isUsableEmbedding", () => {
  it("rejects undefined / empty / below-min-dim vectors", () => {
    expect(isUsableEmbedding(undefined, MIN_DIM)).toBe(false);
    expect(isUsableEmbedding([], MIN_DIM)).toBe(false);
    expect(isUsableEmbedding([1, 2, 3], MIN_DIM)).toBe(false); // 3 < 4
  });

  it("rejects vectors with non-finite components", () => {
    expect(isUsableEmbedding([1, 2, 3, Number.NaN], MIN_DIM)).toBe(false);
    expect(isUsableEmbedding([1, 2, 3, Number.POSITIVE_INFINITY], MIN_DIM)).toBe(false);
  });

  it("accepts a finite vector at/above min-dim", () => {
    expect(isUsableEmbedding([1, 2, 3, 4], MIN_DIM)).toBe(true);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = vec(MIN_DIM, 0.5, [0.1, 0.2]);
    expect(cosineSimilarity(v, [...v], MIN_DIM)).toBeCloseTo(1, 10);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = [1, 0, 0, 0];
    const b = [0, 1, 0, 0];
    expect(cosineSimilarity(a, b, MIN_DIM)).toBeCloseTo(0, 10);
  });

  it("returns -1 for opposed vectors", () => {
    const a = vec(MIN_DIM, 1);
    const b = vec(MIN_DIM, -1);
    expect(cosineSimilarity(a, b, MIN_DIM)).toBeCloseTo(-1, 10);
  });

  it("returns null (degraded) on length mismatch", () => {
    expect(cosineSimilarity([1, 2, 3, 4], [1, 2, 3, 4, 5], MIN_DIM)).toBeNull();
  });

  it("returns null on a low-dim / empty / undefined operand (a11y-only fallback)", () => {
    expect(cosineSimilarity([1, 2], [3, 4], MIN_DIM)).toBeNull();
    expect(cosineSimilarity(undefined, vec(MIN_DIM, 1), MIN_DIM)).toBeNull();
    expect(cosineSimilarity(vec(MIN_DIM, 1), [], MIN_DIM)).toBeNull();
  });

  it("returns null for a zero-magnitude vector (undefined cosine)", () => {
    expect(cosineSimilarity(vec(MIN_DIM, 0), vec(MIN_DIM, 1), MIN_DIM)).toBeNull();
  });

  it("clamps tiny floating-point overshoot to within [-1, 1]", () => {
    const v = vec(MIN_DIM, 0.123456789);
    const result = cosineSimilarity(v, [...v], MIN_DIM);
    expect(result).not.toBeNull();
    expect(result as number).toBeLessThanOrEqual(1);
    expect(result as number).toBeGreaterThanOrEqual(-1);
  });

  it("stays at exactly -1 for an opposed pair without underflowing the clamp", () => {
    // Opposed unit vectors give exactly -1; the lower clamp guard must keep it valid.
    const a = vec(MIN_DIM, 2, [3, -1]);
    const b = a.map((x) => -x);
    const result = cosineSimilarity(a, b, MIN_DIM);
    expect(result).not.toBeNull();
    expect(result as number).toBeGreaterThanOrEqual(-1);
    expect(result as number).toBeCloseTo(-1, 10);
  });
});
