/**
 * Annotation derivation — fills the #87 annotation-slot seam (ADR-0009 §4) for #88.
 *
 * Pure `(WorkflowMap, StateGraph, limits) → ReadonlyMap<workflowId, WorkflowAnnotations>`:
 *   - hidden-path badge when `Workflow.isHiddenPath === true` — emitted into BOTH the
 *     index (TOC row echo) and detail (workflow header) slots;
 *   - one convergence callout per `duplicateGroups` membership, injected into EVERY
 *     converging workflow (identical content; only the "(this workflow)" marker moves).
 *     Canonical route pinned first, remaining routes in the domain's sorted order, each
 *     labelled `Canonical route` / `Hidden route` / `Alternate route`.
 *
 * Both signals may co-fire on one workflow and are never deduplicated (design spec §5.2):
 * the badge answers "is this one path non-obvious", the callout answers "how does it
 * relate to the other paths reaching the same place".
 *
 * Determinism (NFR3): groups iterated in `duplicateGroups` array order (first-seen
 * preserved); route order = canonical + the pre-sorted `workflowIds`. Absent (pre-#59
 * map) or `[]` `duplicateGroups` ⇒ empty annotations, output identical to #87's.
 *
 * Security: route names are length-capped here and entity-encoded in the partial
 * (T7/M88.1); anchors derive exclusively via `safeAnchorId("wf-" + id)` — the raw
 * Workflow.id / group ids are NEVER spliced into `id=`/`href=` (M88.2).
 */
import type { DuplicatePathGroup, StateGraph, Workflow, WorkflowMap } from "@flowscout/domain";
import type { SafeHtml } from "./html.js";
import { safeAnchorId } from "./html.js";
import { renderHiddenBadgeDetail, renderHiddenBadgeIndex } from "./sections/badge.js";
import {
  renderConvergenceCallout,
  type ConvergenceRouteRole,
  type ConvergenceRouteView,
} from "./sections/convergence.js";

/** Fallback label for unresolvable screens/outcomes (NFR4; exact copy — design spec §9). */
export const UNKNOWN_SCREEN_LABEL = "Unknown screen";

/**
 * The annotation slots #87's sections render: index badges (TOC rows), detail badges
 * (workflow header) and callouts (between header and steps), all SafeHtml.
 */
export interface WorkflowAnnotations {
  readonly indexBadges: readonly SafeHtml[];
  readonly detailBadges: readonly SafeHtml[];
  readonly callouts: readonly SafeHtml[];
}

/** Shared empty slots — the #87 baseline and the no-annotation fallback. */
export const EMPTY_ANNOTATIONS: WorkflowAnnotations = Object.freeze({
  indexBadges: [],
  detailBadges: [],
  callouts: [],
});

/** Structural subset of viewmodel's ViewLimits (kept local — no import cycle). */
export interface AnnotationLimits {
  readonly maxStringLength: number;
}

const TRUNCATION_SUFFIX = "…";

/** T6 cap (truncate-THEN-encode — encoding happens later at the html boundary). */
function cap(raw: string, limits: AnnotationLimits): string {
  if (raw.length <= limits.maxStringLength) {
    return raw;
  }
  return raw.slice(0, limits.maxStringLength) + TRUNCATION_SUFFIX;
}

function routeRole(group: DuplicatePathGroup, workflowId: string): ConvergenceRouteRole {
  if (workflowId === group.canonicalWorkflowId) {
    return "canonical";
  }
  return group.hiddenWorkflowIds.includes(workflowId) ? "hidden" : "alternate";
}

/** Canonical route pinned first, then the remaining pre-sorted workflowIds (spec §5.2). */
function orderedRouteIds(group: DuplicatePathGroup): readonly string[] {
  return [
    group.canonicalWorkflowId,
    ...group.workflowIds.filter((id) => id !== group.canonicalWorkflowId),
  ];
}

function buildRoutes(
  group: DuplicatePathGroup,
  currentWorkflowId: string,
  nameById: ReadonlyMap<string, string>,
  limits: AnnotationLimits,
): ConvergenceRouteView[] {
  return orderedRouteIds(group).map((workflowId) => ({
    anchorId: safeAnchorId(`wf-${workflowId}`),
    // Sparse-data fallback (NFR4): a route referencing a workflow missing from the map
    // still renders — as inert, capped text — rather than crashing.
    name: nameById.get(workflowId) ?? cap(workflowId, limits),
    role: routeRole(group, workflowId),
    isCurrent: workflowId === currentWorkflowId,
  }));
}

function resolveOutcomeLabel(
  group: DuplicatePathGroup,
  stateGraph: StateGraph,
  limits: AnnotationLimits,
): string {
  const node = stateGraph.nodes.get(group.outcomeIdentity);
  return node ? cap(node.label, limits) : UNKNOWN_SCREEN_LABEL;
}

function deriveCallouts(
  workflowMap: WorkflowMap,
  stateGraph: StateGraph,
  nameById: ReadonlyMap<string, string>,
  limits: AnnotationLimits,
): ReadonlyMap<string, readonly SafeHtml[]> {
  const calloutsById = new Map<string, SafeHtml[]>();
  for (const group of workflowMap.duplicateGroups ?? []) {
    const outcomeLabel = resolveOutcomeLabel(group, stateGraph, limits);
    for (const memberId of group.workflowIds) {
      const callout = renderConvergenceCallout({
        pathCount: group.workflowIds.length,
        outcomeLabel,
        routes: buildRoutes(group, memberId, nameById, limits),
      });
      const existing = calloutsById.get(memberId) ?? [];
      existing.push(callout);
      calloutsById.set(memberId, existing);
    }
  }
  return calloutsById;
}

function toAnnotations(
  workflow: Workflow,
  callouts: readonly SafeHtml[] | undefined,
): WorkflowAnnotations {
  if (!workflow.isHiddenPath && (callouts === undefined || callouts.length === 0)) {
    return EMPTY_ANNOTATIONS;
  }
  return Object.freeze({
    indexBadges: workflow.isHiddenPath ? [renderHiddenBadgeIndex()] : [],
    detailBadges: workflow.isHiddenPath ? [renderHiddenBadgeDetail()] : [],
    callouts: callouts ?? [],
  });
}

/**
 * The real #88 derivation behind the ADR-0009 §4 seam. Pure — no I/O, no clock.
 * `duplicateGroups` absent (pre-#59 map) or `[]` and no hidden workflows ⇒ every slot
 * empty (AC 4: output identical to the #87 baseline).
 */
export function deriveAnnotations(
  workflowMap: WorkflowMap,
  stateGraph: StateGraph,
  limits: AnnotationLimits,
): ReadonlyMap<string, WorkflowAnnotations> {
  const nameById = new Map(
    workflowMap.workflows.map((workflow) => [workflow.id, cap(workflow.name, limits)]),
  );
  const calloutsById = deriveCallouts(workflowMap, stateGraph, nameById, limits);
  return new Map(
    workflowMap.workflows.map((workflow) => [
      workflow.id,
      toAnnotations(workflow, calloutsById.get(workflow.id)),
    ]),
  );
}
