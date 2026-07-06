/**
 * ReportCodec — pure, deterministic Report ⇄ payload serialization (ADR-0008 §5).
 *
 * Fixed key order (byte-stable); OPTIONAL WorkflowMap fields (#56/#59:
 * `featureGroup`, `appPurpose`, `appPurposeConfidence`, `duplicateGroups`) are
 * emitted only when present and rebuilt only when present, preserving the
 * absent-vs-null distinction the domain model documents.
 *
 * Decode rebuilds via allow-listed fields ONLY (M83.3/T5). Workflow strings are
 * untrusted-origin (app + LLM content) and round-trip byte-equal — raw and inert,
 * no escaping on write (M83.8/T7: E4 output-encodes on render, not the store).
 */
import type {
  ConfidenceScore,
  DuplicatePathGroup,
  Report,
  ReportMetadata,
  RunStatus,
  StateEdge,
  Workflow,
  WorkflowMap,
  WorkflowStep,
} from "@flowscout/domain";
import { makeConfidenceScore, makeStateIdentity } from "@flowscout/domain";
import {
  asArray,
  asRecord,
  parsePayload,
  PayloadCodecError,
  readBoolean,
  readEnum,
  readNumber,
  readString,
  readStringArray,
} from "./primitives.js";

const RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "running",
  "completed",
  "partial",
  "blocked-on-2fa",
  "error",
]);
const ACTION_TYPES: ReadonlySet<StateEdge["actionType"]> = new Set<StateEdge["actionType"]>([
  "tap",
  "swipe",
  "typeText",
  "scroll",
  "gesture",
  "navigate",
]);

// ---------------------------------------------------------------------------
// encode — fixed key order everywhere; optional keys only when present
// ---------------------------------------------------------------------------

function encodeEdge(edge: StateEdge | null): Record<string, unknown> | null {
  if (edge === null) return null;
  return {
    id: edge.id,
    fromId: edge.fromId,
    toId: edge.toId,
    actionType: edge.actionType,
    actionPayload: edge.actionPayload,
    observedAt: edge.observedAt,
  };
}

function encodeStep(step: WorkflowStep): Record<string, unknown> {
  return {
    stepIndex: step.stepIndex,
    stateId: step.stateId,
    edge: encodeEdge(step.edge),
    description: step.description,
  };
}

function encodeWorkflow(workflow: Workflow): Record<string, unknown> {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    steps: workflow.steps.map(encodeStep),
    isHiddenPath: workflow.isHiddenPath,
    inferenceConfidence: workflow.inferenceConfidence,
    ...(workflow.featureGroup !== undefined ? { featureGroup: workflow.featureGroup } : {}),
  };
}

function encodeDuplicateGroup(group: DuplicatePathGroup): Record<string, unknown> {
  return {
    outcomeIdentity: group.outcomeIdentity,
    workflowIds: group.workflowIds,
    canonicalWorkflowId: group.canonicalWorkflowId,
    hiddenWorkflowIds: group.hiddenWorkflowIds,
  };
}

function encodeWorkflowMap(map: WorkflowMap): Record<string, unknown> {
  return {
    runId: map.runId,
    workflows: map.workflows.map(encodeWorkflow),
    finalisedAt: map.finalisedAt,
    ...(map.appPurpose !== undefined ? { appPurpose: map.appPurpose } : {}),
    ...(map.appPurposeConfidence !== undefined
      ? { appPurposeConfidence: map.appPurposeConfidence }
      : {}),
    ...(map.duplicateGroups !== undefined
      ? { duplicateGroups: map.duplicateGroups.map(encodeDuplicateGroup) }
      : {}),
  };
}

/** Encode a Report to its deterministic JSON payload. */
export function encodeReport(report: Report): string {
  const metadata = report.metadata;
  return JSON.stringify({
    metadata: {
      reportId: metadata.reportId,
      runId: metadata.runId,
      appId: metadata.appId,
      appVersion: metadata.appVersion,
      generatedAt: metadata.generatedAt,
      runStatus: metadata.runStatus,
      artifactUri: metadata.artifactUri,
      schemaVersion: metadata.schemaVersion,
    },
    workflowMap: encodeWorkflowMap(report.workflowMap),
    totalStates: report.totalStates,
    totalWorkflows: report.totalWorkflows,
    duplicatePathCount: report.duplicatePathCount,
  });
}

