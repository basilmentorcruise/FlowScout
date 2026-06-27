/**
 * RefineIdentities — the post-hoc embedding-pass ORCHESTRATOR (#58, ADR-0005 §4.4 / §5).
 *
 * Deferred from #57 (the architect ruling: #58 is its own input-producer). Walks the FINALIZED
 * `StateGraph` — each node IS one distinct a11y bucket (E2 keyed nodes by `A11ySignatureStrategy`
 * identity) — and for each bucket, in DETERMINISTIC sorted order:
 *
 *   1. `cache.get(node.id)` first (one-vector-per-bucket; re-encounters / re-runs reuse — AC4/AC5).
 *   2. On miss, REDACT BEFORE EGRESS (T1/NFR5), the SAME two-pass `CredentialRedactor` discipline
 *      `InferIntent` uses: structural `redact()` → `redactText()`. No inference path reads
 *      pre-redaction text.
 *   3. `projectSkeleton(redactedSnapshot)` → the NORMALIZED skeleton (volatile content suppressed).
 *      Embedding the normalized skeleton — not the raw redacted snapshot — is load-bearing for the
 *      recall-floor merge (two buckets of the same screen normalize to near-identical skeletons →
 *      high cosine → merge).
 *   4. If `budget.canCall()` → `embed({ skeletonText, cacheKey: node.id })`; `budget.recordUsage`
 *      after EVERY attempt (degraded calls count, T3); `cache.set`. An empty/low-dim vector or
 *      budget exhaustion ⇒ this bucket carries NO embedding (a11y-only — never a guessed merge, NFR6).
 *   5. Optional veto-label: when `config.labelsFromIntent` and an outcome `ScreenIntent.source` is
 *      `"llm"` (a confident label), pass its purpose as the bucket's `semanticLabel`.
 *
 * Feeds the UNCHANGED #57 `SamenessRefiner` and returns its `RefinementResult` fields plus the
 * embedding call count (for the budget/cache assertions). `SamenessRefiner` /
 * `CompositeStateIdentityStrategy` are consumed verbatim — #58 supplies inputs and reads outputs;
 * the synchronous `identify` contract is untouched (async work lives here).
 *
 * SOLID/DI: every collaborator is constructor-injected behind an interface/class. Depends only on
 * domain ports + application collaborators — NO adapter/SDK import (NFR1/T8). Root wiring is #59.
 */
import type {
  StateGraph,
  StateNode,
  IntentModel,
  A11ySnapshot,
  StateIdentity,
  EmbeddingPort,
  EmbeddingCachePort,
  SamenessRefiner,
  BucketInput,
  RefinementResult,
  DeadBandNote,
  CanonicalIdentityMap,
} from "@flowscout/domain";
import type { CredentialRedactor } from "../../crawl/redaction/CredentialRedactor.js";
import type { EmbeddingBudgetGuard } from "./EmbeddingBudgetGuard.js";
import type { RefineIdentitiesConfig } from "./RefineIdentitiesConfig.js";

/** The result of the post-hoc refinement pass (feeds the detector + #59). */
export interface RefineIdentitiesResult {
  /** Maps every input a11y signature to its class's canonical identity (= `canonicalBySignature`). */
  readonly canonicalMap: CanonicalIdentityMap;
  /** The equivalence classes: canonical id → member signatures (sorted, deterministic). */
  readonly classes: ReadonlyMap<StateIdentity, readonly StateIdentity[]>;
  /** Dead-band telemetry from the refiner (never acted on — tuning only). */
  readonly deadBandNotes: readonly DeadBandNote[];
  /** Number of `EmbeddingPort.embed` calls made (for the budget/cache assertions). */
  readonly embeddingCallCount: number;
}

/** Projects a redacted snapshot string to its normalized skeleton (default = domain projection). */
export type SkeletonProjector = (redactedSnapshot: string) => string;

export class RefineIdentities {
  constructor(
    private readonly embeddings: EmbeddingPort,
    private readonly cache: EmbeddingCachePort,
    private readonly redactor: CredentialRedactor,
    private readonly budget: EmbeddingBudgetGuard,
    private readonly refiner: SamenessRefiner,
    private readonly projectSkeleton: SkeletonProjector,
    private readonly config: RefineIdentitiesConfig,
  ) {}

