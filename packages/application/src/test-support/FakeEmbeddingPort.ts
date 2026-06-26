/**
 * FakeEmbeddingPort — a deterministic, no-network `EmbeddingPort` test double (#57, ADR-0005 §3.1).
 *
 * No SDK, no network, no randomness. Two ways to drive it:
 *   1. SCRIPTED vectors keyed by `skeletonText` — the eval scenarios pin exact vectors so the
 *      cross-bucket cosine is controlled (e.g. an at-threshold merge vs. a dead-band pair).
 *   2. SEEDED fallback — when no scripted vector matches, a stable pseudo-vector is derived from a
 *      SHA-256 of the skeleton (deterministic across runs/processes, NFR2). Two identical skeletons
 *      get identical vectors; different skeletons get near-orthogonal ones.
 *
 * It records every call (count + cache keys) so tests can assert the budget/cache invariants:
 *   - one embedding per distinct bucket (cache → no second call for a re-encountered cacheKey),
 *   - budget-exhaustion ⇒ a11y-only (the orchestrator stops calling).
 *
 * A `degradeFor` set forces a DEGRADED empty-vector result for chosen skeletons (NFR6 path).
 *
 * Test-support only — never imported by production code.
 */
import { createHash } from "node:crypto";
import type {
  EmbeddingInput,
  EmbeddingResult,
  EmbeddingPort,
  StateIdentity,
} from "@flowscout/domain";

const FAKE_MODEL_ID = "fake-embedding-model";
const DEFAULT_DIM = 256;
const DEFAULT_PROMPT_TOKENS = 8;

export interface FakeEmbeddingOptions {
  /** Exact vectors keyed by `skeletonText` (the eval scenarios pin these). */
  readonly scripted?: ReadonlyMap<string, readonly number[]>;
  /** Skeletons for which `embed` returns a DEGRADED empty vector (NFR6 path). */
  readonly degradeFor?: ReadonlySet<string>;
  /** Dimensionality of seeded fallback vectors (default 256 = MIN_EMBEDDING_DIM). */
  readonly dim?: number;
}

export class FakeEmbeddingPort implements EmbeddingPort {
  private readonly _calls: EmbeddingInput[] = [];
  private readonly _scripted: ReadonlyMap<string, readonly number[]>;
  private readonly _degradeFor: ReadonlySet<string>;
  private readonly _dim: number;

  constructor(options: FakeEmbeddingOptions = {}) {
    this._scripted = options.scripted ?? new Map();
    this._degradeFor = options.degradeFor ?? new Set();
    this._dim = options.dim ?? DEFAULT_DIM;
  }

  /** Every recorded call, in order. */
  get calls(): readonly EmbeddingInput[] {
    return this._calls;
  }

  /** Number of `embed(...)` invocations. */
  get callCount(): number {
    return this._calls.length;
  }

  /** The cache keys passed in, in order (to assert one-call-per-bucket). */
  get cacheKeys(): readonly StateIdentity[] {
    return this._calls.map((c) => c.cacheKey);
  }

  embed(input: EmbeddingInput): Promise<EmbeddingResult> {
    this._calls.push(input);

    if (this._degradeFor.has(input.skeletonText)) {
      return Promise.resolve({ vector: [], modelId: FAKE_MODEL_ID, promptTokens: 0 });
    }

    const scripted = this._scripted.get(input.skeletonText);
    const vector = scripted ?? this.seededVector(input.skeletonText);

    return Promise.resolve({
      vector,
      modelId: FAKE_MODEL_ID,
      promptTokens: DEFAULT_PROMPT_TOKENS,
    });
  }

  /**
   * Deterministic seeded vector: hash the skeleton, then expand the digest bytes into a
   * `dim`-length vector. Identical skeletons ⇒ identical vectors; different skeletons ⇒
   * different, near-orthogonal vectors. Pure, process-independent.
   */
  private seededVector(skeleton: string): number[] {
    const out = new Array<number>(this._dim).fill(0);
    let digest = createHash("sha256").update(skeleton, "utf8").digest();
    let idx = 0;
    while (idx < this._dim) {
      for (let b = 0; b < digest.length && idx < this._dim; b++, idx++) {
        // Map byte [0,255] → [-1, 1].
        out[idx] = (digest[b] as number) / 127.5 - 1;
      }
      // Re-hash to extend the stream deterministically for dims > 32.
      digest = createHash("sha256").update(digest).digest();
    }
    return out;
  }
}
