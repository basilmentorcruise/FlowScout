/**
 * LlmAdapter unit tests.
 *
 * Uses a FAKE Anthropic client — NO real API calls are made.
 * Covers:
 *   - Successful completion: returns content + token counts + modelId
 *   - Timeout / failure: throws on client failure (T11 safe fallback path)
 *   - System message separation (P/T1)
 *   - API key is NEVER in the result (T5)
 *   - Token usage is truthfully reported (T6)
 *   - AbortController: signal passed to SDK; abort() called on timeout (#44)
 *   - clearTimeout: timer cleared on success AND error paths (no leak) (#44)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LlmAdapter, DEFAULT_MODEL_ID } from "../LlmAdapter.js";
import type { AnthropicClientLike } from "../LlmAdapter.js";
import type { LlmMessage, LlmCompletionOptions } from "@flowscout/domain";

// ── Test constants ────────────────────────────────────────────────────────────

const FAKE_PROMPT_TOKENS = 150;
const FAKE_COMPLETION_TOKENS = 20;
const CUSTOM_PROMPT_TOKENS = 300;
const TEST_MAX_TOKENS = 512;

// ── Fake response type ────────────────────────────────────────────────────────

type FakeResponse = {
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
};

const STANDARD_RESPONSE: FakeResponse = {
  content: [{ type: "text", text: '{"choice":"backtrack","reason":"test"}' }],
  usage: { input_tokens: FAKE_PROMPT_TOKENS, output_tokens: FAKE_COMPLETION_TOKENS },
  model: "claude-opus-4-8",
};

const STANDARD_OPTIONS: LlmCompletionOptions = {
  maxTokens: 256,
  temperature: 0.2,
};

const MESSAGES: LlmMessage[] = [
  { role: "system", content: "You are a test agent." },
  { role: "user", content: "Select an action." },
];

// Captured call data stored externally to avoid unbound-method lint issues
type CapturedCall = Parameters<AnthropicClientLike["messages"]["create"]>[0];
type CapturedOptions = Parameters<AnthropicClientLike["messages"]["create"]>[1];

function makeClientWithSpy(response: FakeResponse): {
  client: AnthropicClientLike;
  getCalls: () => CapturedCall[];
  getOptions: () => CapturedOptions[];
} {
  const calls: CapturedCall[] = [];
  const options: CapturedOptions[] = [];
  const createFn = vi.fn((params: CapturedCall, opts?: CapturedOptions) => {
    calls.push(params);
    options.push(opts);
    return Promise.resolve(response);
  });
  const client: AnthropicClientLike = {
    messages: { create: createFn },
  };
  return { client, getCalls: () => calls, getOptions: () => options };
}

function makeFailingClient(errorMessage: string): AnthropicClientLike {
  return {
    messages: {
      create: vi.fn().mockRejectedValue(new Error(errorMessage)),
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("LlmAdapter — content extraction", () => {
  it("returns the text content from the first text block", async () => {
    const { client } = makeClientWithSpy(STANDARD_RESPONSE);
    const adapter = new LlmAdapter(client);
    const result = await adapter.complete(MESSAGES, STANDARD_OPTIONS);
    expect(result.content).toBe('{"choice":"backtrack","reason":"test"}');
  });

  it("returns empty string when response has no text block", async () => {
    const noTextResponse: FakeResponse = {
      content: [{ type: "tool_use" }],
      usage: { input_tokens: FAKE_PROMPT_TOKENS, output_tokens: 0 },
      model: "claude-opus-4-8",
    };
    const { client } = makeClientWithSpy(noTextResponse);
    const adapter = new LlmAdapter(client);
    const result = await adapter.complete(MESSAGES, STANDARD_OPTIONS);
    expect(result.content).toBe("");
  });
});

describe("LlmAdapter — token counting (T6)", () => {
  it("returns prompt and completion token counts truthfully", async () => {
    const { client } = makeClientWithSpy(STANDARD_RESPONSE);
    const adapter = new LlmAdapter(client);
    const result = await adapter.complete(MESSAGES, STANDARD_OPTIONS);
    expect(result.promptTokens).toBe(FAKE_PROMPT_TOKENS);
    expect(result.completionTokens).toBe(FAKE_COMPLETION_TOKENS);
  });

  it("returns the modelId from the response", async () => {
    const { client } = makeClientWithSpy(STANDARD_RESPONSE);
    const adapter = new LlmAdapter(client);
    const result = await adapter.complete(MESSAGES, STANDARD_OPTIONS);
    expect(result.modelId).toBe("claude-opus-4-8");
  });

  it("passes custom prompt token count through", async () => {
    const customResponse: FakeResponse = {
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: CUSTOM_PROMPT_TOKENS, output_tokens: FAKE_COMPLETION_TOKENS },
      model: "claude-opus-4-8",
    };
    const { client } = makeClientWithSpy(customResponse);
    const adapter = new LlmAdapter(client);
    const result = await adapter.complete(MESSAGES, STANDARD_OPTIONS);
    expect(result.promptTokens).toBe(CUSTOM_PROMPT_TOKENS);
  });
});

describe("LlmAdapter — model configuration", () => {
  it("uses the config-pinned model id by default", async () => {
    const { client, getCalls } = makeClientWithSpy(STANDARD_RESPONSE);
    const adapter = new LlmAdapter(client);
    await adapter.complete(MESSAGES, STANDARD_OPTIONS);
    expect(getCalls()[0]?.model).toBe(DEFAULT_MODEL_ID);
  });

  it("uses a custom modelId when provided in config", async () => {
    const { client, getCalls } = makeClientWithSpy(STANDARD_RESPONSE);
    const adapter = new LlmAdapter(client, { modelId: "claude-haiku-4-5" });
    await adapter.complete(MESSAGES, STANDARD_OPTIONS);
    expect(getCalls()[0]?.model).toBe("claude-haiku-4-5");
  });

  it("passes maxTokens from options to the request", async () => {
    const { client, getCalls } = makeClientWithSpy(STANDARD_RESPONSE);
    const adapter = new LlmAdapter(client);
    await adapter.complete(MESSAGES, { maxTokens: TEST_MAX_TOKENS });
    expect(getCalls()[0]?.max_tokens).toBe(TEST_MAX_TOKENS);
  });
});

describe("LlmAdapter — message splitting (P/T1)", () => {
  it("separates system message from user messages", async () => {
    const { client, getCalls } = makeClientWithSpy(STANDARD_RESPONSE);
    const adapter = new LlmAdapter(client);
    await adapter.complete(MESSAGES, STANDARD_OPTIONS);
    const call = getCalls()[0];
    expect(call?.system).toBe("You are a test agent.");
    expect(call?.messages).toHaveLength(1);
    expect(call?.messages[0]).toEqual({ role: "user", content: "Select an action." });
  });

  it("handles no system message — system key absent from request", async () => {
    const { client, getCalls } = makeClientWithSpy(STANDARD_RESPONSE);
    const adapter = new LlmAdapter(client);
    const userOnlyMessages: LlmMessage[] = [{ role: "user", content: "Hello" }];
    await adapter.complete(userOnlyMessages, STANDARD_OPTIONS);
    const call = getCalls()[0];
    expect(call?.system).toBeUndefined();
    expect(call?.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("joins multiple system messages with a newline", async () => {
    const { client, getCalls } = makeClientWithSpy(STANDARD_RESPONSE);
    const adapter = new LlmAdapter(client);
    const multiMsg: LlmMessage[] = [
      { role: "system", content: "Part 1" },
      { role: "system", content: "Part 2" },
      { role: "user", content: "Question" },
    ];
    await adapter.complete(multiMsg, STANDARD_OPTIONS);
    expect(getCalls()[0]?.system).toBe("Part 1\nPart 2");
  });
});

describe("LlmAdapter — failure handling (T11)", () => {
  it("propagates rejection from underlying client (simulating timeout/network error)", async () => {
    const failingClient = makeFailingClient("LLM call timed out");
    const adapter = new LlmAdapter(failingClient);
    await expect(adapter.complete(MESSAGES, STANDARD_OPTIONS)).rejects.toThrow(
      "LLM call timed out",
    );
  });
});

describe("LlmAdapter — API key isolation (T5)", () => {
  it("LlmCompletionResult does not contain API key patterns", async () => {
    const { client } = makeClientWithSpy(STANDARD_RESPONSE);
    const adapter = new LlmAdapter(client);
    const result = await adapter.complete(MESSAGES, STANDARD_OPTIONS);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk-ant");
    expect(serialized).not.toContain("LLM_API_KEY");
    expect(serialized).not.toContain("apiKey");
  });
});

// ── AbortController / timer-leak fixes (#44) ──────────────────────────────────

describe("LlmAdapter — AbortController: signal passed to SDK (#44)", () => {
  it("passes an AbortSignal to the SDK create() call on success path", async () => {
    const { client, getOptions } = makeClientWithSpy(STANDARD_RESPONSE);
    const adapter = new LlmAdapter(client);
    await adapter.complete(MESSAGES, STANDARD_OPTIONS);
    const opts = getOptions()[0];
    expect(opts).toBeDefined();
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });

  it("the signal is NOT aborted when the SDK call succeeds", async () => {
    const { client, getOptions } = makeClientWithSpy(STANDARD_RESPONSE);
    const adapter = new LlmAdapter(client);
    await adapter.complete(MESSAGES, STANDARD_OPTIONS);
    const signal = getOptions()[0]?.signal;
    expect(signal?.aborted).toBe(false);
  });
});

describe("LlmAdapter — AbortController: abort() called on timeout (#44)", () => {
  it("aborts the in-flight SDK request when the timeout fires before the SDK responds", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;

    // SDK call that never resolves — simulates a hung request
    const hangingClient: AnthropicClientLike = {
      messages: {
        create: vi.fn((_params: CapturedCall, opts?: CapturedOptions) => {
          capturedSignal = opts?.signal ?? undefined;
          return new Promise<never>(() => {
            /* never resolves */
          });
        }),
      },
    };

    const SHORT_TIMEOUT_MS = 100;
    const adapter = new LlmAdapter(hangingClient, { timeoutMs: SHORT_TIMEOUT_MS });
    const completePromise = adapter.complete(MESSAGES, STANDARD_OPTIONS);

    // Advance past the timeout
    vi.advanceTimersByTime(SHORT_TIMEOUT_MS + 1);

    await expect(completePromise).rejects.toThrow("LLM call timed out");
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(true);

    vi.useRealTimers();
  });
});

describe("LlmAdapter — clearTimeout: no timer leak on success path (#44)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears the timeout timer when the SDK call resolves before the timeout", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const { client } = makeClientWithSpy(STANDARD_RESPONSE);
    const adapter = new LlmAdapter(client);

    await adapter.complete(MESSAGES, STANDARD_OPTIONS);

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    clearTimeoutSpy.mockRestore();
  });

  it("clears the timeout timer when the SDK call rejects before the timeout", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const failingClient = makeFailingClient("SDK network error");
    const adapter = new LlmAdapter(failingClient);

    await expect(adapter.complete(MESSAGES, STANDARD_OPTIONS)).rejects.toThrow(
      "SDK network error",
    );

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    clearTimeoutSpy.mockRestore();
  });
});
