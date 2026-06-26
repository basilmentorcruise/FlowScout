/**
 * InferIntent — the E3.2 use-case / orchestrator (#55, ADR-0006 §3.2 / §3.6).
 *
 * Produces an `IntentModel` (the consumer contract for #56) by overlaying inferred intent on a
 * FINALIZED state-graph. Two-tier, a11y-first:
 *
 *   1. REDACT FIRST (NFR5 / T7): every node's a11y snapshot and every edge payload pass through
 *      the injected `CredentialRedactor` BEFORE any sink (cache key, prompt, stored intent).
 *   2. TIER 1 (always, deterministic, no LLM): `A11yIntentDeriver` derives purpose + controls.
 *   3. TIER 2 (optional, rare): IF refinement is enabled AND tier-1 is weak (config threshold)
 *      AND the budget allows, `LlmIntentRefiner` refines over the injected `LlmPort` — cached and
 *      budget-counted. Otherwise tier-1 stands.
 *
 * Resilience: a single node never crashes the run — tier-2 failures degrade to tier-1; exactly
 * one well-formed `IntentModel` is always produced (NFR6), even for an empty/single-node graph.
 *
 * SOLID/DI: every collaborator is constructor-injected behind an interface/class. Depends only on
 * domain ports + application collaborators — no adapter/SDK import (NFR1). Root wiring is #59.
 */
import type {
  StateGraph,
  StateNode,
  StateEdge,
  IntentModel,
  ScreenIntent,
  A11ySnapshot,
} from "@flowscout/domain";
import type { CredentialRedactor } from "../../crawl/redaction/CredentialRedactor.js";
import type { A11yIntentDeriver } from "./A11yIntentDeriver.js";
import type { LlmIntentRefiner } from "./LlmIntentRefiner.js";
import { intentCacheKey } from "./IntentCacheKey.js";

/** Configuration for the two-tier inference (no magic literals; injected). */
export interface InferIntentConfig {
  /** Master switch for tier-2. When false, ONLY tier-1 runs (zero LLM calls). */
  readonly refinementEnabled: boolean;
  /**
   * When true, tier-2 is attempted only for screens whose tier-1 result is WEAK
   * (degraded source OR any degraded control) — keeps the LLM rare. When false, tier-2 is
   * attempted for every screen (still budget- and cache-gated).
   */
  readonly refineOnlyWeak: boolean;
}

/** Conservative default: a11y-first, refine only weak screens. */
export function defaultInferIntentConfig(): InferIntentConfig {
  return { refinementEnabled: true, refineOnlyWeak: true };
}

export class InferIntent {
  constructor(
    private readonly redactor: CredentialRedactor,
    private readonly deriver: A11yIntentDeriver,
    private readonly refiner: LlmIntentRefiner,
    private readonly config: InferIntentConfig,
  ) {}

  /**
   * Infers intent for every node in the graph.
   *
   * @param graph  a finalized state-graph (read-only; never mutated).
   * @returns      a well-formed `IntentModel` overlay keyed by StateIdentity + edge id.
   */
  async execute(graph: StateGraph): Promise<IntentModel> {
    // Index outgoing edges per node once (O(E)).
    const edgesByNode = this.indexOutgoingEdges(graph.edges);

    const screens: ScreenIntent[] = [];
    for (const node of graph.nodes.values()) {
      screens.push(await this.inferScreen(node, edgesByNode.get(node.id) ?? []));
    }

    return { runId: graph.runId, screens };
  }

  // ── Per-screen pipeline ────────────────────────────────────────────────────

  private async inferScreen(
    node: StateNode,
    rawEdges: readonly StateEdge[],
  ): Promise<ScreenIntent> {
    // 1. Redact the snapshot and every edge payload BEFORE any downstream use (NFR5 / T7).
    //    `StateNode.a11ySnapshot` is a serialized snapshot string; the redactor's input port is
    //    the branded `A11ySnapshot` (same value, just the crawl-time brand) — cast at this seam.
    //
    //    Two-pass, both via the SAME `CredentialRedactor` (no second redactor):
    //      (a) structural `redact()` masks secure-entry field VALUES,
    //      (b) `redactText()` over the serialized result masks OTP-shaped tokens that appear in
    //          OBSERVED label/static text (e.g. "Your code is 482913") — these are not in a
    //          secure `value` field, so (a) alone would let them through to the prompt/cache.
    const structurallyRedacted = this.redactor.redact(node.a11ySnapshot as A11ySnapshot);
    const redactedSnapshot: string = this.redactor.redactText(structurallyRedacted);
    const redactedEdges = rawEdges.map((e) => ({
      ...e,
      actionPayload: this.redactor.redactText(e.actionPayload),
    }));

    // 2. Tier 1 — deterministic, always runs, never throws.
    const tier1 = this.deriver.derive(node, redactedSnapshot, redactedEdges);

    // 3. Tier 2 — optional, gated by enable flag + weakness + budget (inside the refiner).
    if (!this.shouldRefine(tier1)) {
      return tier1;
    }

    const cacheKey = intentCacheKey(redactedSnapshot);
    try {
      return await this.refiner.refine(tier1, cacheKey, redactedSnapshot);
    } catch {
      // Defensive: the refiner already degrades internally; this guarantees no torn result.
      return tier1;
    }
  }

  /** True iff tier-2 should be attempted for this tier-1 result. */
  private shouldRefine(tier1: ScreenIntent): boolean {
    if (!this.config.refinementEnabled) return false;
    if (!this.config.refineOnlyWeak) return true;
    return tier1.source === "degraded" || tier1.controls.some((c) => c.source === "degraded");
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private indexOutgoingEdges(edges: readonly StateEdge[]): Map<StateNode["id"], StateEdge[]> {
    const map = new Map<StateNode["id"], StateEdge[]>();
    for (const edge of edges) {
      const list = map.get(edge.fromId);
      if (list) list.push(edge);
      else map.set(edge.fromId, [edge]);
    }
    return map;
  }
}
