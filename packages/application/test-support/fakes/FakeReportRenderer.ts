/**
 * FakeReportRenderer — in-memory fake for ReportRendererPort.
 */
import type { ReportRendererPort, Report, RenderOptions, RenderResult } from "@flowscout/domain";
import type { WorkflowMap } from "@flowscout/domain";
import type { StateGraph } from "@flowscout/domain";

export class FakeReportRenderer implements ReportRendererPort {
  readonly renders: Array<{ report: Report; workflowMap: WorkflowMap; stateGraph: StateGraph }> =
    [];

  async render(
    report: Report,
    workflowMap: WorkflowMap,
    stateGraph: StateGraph,
    options: RenderOptions,
  ): Promise<RenderResult> {
    this.renders.push({ report, workflowMap, stateGraph });
    return {
      artifactUri: `file://${options.outputDir}/report-${report.metadata.reportId}.html`,
      generatedAt: new Date().toISOString(),
      sizeBytes: 1024,
    };
  }
}
