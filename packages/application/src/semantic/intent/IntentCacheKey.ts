/**
 * IntentCacheKey — derives a STABLE, content-addressed cache key for screen intent (#55).
 *
 * The key is a SHA-256 hash of the REDACTED a11y skeleton (ADR-0006 §3.4): the same redacted
 * content always yields the same key, so repeated/identical screens reuse one inference and
 * make ZERO new LLM calls (FR6). The key is process-independent (a pure content hash), so it
 * does not preclude E7 cross-run persistence.
 *
 * Security (T7): the input is ALREADY redacted by `CredentialRedactor` before this function is
 * called — no secret can leak into a key. We additionally normalise whitespace so cosmetically
 * different (but semantically identical) skeletons collapse to one key.
 *
 * Mirrors `A11ySignatureStrategy`'s use of `node:crypto` SHA-256 (no SDK, deterministic).
 */
import { createHash } from "node:crypto";

/** Stable prefix so intent keys are visibly distinct from other hash uses. */
export const INTENT_KEY_PREFIX = "intent-v1";

/**
 * Computes the content-hash key for a redacted a11y skeleton.
 *
 * @param redactedSkeleton  the a11y snapshot AFTER `CredentialRedactor.redact(...)`.
 * @returns                 a stable `intent-v1:<sha256>` key string.
 */
export function intentCacheKey(redactedSkeleton: string): string {
  const normalised = redactedSkeleton.replace(/\s+/g, " ").trim();
  const digest = createHash("sha256").update(normalised, "utf8").digest("hex");
  return `${INTENT_KEY_PREFIX}:${digest}`;
}
