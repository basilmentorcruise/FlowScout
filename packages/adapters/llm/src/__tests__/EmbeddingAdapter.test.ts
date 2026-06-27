/**
 * EmbeddingAdapter tests (E3.4 / #57) — verify the resilience + abort discipline contract of the
 * real `EmbeddingPort` implementation:
 *   - happy path returns the provider vector / model / tokens;
 *   - malformed / empty provider responses DEGRADE to an empty vector (never throw);
 *   - thrown provider errors DEGRADE (NFR6);
 *   - timeout aborts the in-flight call and DEGRADES;
 *   - the timeout timer is cleared on every settle path (no leaks, #44);
 *   - config-pinned model id is forwarded; the default is used when unset;
 *   - the API key is never touched here (the adapter only sees the injected client).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { EmbeddingInput } from "@flowscout/domain";
import {
  EmbeddingAdapter,
  DEFAULT_EMBEDDING_MODEL_ID,
  type EmbeddingClientLike,
  type EmbeddingRequestOptions,
} from "../EmbeddingAdapter.js";

const INPUT: EmbeddingInput = {
  skeletonText: "Login screen with email and password fields",
  cacheKey: "bucket-1" as EmbeddingInput["cacheKey"],
};

/** A controllable fake provider embedding client (DI seam — no SDK, no API key). */
function fakeClient(
  impl: (
    params: { model: string; input: string },
    options?: EmbeddingRequestOptions,
  ) => Promise<{
    data: ReadonlyArray<{ embedding: readonly number[] }>;
    model: string;
    usage?: { input_tokens?: number };
  }>,
): { client: EmbeddingClientLike; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(impl);
  return { client: { embeddings: { create } }, create };
}

describe("EmbeddingAdapter", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns the provider vector, model, and token count on success", async () => {
    const { client, create } = fakeClient(async () => ({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
      model: "provider-model-x",
      usage: { input_tokens: 7 },
    }));
    const adapter = new EmbeddingAdapter(client, { modelId: "pinned-model" });

    const result = await adapter.embed(INPUT);

    expect(result.vector).toEqual([0.1, 0.2, 0.3]);
    expect(result.modelId).toBe("provider-model-x");
    expect(result.promptTokens).toBe(7);
    // config-pinned model id is forwarded to the provider, not a hardcoded constant.
    expect(create).toHaveBeenCalledWith(
      { model: "pinned-model", input: INPUT.skeletonText },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("forwards the documented default model id when none is configured", async () => {
    const { client, create } = fakeClient(async () => ({
      data: [{ embedding: [1] }],
      model: DEFAULT_EMBEDDING_MODEL_ID,
    }));
    const adapter = new EmbeddingAdapter(client);

    const result = await adapter.embed(INPUT);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: DEFAULT_EMBEDDING_MODEL_ID }),
      expect.anything(),
    );
    expect(result.promptTokens).toBe(0); // usage absent ⇒ 0
  });

  it("DEGRADES to an empty vector when the provider returns no data", async () => {
    const { client } = fakeClient(async () => ({ data: [], model: "m" }));
    const adapter = new EmbeddingAdapter(client);

    const result = await adapter.embed(INPUT);

    expect(result.vector).toEqual([]);
    expect(result.modelId).toBe(DEFAULT_EMBEDDING_MODEL_ID);
    expect(result.promptTokens).toBe(0);
  });

  it("DEGRADES when the provider returns an empty embedding vector", async () => {
    const { client } = fakeClient(async () => ({
      data: [{ embedding: [] }],
      model: "m",
    }));
    const adapter = new EmbeddingAdapter(client);

    const result = await adapter.embed(INPUT);

    expect(result.vector).toEqual([]);
  });

  it("DEGRADES (never throws) when the provider call rejects", async () => {
    const { client } = fakeClient(async () => {
      throw new Error("network down");
    });
    const adapter = new EmbeddingAdapter(client);

    const result = await adapter.embed(INPUT);

    expect(result.vector).toEqual([]);
    expect(result.modelId).toBe(DEFAULT_EMBEDDING_MODEL_ID);
  });

  it("aborts the in-flight call and DEGRADES on timeout", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const { client } = fakeClient(
      (_params, options) =>
        new Promise((resolve) => {
          capturedSignal = options?.signal;
          // Never resolves on its own — only the adapter's timeout can settle this.
          void resolve;
        }),
    );
    const adapter = new EmbeddingAdapter(client, { timeoutMs: 1000 });

    const promise = adapter.embed(INPUT);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.vector).toEqual([]);
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("clears the timeout timer on the success path (no leak)", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const { client } = fakeClient(async () => ({
      data: [{ embedding: [0.5] }],
      model: "m",
      usage: { input_tokens: 1 },
    }));
    const adapter = new EmbeddingAdapter(client);

    await adapter.embed(INPUT);

    expect(clearSpy).toHaveBeenCalled();
  });
});
