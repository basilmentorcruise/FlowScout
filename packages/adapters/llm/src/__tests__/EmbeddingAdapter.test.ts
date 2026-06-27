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
} from "../EmbeddingAdapter.js";

const INPUT: EmbeddingInput = {
  skeletonText: "Login screen with email and password fields",
  cacheKey: "bucket-1" as EmbeddingInput["cacheKey"],
};

// Captured call data stored externally to avoid unbound-method lint issues.
type ProviderResponse = Awaited<ReturnType<EmbeddingClientLike["embeddings"]["create"]>>;
type CreateParams = Parameters<EmbeddingClientLike["embeddings"]["create"]>[0];
type CreateOptions = Parameters<EmbeddingClientLike["embeddings"]["create"]>[1];

/** A fake provider embedding client (DI seam — no SDK, no API key). */
function makeClient(
  impl: (params: CreateParams, options?: CreateOptions) => Promise<ProviderResponse>,
): {
  client: EmbeddingClientLike;
  getCalls: () => CreateParams[];
  getOptions: () => CreateOptions[];
} {
  const calls: CreateParams[] = [];
  const options: CreateOptions[] = [];
  const create = vi.fn((params: CreateParams, opts?: CreateOptions) => {
    calls.push(params);
    options.push(opts);
    return impl(params, opts);
  });
  return {
    client: { embeddings: { create } },
    getCalls: () => calls,
    getOptions: () => options,
  };
}

/** Convenience: a client that resolves the given response. */
function resolving(response: ProviderResponse): ReturnType<typeof makeClient> {
  return makeClient(() => Promise.resolve(response));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("EmbeddingAdapter — happy path", () => {
  it("returns the provider vector, model, and token count on success", async () => {
    const { client, getCalls, getOptions } = resolving({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
      model: "provider-model-x",
      usage: { input_tokens: 7 },
    });
    const adapter = new EmbeddingAdapter(client, { modelId: "pinned-model" });

    const result = await adapter.embed(INPUT);

    expect(result.vector).toEqual([0.1, 0.2, 0.3]);
    expect(result.modelId).toBe("provider-model-x");
    expect(result.promptTokens).toBe(7);
    // config-pinned model id is forwarded to the provider, not a hardcoded constant.
    expect(getCalls()[0]).toEqual({ model: "pinned-model", input: INPUT.skeletonText });
    // a per-call AbortSignal is forwarded to the provider (#44 abort discipline).
    expect(getOptions()[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("forwards the documented default model id when none is configured", async () => {
    const { client, getCalls } = resolving({
      data: [{ embedding: [1] }],
      model: DEFAULT_EMBEDDING_MODEL_ID,
    });
    const adapter = new EmbeddingAdapter(client);

    const result = await adapter.embed(INPUT);

    expect(getCalls()[0]?.model).toBe(DEFAULT_EMBEDDING_MODEL_ID);
    expect(result.promptTokens).toBe(0); // usage absent ⇒ 0
  });
});

describe("EmbeddingAdapter — degraded paths (never throws, NFR6)", () => {
  it("DEGRADES to an empty vector when the provider returns no data", async () => {
    const { client } = resolving({ data: [], model: "m" });
    const adapter = new EmbeddingAdapter(client);

    const result = await adapter.embed(INPUT);

    expect(result.vector).toEqual([]);
    expect(result.modelId).toBe(DEFAULT_EMBEDDING_MODEL_ID);
    expect(result.promptTokens).toBe(0);
  });

  it("DEGRADES when the provider returns an empty embedding vector", async () => {
    const { client } = resolving({ data: [{ embedding: [] }], model: "m" });
    const adapter = new EmbeddingAdapter(client);

    const result = await adapter.embed(INPUT);

    expect(result.vector).toEqual([]);
  });

  it("DEGRADES (never throws) when the provider call rejects", async () => {
    const { client } = makeClient(() => Promise.reject(new Error("network down")));
    const adapter = new EmbeddingAdapter(client);

    const result = await adapter.embed(INPUT);

    expect(result.vector).toEqual([]);
    expect(result.modelId).toBe(DEFAULT_EMBEDDING_MODEL_ID);
  });
});

describe("EmbeddingAdapter — abort + timer discipline (#44)", () => {
  it("aborts the in-flight call and DEGRADES on timeout", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const { client } = makeClient(
      (_params, options) =>
        new Promise<ProviderResponse>(() => {
          // Never resolves on its own — only the adapter's timeout can settle this.
          capturedSignal = options?.signal;
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
    const { client } = resolving({
      data: [{ embedding: [0.5] }],
      model: "m",
      usage: { input_tokens: 1 },
    });
    const adapter = new EmbeddingAdapter(client);

    await adapter.embed(INPUT);

    expect(clearSpy).toHaveBeenCalled();
  });
});
