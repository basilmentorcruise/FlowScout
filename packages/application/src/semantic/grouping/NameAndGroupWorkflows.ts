/**
 * NameAndGroupWorkflows — the E3.3 use-case / orchestrator (#56, ADR-0007 §3.2 / §3.6).
 *
 * Names + feature-groups the FROZEN extractor `Workflow[]` (#54) and infers a one-line app
 * purpose for the map, by overlaying the consumed `IntentModel` (#55). Two-tier, rule-first:
 *
 *   1. REDACT FIRST (NFR5 / T1 / T2): every consumed string (intent purposes/control intents,
 *      workflow + step descriptions) passes through the injected `CredentialRedactor` BEFORE it
 *      enters a cache key, a prompt, or an output label.
 *   2. TIER 1 (always, deterministic, no LLM): `RuleNameStrategy` derives name/description +
 *      provisional `featureGroup` from the redacted signal.
 *   3. TIER 2 (optional, rare): IF refinement is enabled AND (tier-1 is weak OR refine-all) AND
 *      the budget allows, `LlmNamingRefiner` refines over the injected `LlmPort` — cached and
 *      budget-counted. Otherwise tier-1 stands.
 *   4. APP PURPOSE: `AppPurposeInferer` runs once for the whole map (rule + one optional call).
 *
 * AUTHORITATIVE-SET INVARIANT (M56.3 / T6): this orchestrator iterates the INPUT workflow set
 * and only ever RELABELS each input workflow (its `id`/`steps`/`isHiddenPath` are copied
 * through unchanged). It never adds, drops, merges, splits, or reorders a workflow — the LLM
 * can only fill `name`/`description`/`featureGroup`. Tested directly (cardinality/ids/order/steps).
 *
 * Resilience (NFR6): a single workflow never crashes the run — tier-2 failures degrade to
 * tier-1; exactly one well-formed result is always produced, even for an empty/single-workflow
 * map. SOLID/DI: every collaborator is constructor-injected. Depends only on domain ports +
 * application collaborators — no adapter/SDK import (NFR1). Root wiring is #59.
 */
import type { ConfidenceScore, IntentModel, StateIdentity, Workflow } from "@flowscout/domain";
import type { CredentialRedactor } from "../../crawl/redaction/CredentialRedactor.js";
import type { RuleNameStrategy, RedactedScreenSignal } from "./RuleNameStrategy.js";
import type { LlmNamingRefiner } from "./LlmNamingRefiner.js";
import type { AppPurposeInferer } from "./AppPurposeInferer.js";
import type { GroupingConfig } from "./GroupingConfig.js";
import { UNGROUPED } from "./GroupingConfig.js";
import { groupingCacheKey } from "./GroupingCacheKey.js";

/** The result of naming/grouping: relabeled workflows + the per-map app purpose. */
export interface NameAndGroupResult {
  readonly workflows: readonly Workflow[];
  readonly appPurpose: string;
  readonly appPurposeConfidence: ConfidenceScore | null;
}

export class NameAndGroupWorkflows {
  constructor(
    private readonly redactor: CredentialRedactor,
    private readonly ruleStrategy: RuleNameStrategy,
    private readonly refiner: LlmNamingRefiner,
    private readonly purposeInferer: AppPurposeInferer,
    private readonly config: GroupingConfig,
  ) {}

  /**
   * Names + groups every workflow and infers the app purpose.
   *
   * @param workflows  the frozen extractor workflows (read-only; never mutated).
   * @param intent     the consumed intent overlay (already redacted by #55).
   */
  async execute(
    workflows: readonly Workflow[],
    intent: IntentModel,
  ): Promise<NameAndGroupResult> {
    // 1. Build the redacted screen-signal lookup once (defense-in-depth re-redaction).
    const signals = this.buildSignalMap(intent);

    // 2. Relabel each workflow IN INPUT ORDER (authoritative-set invariant).
    const labeled: Workflow[] = [];
    for (const workflow of workflows) {
      labeled.push(await this.labelWorkflow(workflow, signals));
    }

    // 3. One per-map app-purpose pass over the redacted group/purpose signal.
    const purposeSignal = this.buildPurposeSignal(labeled, signals);
    const purpose = await this.purposeInferer.infer(labeled, purposeSignal);

    return {
      workflows: labeled,
      appPurpose: purpose.appPurpose,
      appPurposeConfidence: purpose.appPurposeConfidence,
    };
  }

