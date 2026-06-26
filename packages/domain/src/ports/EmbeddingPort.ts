/**
 * EmbeddingPort — the async port for producing a screen-embedding vector (E3.4 / #57).
 *
 * Per ADR-0005 §4.2: this is a NEW additive domain port, deliberately distinct from the
 * SYNCHRONOUS `StateIdentityStrategy` — because an embedding is fetched from a provider and is
 * therefore async. The embedding is computed POST-HOC (ADR-0005 §4.4), outside `identify`, so the
 * synchronous `identify` contract is preserved unchanged.
 *
 * Source (ADR-0005 §4.1): the embedding is produced over the NORMALIZED, ALREADY-REDACTED a11y
 * skeleton text (the projection `A11ySignatureStrategy` builds) — NOT the screenshot. Vision is
 * reserved behind the optional `screenshotUri` field + a `useVisionEmbedding` root flag (Open/Closed)
 * and is not used by the MVP.
 *
 * Resilience (ADR-0005 §4.2, NFR6): `embed` MUST NEVER throw. On failure / timeout / unavailability
 * it returns a DEGRADED `EmbeddingResult` with an EMPTY `vector`, so the cascade falls back to
 * a11y-only identity (never a guessed merge, never a crash). The real adapter (`adapters/llm`) is the
 * only place a provider SDK lives; `application`/`domain` bind to this port only (NFR1).
 *
 * Additive domain port addition — no existing contract broken (flag to the arch-review gate,
 * sanctioned by ADR-0005 §10).
 */
import type { StateIdentity } from "../models/state-graph.js";

/** Input to a single embedding request. */
export interface EmbeddingInput {
  /**
   * The normalized, REDACTED a11y skeleton text (NOT the raw snapshot, NOT a screenshot).
   * Mandatory. Already passed through `CredentialRedactor` upstream (NFR5 / T1).
   */
  readonly skeletonText: string;
  /**
   * Optional screenshot URI — RESERVED for a future vision embedding adapter (default unused).
   * The MVP is text-only; this keeps the port Open/Closed for vision without a contract change.
   */
  readonly screenshotUri?: string;
  /**
   * Stable cache key: the a11y `StateIdentity` of the bucket, so re-encounters of the same
   * bucket reuse the vector (ONE embedding per distinct bucket — ADR-0005 §4.4).
   */
  readonly cacheKey: StateIdentity;
}

/** Result of a single embedding request. */
export interface EmbeddingResult {
  /**
   * The screen embedding vector. An EMPTY array signals a DEGRADED / unavailable embedding —
   * the caller MUST fall back to a11y-only identity (never merge on an empty vector).
   */
  readonly vector: readonly number[];
  /** Provider model id (telemetry / cache invalidation). */
  readonly modelId: string;
  /** Prompt/input tokens consumed by this call (0 on a degraded/failed call). */
  readonly promptTokens: number;
}

/**
 * EmbeddingPort — async screen-embedding production.
 *
 * Contract:
 * - MUST be budget-counted and time-bounded/abortable by the adapter (mirrors `LlmAdapter`'s
 *   per-call `AbortController` + timeout-cleared-on-all-paths discipline, the #44 fix).
 * - MUST NEVER throw — returns an empty-vector `EmbeddingResult` on failure/timeout (NFR6).
 * - The input is the ALREADY-REDACTED skeleton; no raw a11y body / credential / PII ever reaches
 *   the provider, the vector, the cache, or any log (NFR5 / T1).
 */
export interface EmbeddingPort {
  /** Compute a screen embedding for the redacted skeleton. Never throws. */
  embed(input: EmbeddingInput): Promise<EmbeddingResult>;
}
