/**
 * EmbeddingAdapter — real implementation of `EmbeddingPort` behind the provider boundary
 * (E3.4 / #57, ADR-0005 §4.3).
 *
 * Lives in `adapters/llm` (the SINGLE provider boundary), NOT a new `adapters/embedding` package,
 * so it inherits the LLM adapter's governance verbatim:
 *   - config-pinned model (`EMBEDDING_MODEL` env → `modelId`), never a hardcoded id in
 *     `application`/`domain` (ADR-0005 §4.3, mirrors `DEFAULT_MODEL_ID`);
 *   - per-call `AbortController` forwarded to the provider, timeout timer cleared on ALL settle
 *     paths (the #44 abort/leak discipline replicated from `LlmAdapter`);
 *   - provider key env-only, confined to the client passed in at the composition root — NEVER read,
 *     stored, logged, cached, or placed in any result/error here (T4/T5);
 *   - no message bodies / skeleton text / vectors logged (T7);
 *   - NEVER throws — on failure/timeout it returns a DEGRADED empty-vector `EmbeddingResult`, so the
 *     E3 cascade falls back to a11y-only identity (NFR6). This is the resilience contract the port
 *     declares.
 *
 * The concrete provider is injected as an `EmbeddingClientLike` (DI / testability): production wires
 * the real provider embedding client at the root; tests inject a fake — no SDK import is needed in
 * THIS file because the provider SDK (`@anthropic-ai/sdk`) is already confined to `LlmAdapter.ts`,
 * and the embedding client the root constructs is the same provider boundary. The SDK stays isolated
 * to this package (NFR1 — depcruiser enforces). No `@anthropic-ai/sdk` import is added outside the
 * existing one in `LlmAdapter.ts`.
 */
import type { EmbeddingInput, EmbeddingResult, EmbeddingPort } from "@flowscout/domain";

/** Configuration for the EmbeddingAdapter (injected at the composition root). */
export interface EmbeddingAdapterConfig {
  /**
   * Embedding model id — config-pinned (ADR-0005 §4.3); defaults to the `EMBEDDING_MODEL` env var
   * resolved at the root, or the adapter's documented default. Never a constant in app/domain.
   */
  readonly modelId?: string;
  /**
   * Per-call timeout in milliseconds (T3 — embedding calls must be time-bounded).
   * Default: 30_000ms, matching `LlmAdapter`'s discipline.
   */
  readonly timeoutMs?: number;
}

/** Default embedding model id — config-pinned per ADR-0005 §4.3 (overridable at the root). */
export const DEFAULT_EMBEDDING_MODEL_ID = "voyage-3";

/** Default per-call timeout in milliseconds (mirrors `LlmAdapter`). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Request options forwarded to the embedding client (abort discipline, #44). */
export interface EmbeddingRequestOptions {
  /** AbortSignal forwarded to the underlying HTTP layer (T3/#44). */
  readonly signal?: AbortSignal;
}

/**
 * Provider embedding client — injected for testability (DI), the same pattern as
 * `AnthropicClientLike`. The composition root supplies the real provider client; tests supply a
 * fake. This adapter never constructs the client and never touches the API key (T5).
 */
export interface EmbeddingClientLike {
  embeddings: {
    create(
      params: { model: string; input: string },
      options?: EmbeddingRequestOptions,
    ): Promise<{
      data: ReadonlyArray<{ embedding: readonly number[] }>;
      model: string;
      usage?: { input_tokens?: number };
    }>;
  };
}

/**
 * EmbeddingAdapter — implements `EmbeddingPort` over an injected provider embedding client.
 *
 * SECURITY / RESILIENCE INVARIANTS (all tested):
 *   1. API key is NEVER read/stored/logged/returned here (it lives in the injected client) (T5).
 *   2. Only the already-redacted `skeletonText` is sent; no vector/skeleton is logged (T1/T7).
 *   3. Each call is time-bounded by `timeoutMs`; on timeout the in-flight request is aborted (#44).
 *   4. The timeout timer is cleared on ALL settle paths — no timer leaks (#44).
 *   5. NEVER throws — failure/timeout/malformed ⇒ DEGRADED empty-vector result (NFR6).
 *   6. No `eval`/`new Function` anywhere (T2 / SAST).
 */
export class EmbeddingAdapter implements EmbeddingPort {
  private readonly _client: EmbeddingClientLike;
  private readonly _modelId: string;
  private readonly _timeoutMs: number;

  constructor(client: EmbeddingClientLike, config: EmbeddingAdapterConfig = {}) {
    this._client = client;
    this._modelId = config.modelId ?? DEFAULT_EMBEDDING_MODEL_ID;
    this._timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Compute a screen embedding for the redacted skeleton. Never throws — returns a degraded
   * empty-vector `EmbeddingResult` on any failure/timeout (the caller falls back to a11y-only).
   */
  async embed(input: EmbeddingInput): Promise<EmbeddingResult> {
    // Per-call AbortController forwarded to the client so a hung call is cancelled (#44 fix 1).
    const controller = new AbortController();

    // Time-bound setup; handle stored so clearTimeout runs on every settle path (#44 fix 2).
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new Error("Embedding call timed out"));
      }, this._timeoutMs);
    });

    try {
      const response = await Promise.race([
        this._client.embeddings.create(
          { model: this._modelId, input: input.skeletonText },
          { signal: controller.signal },
        ),
        timeoutPromise,
      ]);

      const vector = response.data[0]?.embedding;
      if (vector === undefined || vector.length === 0) {
        // Malformed/empty provider response ⇒ degrade (a11y-only fallback), never throw.
        return this._degraded();
      }

      return {
        vector,
        modelId: response.model,
        promptTokens: response.usage?.input_tokens ?? 0,
      };
    } catch {
      // Timeout / network / abort / unexpected ⇒ DEGRADED (NFR6). No error detail leaked.
      return this._degraded();
    } finally {
      // Clear the timer on ALL settle paths — no leaks (#44 fix 2).
      clearTimeout(timeoutHandle);
    }
  }

  /** The degraded result: an empty vector signals a11y-only fallback to the caller. */
  private _degraded(): EmbeddingResult {
    return { vector: [], modelId: this._modelId, promptTokens: 0 };
  }
}