  // ── Per-workflow pipeline ──────────────────────────────────────────────────

  private async labelWorkflow(
    workflow: Workflow,
    signals: ReadonlyMap<StateIdentity, RedactedScreenSignal>,
  ): Promise<Workflow> {
    // Redact the workflow's own free-text BEFORE it can enter a label/key/prompt.
    const redactedWorkflow = this.redactWorkflowText(workflow);

    // Tier 1 — deterministic, always runs, never throws.
    const tier1 = this.ruleStrategy.derive(redactedWorkflow, signals);

    let labeling = tier1.labeling;
    if (this.shouldRefine(tier1.weak)) {
      const skeleton = this.buildSkeleton(redactedWorkflow, signals);
      const cacheKey = groupingCacheKey(skeleton);
      try {
        labeling = await this.refiner.refine(workflow.id, tier1.labeling, cacheKey, skeleton);
      } catch {
        labeling = tier1.labeling; // defensive: refiner already degrades internally.
      }
    }

    // Apply labels onto the ORIGINAL workflow — id/steps/isHiddenPath copied through unchanged.
    return {
      ...workflow,
      name: labeling.name,
      description: labeling.description,
      featureGroup: labeling.featureGroup,
      inferenceConfidence: labeling.confidence,
    };
  }

  /** True iff tier-2 should be attempted for this workflow. */
  private shouldRefine(weak: boolean): boolean {
    if (!this.config.refinementEnabled) return false;
    if (!this.config.refineOnlyWeak) return true;
    return weak;
  }

  // ── Signal building (all redacted) ─────────────────────────────────────────

  private buildSignalMap(intent: IntentModel): Map<StateIdentity, RedactedScreenSignal> {
    const map = new Map<StateIdentity, RedactedScreenSignal>();
    for (const screen of intent.screens) {
      map.set(screen.stateId, {
        purpose: this.redactor.redactText(screen.purpose),
        controlIntents: screen.controls.map((c) => this.redactor.redactText(c.intent)),
      });
    }
    return map;
  }

  /** A redacted copy of the workflow's free-text fields (id/steps identity preserved). */
  private redactWorkflowText(workflow: Workflow): Workflow {
    return {
      ...workflow,
      name: this.redactor.redactText(workflow.name),
      description: this.redactor.redactText(workflow.description),
      steps: workflow.steps.map((s) => ({
        ...s,
        description: this.redactor.redactText(s.description),
      })),
    };
  }

  /** The redacted workflow+intent skeleton sent to the LLM / hashed into the cache key. */
  private buildSkeleton(
    workflow: Workflow,
    signals: ReadonlyMap<StateIdentity, RedactedScreenSignal>,
  ): string {
    const lines: string[] = [`Workflow: ${workflow.name}`, `Steps (${String(workflow.steps.length)}):`];
    for (const step of workflow.steps) {
      lines.push(`  - ${step.description}`);
      const signal = signals.get(step.stateId);
      if (signal) {
        if (signal.purpose.trim().length > 0) lines.push(`    screen: ${signal.purpose}`);
        for (const intent of signal.controlIntents) {
          if (intent.trim().length > 0) lines.push(`    control: ${intent}`);
        }
      }
    }
    return lines.join("\n");
  }

  /** The redacted group/purpose signal for the whole map (drives the app-purpose pass). */
  private buildPurposeSignal(
    workflows: readonly Workflow[],
    signals: ReadonlyMap<StateIdentity, RedactedScreenSignal>,
  ): string {
    const groups = new Set<string>();
    for (const wf of workflows) {
      if (wf.featureGroup && wf.featureGroup !== UNGROUPED) groups.add(wf.featureGroup);
    }
    const purposes = new Set<string>();
    for (const signal of signals.values()) {
      const p = signal.purpose.trim();
      if (p.length > 0) purposes.add(p);
    }
    if (groups.size === 0 && purposes.size === 0) return "";
    return [
      `Feature groups: ${[...groups].join(", ")}`,
      `Screen purposes: ${[...purposes].join("; ")}`,
    ].join("\n");
  }
}