// ---------------------------------------------------------------------------
// decode — allow-listed rebuild (M83.3); optional keys only when present
// ---------------------------------------------------------------------------

function decodeEdge(value: unknown): StateEdge | null {
  if (value === null) return null;
  const record = asRecord(value, "step edge");
  return {
    id: readString(record, "id"),
    fromId: makeStateIdentity(readString(record, "fromId")),
    toId: makeStateIdentity(readString(record, "toId")),
    actionType: readEnum(record, "actionType", ACTION_TYPES),
    actionPayload: readString(record, "actionPayload"),
    observedAt: readString(record, "observedAt"),
  };
}

function decodeStep(value: unknown): WorkflowStep {
  const record = asRecord(value, "workflow step");
  return {
    stepIndex: readNumber(record, "stepIndex"),
    stateId: makeStateIdentity(readString(record, "stateId")),
    edge: decodeEdge(record["edge"]),
    description: readString(record, "description"),
  };
}

function decodeConfidence(value: unknown, context: string): ConfidenceScore | null {
  if (value === null) return null;
  if (typeof value !== "number") {
    throw new PayloadCodecError(`${context} must be a number or null`);
  }
  return makeConfidenceScore(value);
}

function decodeWorkflow(value: unknown): Workflow {
  const record = asRecord(value, "workflow");
  return {
    id: readString(record, "id"),
    name: readString(record, "name"),
    description: readString(record, "description"),
    steps: asArray(record["steps"], "workflow steps").map(decodeStep),
    isHiddenPath: readBoolean(record, "isHiddenPath"),
    inferenceConfidence: decodeConfidence(record["inferenceConfidence"], "inferenceConfidence"),
    ...(Object.hasOwn(record, "featureGroup")
      ? { featureGroup: readString(record, "featureGroup") }
      : {}),
  };
}

function decodeDuplicateGroup(value: unknown): DuplicatePathGroup {
  const record = asRecord(value, "duplicate group");
  return {
    outcomeIdentity: makeStateIdentity(readString(record, "outcomeIdentity")),
    workflowIds: readStringArray(record, "workflowIds"),
    canonicalWorkflowId: readString(record, "canonicalWorkflowId"),
    hiddenWorkflowIds: readStringArray(record, "hiddenWorkflowIds"),
  };
}

function decodeWorkflowMap(value: unknown): WorkflowMap {
  const record = asRecord(value, "workflowMap");
  return {
    runId: readString(record, "runId"),
    workflows: asArray(record["workflows"], "workflows").map(decodeWorkflow),
    finalisedAt: readString(record, "finalisedAt"),
    ...(Object.hasOwn(record, "appPurpose")
      ? { appPurpose: readString(record, "appPurpose") }
      : {}),
    ...(Object.hasOwn(record, "appPurposeConfidence")
      ? {
          appPurposeConfidence: decodeConfidence(
            record["appPurposeConfidence"],
            "appPurposeConfidence",
          ),
        }
      : {}),
    ...(Object.hasOwn(record, "duplicateGroups")
      ? {
          duplicateGroups: asArray(record["duplicateGroups"], "duplicateGroups").map(
            decodeDuplicateGroup,
          ),
        }
      : {}),
  };
}

function decodeMetadata(value: unknown): ReportMetadata {
  const record = asRecord(value, "metadata");
  return {
    reportId: readString(record, "reportId"),
    runId: readString(record, "runId"),
    appId: readString(record, "appId"),
    appVersion: readString(record, "appVersion"),
    generatedAt: readString(record, "generatedAt"),
    runStatus: readEnum(record, "runStatus", RUN_STATUSES),
    artifactUri: readString(record, "artifactUri"),
    schemaVersion: readString(record, "schemaVersion"),
  };
}

/** Decode a payload back into a deep-equal Report (allow-listed fields only — M83.3). */
export function decodeReport(payload: string): Report {
  const record = parsePayload(payload);
  return {
    metadata: decodeMetadata(record["metadata"]),
    workflowMap: decodeWorkflowMap(record["workflowMap"]),
    totalStates: readNumber(record, "totalStates"),
    totalWorkflows: readNumber(record, "totalWorkflows"),
    duplicatePathCount: readNumber(record, "duplicatePathCount"),
  };
}
