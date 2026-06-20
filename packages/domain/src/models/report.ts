/**
 * Report domain model.
 * A Report is the rendered artifact — a grouped, browsable HTML document.
 */
import type { WorkflowMap } from "./workflow.js";

/** The run status when the report was generated. */
export type RunStatus =
  | "completed"
  | "partial" // step cap / budget hit
  | "blocked-on-2fa"
  | "error";

/** Metadata for a report artifact. */
export interface ReportMetadata {
  readonly reportId: string;
  readonly runId: string;
  readonly appId: string;
  readonly appVersion: string;
  readonly generatedAt: string; // ISO-8601
  readonly runStatus: RunStatus;
  /** URI to the rendered HTML artifact (local file or object-store URI). */
  readonly artifactUri: string;
  /** FlowScout schema version at time of generation. */
  readonly schemaVersion: string;
}

/** Domain model for a complete report (metadata + workflow data). */
export interface Report {
  readonly metadata: ReportMetadata;
  readonly workflowMap: WorkflowMap;
  readonly totalStates: number;
  readonly totalWorkflows: number;
  readonly duplicatePathCount: number;
}