  /**
   * Run the post-hoc embedding pass over a finalized graph and produce the refined identity classes.
   *
   * @param graph   a finalized state-graph (read-only; never mutated).
   * @param intent  optional intent overlay (#55) — supplies confident veto labels.
   * @returns       the canonical-id map + classes + dead-band telemetry + embedding call count.
   */
  async execute(graph: StateGraph, intent?: IntentModel): Promise<RefineIdentitiesResult> {
    // Distinct buckets = graph node keys. Iterate sorted by StateIdentity (determinism, independent
    // of graph build order — AC10).
    const nodes = [...graph.nodes.values()].sort((a, b) =>
      (a.id as string) < (b.id as string) ? -1 : 1,
    );

    const labelByState = this.buildLabelMap(intent);

    let embeddingCallCount = 0;
    const buckets: BucketInput[] = [];

    for (const node of nodes) {
      const signature = node.id;

      // One embedding per distinct bucket: cache first (AC4/AC5).
      let vector = await this.cache.get(signature);
      if (vector === null) {
        const skeletonText = this.redactAndProject(node);
        // Only embed a non-empty (non-degraded) skeleton, and only while budget allows (AC6).
        if (skeletonText.length > 0 && this.budget.canCall()) {
          const result = await this.embeddings.embed({ skeletonText, cacheKey: signature });
          embeddingCallCount += 1;
          // Record usage after EVERY attempt — degraded calls count (T3).
          this.budget.recordUsage(result.promptTokens);
          vector = result.vector;
          // Cache the (possibly empty) vector so re-encounters reuse it (no re-embed).
          await this.cache.set(signature, vector);
        }
      }

      buckets.push(this.toBucket(signature, vector, labelByState));
    }

    const refinement: RefinementResult = this.refiner.refine(buckets);
    return {
      canonicalMap: refinement.canonicalBySignature,
      classes: refinement.classes,
      deadBandNotes: refinement.deadBandNotes,
      embeddingCallCount,
    };
  }

  // ── Per-bucket helpers ───────────────────────────────────────────────────────

  /**
   * Two-pass redaction BEFORE egress, then normalized-skeleton projection (the embedding input).
   * Mirrors `InferIntent`: structural `redact()` masks secure-entry field VALUES; `redactText()`
   * over the serialized result masks OTP-shaped tokens in OBSERVED label/static text (T1/NFR5).
   */
  private redactAndProject(node: StateNode): string {
    const structurallyRedacted = this.redactor.redact(node.a11ySnapshot as A11ySnapshot);
    const redactedSnapshot: string = this.redactor.redactText(structurallyRedacted);
    return this.projectSkeleton(redactedSnapshot);
  }

  /** Build a `BucketInput`: attach the embedding only when usable, and the label only when set. */
  private toBucket(
    signature: StateIdentity,
    vector: readonly number[] | null,
    labelByState: ReadonlyMap<StateIdentity, string>,
  ): BucketInput {
    const bucket: {
      signature: StateIdentity;
      embedding?: readonly number[];
      semanticLabel?: string;
    } = { signature };
    // Absent / empty vector ⇒ a11y-only (the refiner's cosine gate yields null ⇒ no merge).
    if (vector !== null && vector.length > 0) bucket.embedding = vector;
    const label = labelByState.get(signature);
    if (label !== undefined) bucket.semanticLabel = label;
    return bucket;
  }

  /**
   * Confident labels keyed by outcome state identity: only `ScreenIntent.source === "llm"` purposes
   * are passed (degraded/a11y are not — the conservative direction). Empty when labels are disabled
   * or no intent is supplied.
   */
  private buildLabelMap(intent?: IntentModel): ReadonlyMap<StateIdentity, string> {
    const map = new Map<StateIdentity, string>();
    if (!this.config.labelsFromIntent || intent === undefined) return map;
    for (const screen of intent.screens) {
      if (screen.source === "llm" && screen.purpose.length > 0) {
        map.set(screen.stateId, screen.purpose);
      }
    }
    return map;
  }
}
