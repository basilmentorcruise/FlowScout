/**
 * assembleReport — pure `Report` factory (#84 / E7.2, ADR-0008 §3). No I/O.
 *
 * E7 persists report DATA; E4 later renders the HTML and fills the real
 * `artifactUri` through the same idempotent `ReportRepository.save` upsert
 * (OQ3 — additive, no schema change). Until then the documented sentinel is
 * `REPORT_UNRENDERED_URI` ("" = not yet rendered).
 *
 * Security (e7 threat model, T7/M84.3): the `WorkflowMap` and every label string
 * pass through RAW and inert — no escaping, no transform, no interpretation.
 * They are untrusted-origin (app content + LLM output); E4's renderer MUST
 * context-encode them (enforced in E4's gate — store raw, encode at render).
 */
import type { Report, Run, RunStatus, StateGraph, WorkflowMap } from "@flowscout/domain";

/** Documented sentinel: report data persisted, HTML not yet rendered (E4 fills it — OQ3). */
export const REPORT_UNRENDERED_URI = "";

/** Deterministic report-id prefix: one report per run ⇒ idempotent upsert on re-assembly. */
export const REPORT_ID_PREFIX = "report-";

/** Inputs to the pure factory — the caller (orchestrator) owns clock + terminal status. */
export interface AssembleReportInput {
  /** The run record created at crawl start (id/appId/appVersion/schemaVersion provenance). */
  readonly run: Run;
  /** The finalized graph, or null when none was persisted (counts degrade to 0). */
  readonly graph: StateGraph | null;
  /** The finalized map from BuildWorkflowMap — stored verbatim (T7: raw + inert). */
  readonly workflowMap: WorkflowMap;
  /** The terminal outcome derived from the crawl:finished event. */
  readonly runStatus: RunStatus;
  /** ISO-8601 generation timestamp (injected — the factory stays pure). */
  readonly generatedAt: string;
}

/** Assemble the persistable `Report` (metadata + WorkflowMap + the three counts — ADR-0008 §3). */
export function assembleReport(input: AssembleReportInput): Report {
  const { run, graph, workflowMap, runStatus, generatedAt } = input;
  return {
    metadata: {
      reportId: `${REPORT_ID_PREFIX}${run.id}`,
      runId: run.id,
      appId: run.appId,
      appVersion: run.appVersion,
      generatedAt,
      runStatus,
      artifactUri: REPORT_UNRENDERED_URI,
      schemaVersion: run.schemaVersion,
    },
    workflowMap,
    totalStates: graph?.nodes.size ?? 0,
    totalWorkflows: workflowMap.workflows.length,
    duplicatePathCount: graph?.duplicatePathNodeIds.size ?? 0,
  };
}
