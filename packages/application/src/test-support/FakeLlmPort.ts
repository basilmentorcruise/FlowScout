/**
 * FakeLlmPort — a deterministic, scripted `LlmPort` test double (#55).
 *
 * No SDK, no network, no randomness. Used by the intent-inference suites to drive the
 * tier-2 refinement path without touching `adapters/llm`. Records every call so tests can
 * assert the budget/cache invariants (call count, prompt contents for redaction checks).
 *
 * Behaviours per scripted response:
 *   - `{ content }`      → resolves with the given content + token counts.
 *   - `{ throws }`       → rejects (simulates timeout / network / abort failure).
 * When the script is exhausted, a configurable default response is returned.
 *
 * Test-support only — never imported by production code (no index re-export from the
 * application barrel).
 */
import type {
  LlmMessage,
  LlmCompletionOptions,
  LlmCompletionResult,
  LlmPort,
} from "@flowscout/domain";

/** One scripted outcome for a single `complete(...)` call. */
export type FakeLlmResponse =
  | {
      readonly kind: "ok";
      readonly content: string;
      readonly promptTokens?: number;
      readonly completionTokens?: number;
      readonly modelId?: string;
    }
  | { readonly kind: "throws"; readonly error?: Error };

/** A captured invocation (for assertions — e.g. that no secret reached the prompt). */
export interface FakeLlmCall {
  readonly messages: readonly LlmMessage[];
  readonly options: LlmCompletionOptions;
}

const DEFAULT_MODEL_ID = "fake-model";
const DEFAULT_PROMPT_TOKENS = 100;
const DEFAULT_COMPLETION_TOKENS = 20;

export class FakeLlmPort implements LlmPort {
  private readonly _calls: FakeLlmCall[] = [];
  private readonly _script: FakeLlmResponse[];
  private _scriptIndex = 0;

  /**
   * @param script           ordered responses; consumed one per `complete(...)` call.
   * @param defaultResponse  returned once the script is exhausted (defaults to a no-op "ok").
   */
  constructor(
    script: readonly FakeLlmResponse[] = [],
    private readonly defaultResponse: FakeLlmResponse = { kind: "ok", content: "{}" },
  ) {
    this._script = [...script];
  }

  /** All recorded calls, in order. */
  get calls(): readonly FakeLlmCall[] {
    return this._calls;
  }

  /** Number of times `complete(...)` was invoked. */
  get callCount(): number {
    return this._calls.length;
  }

  /** The concatenated content of every message in every recorded call (for leak assertions). */
  get allPromptText(): string {
    return this._calls.flatMap((call) => call.messages.map((m) => m.content)).join("\n");
  }

  complete(
    messages: readonly LlmMessage[],
    options: LlmCompletionOptions,
  ): Promise<LlmCompletionResult> {
    this._calls.push({ messages, options });

    const response =
      this._scriptIndex < this._script.length
        ? (this._script[this._scriptIndex++] ?? this.defaultResponse)
        : this.defaultResponse;

    if (response.kind === "throws") {
      return Promise.reject(response.error ?? new Error("FakeLlmPort: scripted failure"));
    }

    return Promise.resolve({
      content: response.content,
      promptTokens: response.promptTokens ?? DEFAULT_PROMPT_TOKENS,
      completionTokens: response.completionTokens ?? DEFAULT_COMPLETION_TOKENS,
      modelId: response.modelId ?? DEFAULT_MODEL_ID,
    });
  }
}
