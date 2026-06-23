/**
 * LlmAdapter — real implementation of LlmPort over @anthropic-ai/sdk.
 *
 * Security controls (E2 threat model §36 MUSTs):
 *   - LLM_API_KEY is env-only, confined to this adapter, NEVER logged, cached,
 *     emitted in events, or placed in error messages (T5).
 *   - The API key is never exposed in any LlmCompletionResult or error thrown.
 *   - No message bodies are logged (T7).
 *   - LLM calls are time-bounded (T11).
 *
 * Provider SDK exact-pinned to @anthropic-ai/sdk@0.105.0 (ADR-0004 §3.1, T9).
 * SDK import is confined to this file and this package (T10/NFR1).
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  LlmPort,
  LlmMessage,
  LlmCompletionOptions,
  LlmCompletionResult,
} from "@flowscout/domain";

/** Configuration for the LlmAdapter (injected at the composition root #37). */
export interface LlmAdapterConfig {
  /**
   * Model ID to use. Config-pinned; defaults to LLM_MODEL env var or the
   * production default (claude-opus-4-8). Per ADR-0004 §3.1: config, not a constant.
   */
  readonly modelId?: string;
  /**
   * Timeout in milliseconds for each LLM call (T11 — LLM calls must be time-bounded).
   * Default: 30_000ms (30 seconds).
   */
  readonly timeoutMs?: number;
}

/** Default model ID — config-pinned per ADR-0004 §3.1. */
export const DEFAULT_MODEL_ID = "claude-opus-4-8";

/** Default per-call timeout in milliseconds (T11). */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Anthropic SDK client interface — injected for testability (DI).
 * Tests inject a FakeAnthropicClient; production uses the real Anthropic client.
 * This allows unit tests to cover all code paths WITHOUT making real API calls.
 */
export interface AnthropicClientLike {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      temperature?: number;
      system?: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    }): Promise<{
      content: Array<{ type: string; text?: string }>;
      usage: {
        input_tokens: number;
        output_tokens: number;
      };
      model: string;
    }>;
  };
}

/**
 * LlmAdapter — implements LlmPort over the Anthropic SDK.
 *
 * SECURITY INVARIANTS (all tested):
 *   1. API key is NEVER in any result, log, error message, or closure.
 *   2. Message bodies are NEVER logged (only token counts and model id).
 *   3. Each call is time-bounded by `timeoutMs` (T11 safe fallback on timeout).
 *   4. No `eval`/`new Function` anywhere in this file (T2 / SAST).
 */
export class LlmAdapter implements LlmPort {
  private readonly _client: AnthropicClientLike;
  private readonly _modelId: string;
  private readonly _timeoutMs: number;

  /**
   * @param client   Injected Anthropic-compatible client (real or fake for tests).
   * @param config   Adapter configuration (model, timeout).
   *
   * NOTE: The API key is passed to the Anthropic constructor at the COMPOSITION ROOT
   * (#37), not here. This adapter receives an already-constructed client — it never
   * reads or stores the API key (T5).
   */
  constructor(client: AnthropicClientLike, config: LlmAdapterConfig = {}) {
    this._client = client;
    this._modelId = config.modelId ?? DEFAULT_MODEL_ID;
    this._timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Calls the LLM with the given messages and returns the completion.
   * Time-bounded by `timeoutMs` — throws on timeout (caller falls back safely, T11).
   *
   * SECURITY:
   *   - API key is NEVER touched here (it lives in the Anthropic client instance).
   *   - No message bodies are logged (only metadata in thrown errors).
   *   - No `eval`/`new Function` on response content.
   */
  async complete(
    messages: readonly LlmMessage[],
    options: LlmCompletionOptions,
  ): Promise<LlmCompletionResult> {
    const { system, userMessages } = splitMessages(messages);

    // Build params — omit optional fields when undefined (exactOptionalPropertyTypes)
    const requestParams: Parameters<AnthropicClientLike["messages"]["create"]>[0] = {
      model: this._modelId,
      max_tokens: options.maxTokens,
      messages: userMessages,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(system !== undefined ? { system } : {}),
    };

    // Time-bound the LLM call (T11 — a hung call falls back safely and counts toward budget)
    const result = await Promise.race([
      this._client.messages.create(requestParams),
      rejectAfterMs(this._timeoutMs, "LLM call timed out"),
    ]);

    // Extract text content — strict extraction, no eval (T2)
    const content = extractTextContent(result.content);

    return {
      content,
      promptTokens: result.usage.input_tokens,
      completionTokens: result.usage.output_tokens,
      modelId: result.model,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Splits LlmMessage[] into a system string and user/assistant messages.
 * The Anthropic API accepts a separate `system` param and a `messages` array
 * of user/assistant turns.
 */
function splitMessages(messages: readonly LlmMessage[]): {
  system: string | undefined;
  userMessages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const systemParts: string[] = [];
  const userMessages: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
    } else {
      userMessages.push({ role: msg.role, content: msg.content });
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n") : undefined,
    userMessages,
  };
}

/**
 * Extracts the text from the first text block in the response content.
 * Returns an empty string if no text block is found.
 * Never uses eval or dynamic code execution (T2).
 */
function extractTextContent(content: Array<{ type: string; text?: string }>): string {
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return "";
}

/**
 * Returns a promise that rejects after the given milliseconds.
 * Used to bound LLM calls (T11).
 */
function rejectAfterMs(ms: number, message: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(message));
    }, ms);
  });
}

/**
 * Factory: create a real Anthropic client from env.
 * The API key is read here and passed to the SDK — never stored, never logged.
 * Called ONLY at the composition root (#37).
 *
 * Security (T5): the key is env-only; this function is the single point where
 * the env is read. The returned client object holds it internally (SDK manages it).
 */
export function createAnthropicClient(apiKey?: string): AnthropicClientLike {
  const key = apiKey ?? process.env["LLM_API_KEY"];
  if (!key) {
    throw new Error(
      "LLM_API_KEY env var is required for the LLM adapter (set it in your .env file)",
    );
  }
  // The Anthropic SDK holds the key internally — we never log it or attach it to anything.
  return new Anthropic({ apiKey: key });
}
