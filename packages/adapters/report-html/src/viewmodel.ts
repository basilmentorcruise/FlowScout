/**
 * Pure view-model derivation from (Report, WorkflowMap, StateGraph) — no I/O, no clock.
 *
 * Deterministic ordering rules (NFR3, design spec §2.2):
 *   - feature groups appear in FIRST-SEEN order of `workflowMap.workflows`;
 *     the "Ungrouped" catch-all (absent or literal "Ungrouped" featureGroup) is always last.
 *   - workflows within a group are sorted by `id` (e4-plan.md #87);
 *   - steps are ordered by `stepIndex`.
 *
 * T6 (M87.6): every untrusted display string is capped (truncate-THEN-encode — encoding
 * happens later at the `html` interpolation boundary, so a cap here can never split an
 * entity). The cap is config-driven via `ViewLimits.maxStringLength`.
 */
import type { Report, StateGraph, Workflow, WorkflowMap } from "@flowscout/domain";
import { safeAnchorId } from "./html.js";
import {
  deriveAnnotations,
  EMPTY_ANNOTATIONS,
  UNKNOWN_SCREEN_LABEL,
  type WorkflowAnnotations,
} from "./annotations.js";

// The annotation seam (ADR-0009 §4) is owned by annotations.ts since #88; the type and
// the shared fallback label are re-exported here for the section/view consumers.
export { UNKNOWN_SCREEN_LABEL } from "./annotations.js";
export type { WorkflowAnnotations } from "./annotations.js";

/** Catch-all group label (design spec §2.2 — absent and "Ungrouped" merge here). */
export const UNGROUPED_LABEL = "Ungrouped";

/** Screenshots default open when a workflow has ≤ this many steps (design spec §4). */
export const SCREENSHOT_OPEN_MAX_STEPS = 6;

/** TOC groups become collapsible `<details>` above this entry count (design spec §2.2). */
export const TOC_COLLAPSIBLE_MIN_ENTRIES = 15;

/** Visual clamp threshold — CSS ellipsis + title attr above this length (design spec §4). */
export const CLAMP_THRESHOLD_CHARS = 140;

/**
 * T6 safety cap on any single rendered string (config-driven; DoS guard, not the visual
 * 140-char clamp which is CSS-only). Node/step COUNTS are not capped here: they are
 * bounded upstream by the crawl budget (documented accepted-risk, threat model T6).
 */
export const DEFAULT_MAX_STRING_LENGTH = 4000;

const TRUNCATION_SUFFIX = "…";
const PERCENT = 100;

export interface ViewLimits {
  readonly maxStringLength: number;
}

export interface StepActionView {
  readonly type: string;
  readonly payload: string;
}

export interface StepView {
  readonly index: number;
  readonly displayNumber: number;
  readonly screenLabel: string;
  readonly description: string;
  /** null for the terminal step (edge === null) — no action row is rendered. */
  readonly action: StepActionView | null;
  /** Raw untrusted screenshotUri — resolved to a safe src by the renderer, never emitted. */
  readonly screenshotUri: string | null;
}

export interface WorkflowView {
  readonly id: string;
  readonly anchorId: string;
  readonly name: string;
  readonly description: string;
  readonly featureGroup: string;
  readonly steps: readonly StepView[];
  readonly screenshotsOpen: boolean;
  readonly annotations: WorkflowAnnotations;
}

export interface FeatureGroupView {
  readonly name: string;
  readonly workflows: readonly WorkflowView[];
  readonly collapsible: boolean;
}

export interface HeaderView {
  readonly appId: string;
  /** null ⇒ neutral placeholder copy (absent or "Unknown" purpose). */
  readonly purpose: string | null;
  /** Whole-number percentage, or null when no confidence applies. */
  readonly confidencePct: number | null;
  readonly runId: string;
  readonly appVersion: string;
  readonly generatedAt: string;
  readonly runStatus: Report["metadata"]["runStatus"];
  readonly totalStates: number;
  readonly totalWorkflows: number;
}

export interface ReportView {
  readonly header: HeaderView;
  readonly groups: readonly FeatureGroupView[];
  readonly runId: string;
}

