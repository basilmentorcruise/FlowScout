/**
 * ReportRendererPort — generates the browsable HTML report artifact.
 * Implemented in adapters/report-html.
 * The application layer calls this with a Report + WorkflowMap and receives an artifact URI.
 */
import type { Report } from "../models/report.js";
import type { WorkflowMap } from "../models/workflow.js";
import type { StateGraph } from "../models/state-graph.js";

/** Options controlling report rendering. */
export interface RenderOptions {
  /** Directory to write the HTML report file. */
  readonly outputDir: string;
  /** Optional: custom title for the report. */
  readonly title?: string;
  /** Whether to embed screenshots inline (base64) vs. reference by URI. */
  readonly embedScreenshots: boolean;
}

/** Result of a render operation. */
export interface RenderResult {
  /** File URI or object-store URI for the rendered HTML artifact. */
  readonly artifactUri: string;
  /** ISO-8601 timestamp of generation. */
  readonly generatedAt: string;
  /** Size of the rendered artifact in bytes. */
  readonly sizeBytes: number;
}

export interface ReportRendererPort {
  render(
    report: Report,
    workflowMap: WorkflowMap,
    stateGraph: StateGraph,
    options: RenderOptions,
  ): Promise<RenderResult>;
}
