/**
 * GroupingCacheKey — derives a STABLE, content-addressed cache key for a workflow labeling
 * (#56, ADR-0007 §3.4).
 *
 * The key is a SHA-256 hash of the REDACTED workflow+intent skeleton: the same redacted
 * content always yields the same key, so two identical workflows share a labeling and a
 * re-run of the same input makes ZERO new LLM calls (FR6). The key is process-independent
 * (a pure content hash), so it does not preclude E7 cross-run persistence.
 *
 * Security (T1/T2): the input is ALREADY redacted by `CredentialRedactor` before this
 * function is called — no secret can leak into a key. We additionally normalise whitespace so
 * cosmetically different (but semantically identical) skeletons collapse to one key.
 *
 * Mirrors `IntentCacheKey` (#55) — `node:crypto` SHA-256, no SDK, deterministic.
 */
import { createHash } from "node:crypto";

/** Stable prefix so grouping keys are visibly distinct from other hash uses. */
export const GROUPING_KEY_PREFIX = "grouping-v1";

/** Distinct prefix for the per-map app-purpose labeling (so it never collides with a workflow key). */
export const PURPOSE_KEY_PREFIX = "grouping-purpose-v1";

/**
 * Computes the content-hash key for a redacted workflow skeleton.
 *
 * @param redactedSkeleton  the workflow+intent skeleton AFTER redaction.
 * @returns                 a stable `grouping-v1:<sha256>` key string.
 */
export function groupingCacheKey(redactedSkeleton: string): string {
  return `${GROUPING_KEY_PREFIX}:${hash(redactedSkeleton)}`;
}

/**
 * Computes the content-hash key for the per-map app-purpose signal.
 *
 * @param redactedSignal  the redacted group/purpose signal for the whole map.
 * @returns               a stable `grouping-purpose-v1:<sha256>` key string.
 */
export function purposeCacheKey(redactedSignal: string): string {
  return `${PURPOSE_KEY_PREFIX}:${hash(redactedSignal)}`;
}

function hash(raw: string): string {
  const normalised = raw.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalised, "utf8").digest("hex");
}