function truncate(raw: string, limits: ViewLimits): string {
  if (raw.length <= limits.maxStringLength) {
    return raw;
  }
  return raw.slice(0, limits.maxStringLength) + TRUNCATION_SUFFIX;
}

function toStepViews(workflow: Workflow, graph: StateGraph, limits: ViewLimits): StepView[] {
  return [...workflow.steps]
    .sort((a, b) => a.stepIndex - b.stepIndex)
    .map((step) => {
      const node = graph.nodes.get(step.stateId);
      return {
        index: step.stepIndex,
        displayNumber: step.stepIndex + 1,
        screenLabel: node ? truncate(node.label, limits) : UNKNOWN_SCREEN_LABEL,
        description: truncate(step.description, limits),
        action: step.edge
          ? {
              type: truncate(step.edge.actionType, limits),
              payload: truncate(step.edge.actionPayload, limits),
            }
          : null,
        screenshotUri: node?.screenshotUri ?? null,
      };
    });
}

function resolveGroupLabel(workflow: Workflow): string {
  const group = workflow.featureGroup;
  return group === undefined || group === UNGROUPED_LABEL ? UNGROUPED_LABEL : group;
}

/** FR3 grouping: first-seen group order, catch-all last, workflows sorted by id. */
export function groupByFeature(
  workflows: readonly Workflow[],
  limits: ViewLimits,
  graph: StateGraph,
  annotations: ReadonlyMap<string, WorkflowAnnotations>,
): FeatureGroupView[] {
  const buckets = new Map<string, WorkflowView[]>();
  for (const workflow of workflows) {
    const label = resolveGroupLabel(workflow);
    const bucket = buckets.get(label) ?? [];
    bucket.push({
      id: workflow.id,
      anchorId: safeAnchorId(`wf-${workflow.id}`),
      name: truncate(workflow.name, limits),
      description: truncate(workflow.description, limits),
      featureGroup: truncate(label, limits),
      steps: toStepViews(workflow, graph, limits),
      screenshotsOpen: workflow.steps.length <= SCREENSHOT_OPEN_MAX_STEPS,
      annotations: annotations.get(workflow.id) ?? EMPTY_ANNOTATIONS,
    });
    buckets.set(label, bucket);
  }
  const labels = [...buckets.keys()].filter((label) => label !== UNGROUPED_LABEL);
  if (buckets.has(UNGROUPED_LABEL)) {
    labels.push(UNGROUPED_LABEL);
  }
  return labels.map((label) => {
    const grouped = [...(buckets.get(label) ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    return {
      name: truncate(label, limits),
      workflows: grouped,
      collapsible: grouped.length > TOC_COLLAPSIBLE_MIN_ENTRIES,
    };
  });
}

function toHeaderView(report: Report, workflowMap: WorkflowMap, limits: ViewLimits): HeaderView {
  const rawPurpose = workflowMap.appPurpose;
  const hasPurpose = rawPurpose !== undefined && rawPurpose !== "Unknown";
  const confidence = workflowMap.appPurposeConfidence;
  return {
    appId: truncate(report.metadata.appId, limits),
    purpose: hasPurpose ? truncate(rawPurpose, limits) : null,
    confidencePct:
      hasPurpose && typeof confidence === "number" ? Math.round(confidence * PERCENT) : null,
    runId: truncate(report.metadata.runId, limits),
    appVersion: truncate(report.metadata.appVersion, limits),
    generatedAt: report.metadata.generatedAt,
    runStatus: report.metadata.runStatus,
    totalStates: report.totalStates,
    totalWorkflows: report.totalWorkflows,
  };
}

/** Pure assembly of the render-ready view-model. */
export function buildReportView(
  report: Report,
  workflowMap: WorkflowMap,
  stateGraph: StateGraph,
  limits: ViewLimits = { maxStringLength: DEFAULT_MAX_STRING_LENGTH },
): ReportView {
  const annotations = deriveAnnotations(workflowMap, stateGraph, limits);
  return {
    header: toHeaderView(report, workflowMap, limits),
    groups: groupByFeature(workflowMap.workflows, limits, stateGraph, annotations),
    runId: truncate(report.metadata.runId, limits),
  };
}
