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
 */
import { describe, it, expect, vi } from "vitest";
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

function makeClientWithSpy(response: FakeResponse): {
  client: AnthropicClientLike;
  getCalls: () => CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const createFn = vi.fn((params: CapturedCall) => {
    calls.push(params);
    return Promise.resolve(response);
  });
  const client: AnthropicClientLike = {
    messages: { create: createFn },
  };
  return { client, getCalls: () => calls };
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
    await expect(adapter.complete(MESSAGES, STANDARD_OPTIONS)).rejects.toThrow("LLM call timed out");
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
